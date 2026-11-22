import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildGroundedPrompt,
  checkRateLimit,
  createGeminiHandler,
  parseSafeGeminiJson,
  resetRateLimiter
} from '../api/gemini.js';

import {
  clearAirQualityCache,
  fetchLiveAirQuality,
  geocodeCity
} from '../js/services/airQualityService.js';

import {
  askAirQualityAssistant,
  buildFallbackCoachingResponse
} from '../js/services/aiAssistantService.js';

function createMockRes() {
  const state = { statusCode: 200, headers: {}, body: null };
  return {
    state,
    setHeader(k, v) { state.headers[k] = v; },
    status(code) {
      state.statusCode = code;
      return {
        json(payload) {
          state.body = payload;
          return state;
        }
      };
    }
  };
}

test('Serverless Gemini Proxy: rejects non-POST requests with 405', async () => {
  resetRateLimiter();
  const handler = createGeminiHandler({ env: { GEMINI_API_KEY: 'AIzaSyDemoValidFormatKey1234567890' } });
  const res = createMockRes();
  await handler({ method: 'GET', headers: {} }, res);
  assert.equal(res.state.statusCode, 405);
});

test('Serverless Gemini Proxy: returns 503 with fallbackRecommended when API key is missing', async () => {
  resetRateLimiter();
  const handler = createGeminiHandler({ env: {} });
  const res = createMockRes();
  await handler({ method: 'POST', headers: { 'x-forwarded-for': '10.0.0.1' }, body: { question: 'Test' } }, res);
  assert.equal(res.state.statusCode, 503);
  assert.equal(res.state.body.fallbackRecommended, true);
});

test('Serverless Gemini Proxy: returns 413 for oversized payloads', async () => {
  resetRateLimiter();
  const handler = createGeminiHandler({ env: { GEMINI_API_KEY: 'AIzaSyDemoValidFormatKey1234567890' } });
  const res = createMockRes();
  await handler(
    { method: 'POST', headers: { 'x-forwarded-for': '10.0.0.2' }, body: { question: 'x'.repeat(20000) } },
    res
  );
  assert.equal(res.state.statusCode, 413);
});

test('Serverless Gemini Proxy: enforces sliding-window IP rate limit', () => {
  resetRateLimiter();
  const now = 1_700_000_000_000;
  for (let i = 0; i < 18; i++) {
    assert.equal(checkRateLimit('192.168.1.9', now + i), true);
  }
  assert.equal(checkRateLimit('192.168.1.9', now + 500), false);
  // Window expiry restores quota
  assert.equal(checkRateLimit('192.168.1.9', now + 61_000), true);
});

test('Serverless Gemini Proxy: proxies valid request and sanitizes Gemini JSON output', async () => {
  resetRateLimiter();
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      candidates: [{
        content: {
          parts: [{
            text: JSON.stringify({
              headline: 'Clean Air Plan <script>bad</script>',
              immediateSteps: ['Seal balcony door', 'Shift walk to 2 PM'],
              indoorHack: 'Use damp mopping',
              sustainableSwap: 'Carpool 3 days/week',
              directImpact: 'Cuts PM2.5 exposure by 42%',
              communityTip: 'Compost winter leaves'
            })
          }]
        }
      }]
    })
  });

  const handler = createGeminiHandler({
    fetchImpl: mockFetch,
    env: { GEMINI_API_KEY: 'AIzaSyDemoValidFormatKey1234567890' }
  });
  const res = createMockRes();
  await handler(
    {
      method: 'POST',
      headers: { 'x-forwarded-for': '10.0.0.5' },
      body: { question: 'Protect kids from smog', city: 'Delhi NCR', aqi: 340, pm25: 190 }
    },
    res
  );

  assert.equal(res.state.statusCode, 200);
  assert.equal(res.state.body.headline.includes('<script>'), false);
  assert.equal(res.state.body.immediateSteps.length, 2);
});

test('Prompt Builder & Safe Parser handle markdown-wrapped Gemini JSON', () => {
  const prompt = buildGroundedPrompt({
    question: 'Bedroom hack?',
    city: 'Lucknow',
    aqi: 280,
    pm25: 140,
    commuteMode: 'two-wheeler',
    householdProfile: 'kids',
    budgetTier: 'diy-budget',
    cookingFuel: 'lpg-no-chimney',
    roomSqFt: 220
  });
  assert.match(prompt, /Lucknow/);
  assert.match(prompt, /280/);

  const parsed = parseSafeGeminiJson('```json\n{"headline":"Hi","immediateSteps":["Step 1"]}\n```');
  assert.equal(parsed.headline, 'Hi');
  assert.deepEqual(parsed.immediateSteps, ['Step 1']);
});

test('Air Quality Service: fetches live telemetry, caches repeated lookups, and falls back offline', async () => {
  clearAirQualityCache();
  let callCount = 0;
  const mockFetch = async () => {
    callCount += 1;
    return {
      ok: true,
      json: async () => ({
        current: { pm2_5: 135, pm10: 210, nitrogen_dioxide: 48, us_aqi: 205 }
      })
    };
  };

  const loc = { name: 'Delhi NCR', region: 'India', lat: 28.6139, lon: 77.209 };
  const first = await fetchLiveAirQuality(loc, { fetchImpl: mockFetch, now: () => 1000 });
  const second = await fetchLiveAirQuality(loc, { fetchImpl: mockFetch, now: () => 2000 });

  assert.equal(callCount, 1);
  assert.equal(first.fromCache, false);
  assert.equal(second.fromCache, true);
  assert.ok(first.aqi >= 300);

  clearAirQualityCache();
  const offline = await fetchLiveAirQuality(loc, {
    fetchImpl: async () => { throw new Error('Network down'); }
  });
  assert.match(offline.sourceLabel, /Fallback/i);
  assert.ok(offline.aqi > 0);
});

test('Geocoding & AI Assistant Service: resolves city presets and degrades gracefully on proxy failure', async () => {
  const city = await geocodeCity('Bengaluru');
  assert.equal(city?.name, 'Bengaluru');

  const fallbackDirect = buildFallbackCoachingResponse(
    'Best clean bedroom under ₹2,500?',
    { name: 'Delhi NCR', aqi: 340, pm25: 195 },
    { budgetTier: 'diy-budget', roomSqFt: 240 }
  );
  assert.match(fallbackDirect.headline, /2,500/);
  assert.equal(fallbackDirect.immediateSteps.length, 3);

  const clientRes = await askAirQualityAssistant(
    {
      question: 'School commute advice',
      airData: { name: 'Delhi NCR', aqi: 340, pm25: 195 },
      profile: { householdProfile: 'kids' }
    },
    { fetchImpl: async () => ({ ok: false, status: 503 }) }
  );
  assert.match(clientRes.engine, /Fallback/i);
  assert.ok(clientRes.directImpact.includes('PM2.5'));
});