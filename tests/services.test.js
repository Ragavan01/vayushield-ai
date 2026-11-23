import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildScientificPrompt,
  checkRateLimit,
  createGeminiHandler,
  parseStructuredCoachResponse,
  resetRateLimiter
} from '../api/gemini.js';

import {
  clearAirQualityCache,
  fetchAirIntelligence,
  geocodeCity
} from '../js/services/airQualityService.js';

import {
  askVayuShieldCoach,
  buildGroundedFallback
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

function buildMockHourlyPayloads() {
  const times = Array.from({ length: 48 }, (_, i) => {
    const day = i < 24 ? '22' : '23';
    const hr = String(i % 24).padStart(2, '0');
    return `2026-11-${day}T${hr}:00`;
  });

  const aq = {
    timezone: 'Asia/Kolkata',
    current: {
      time: '2026-11-23T00:00',
      pm2_5: 110,
      pm10: 175,
      nitrogen_dioxide: 42,
      sulphur_dioxide: 14,
      carbon_monoxide: 1400,
      ozone: 32,
      us_aqi: 179
    },
    hourly: {
      time: times,
      pm2_5: times.map((_, i) => (i >= 36 && i <= 39 ? 58 : 115)),
      pm10: times.map(() => 180),
      nitrogen_dioxide: times.map(() => 40),
      sulphur_dioxide: times.map(() => 15),
      carbon_monoxide: times.map(() => 1200),
      ozone: times.map(() => 35)
    }
  };

  const wx = {
    current: { temperature_2m: 15.2, relative_humidity_2m: 68, wind_speed_10m: 5.4, wind_direction_10m: 290 },
    hourly: {
      time: times,
      temperature_2m: times.map(() => 16),
      relative_humidity_2m: times.map(() => 64),
      wind_speed_10m: times.map((_, i) => (i >= 36 && i <= 39 ? 14 : 4)),
      wind_direction_10m: times.map(() => 300),
      boundary_layer_height: times.map((_, i) => (i >= 36 && i <= 39 ? 1200 : 220))
    }
  };

  return { aq, wx };
}

test('Gemini Proxy: enforces POST, rate limits, payload caps, and ignores client-supplied API keys', async () => {
  resetRateLimiter();
  const getRes = createMockRes();
  await createGeminiHandler({ env: { GEMINI_API_KEY: 'AQ.ValidServerKey12345678901234567890' } })(
    { method: 'GET', headers: {} },
    getRes
  );
  assert.equal(getRes.state.statusCode, 405);

  // Even if an attacker sends x-gemini-api-key header, server must reject when env.GEMINI_API_KEY is unset
  const noEnvRes = createMockRes();
  await createGeminiHandler({ env: {} })(
    {
      method: 'POST',
      headers: { 'x-forwarded-for': '10.0.1.1', 'x-gemini-api-key': 'AIzaAttackerSuppliedKey1234567890' },
      body: { question: 'Test' }
    },
    noEnvRes
  );
  assert.equal(noEnvRes.state.statusCode, 503);

  // Payload cap
  const bigRes = createMockRes();
  await createGeminiHandler({ env: { GEMINI_API_KEY: 'AQ.ValidServerKey12345678901234567890' } })(
    { method: 'POST', headers: { 'x-forwarded-for': '10.0.1.2' }, body: { question: 'a'.repeat(20000) } },
    bigRes
  );
  assert.equal(bigRes.state.statusCode, 413);

  // Sliding-window IP rate limit (15 req/min)
  const now = 1_700_000_000_000;
  for (let i = 0; i < 15; i++) assert.equal(checkRateLimit('10.10.0.9', now + i), true);
  assert.equal(checkRateLimit('10.10.0.9', now + 100), false);
  assert.equal(checkRateLimit('10.10.0.9', now + 61_000), true);
});

test('Gemini Proxy: returns sanitized structured facts, recommendations, indoor guidance & uncertainties', async () => {
  resetRateLimiter();
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      candidates: [{
        content: {
          parts: [{
            text: JSON.stringify({
              headline: 'Plan <script>alert(1)</script>',
              factsUsed: ['Delhi NCR CPCB-derived AQI 280 (modeled CAMS 40 km)'],
              recommendations: ['Wear N95 on commute', 'Limit open windows during stagnation'],
              indoorGuidance: 'Run True HEPA >= 260 m3/h; ionizer OFF.',
              assumptionsAndLimits: ['40 km grid averages may differ from street monitors.']
            })
          }]
        }
      }]
    })
  });

  const res = createMockRes();
  await createGeminiHandler({
    fetchImpl: mockFetch,
    env: { GEMINI_API_KEY: 'AQ.ValidServerKey12345678901234567890' }
  })(
    { method: 'POST', headers: { 'x-forwarded-for': '10.0.1.9' }, body: { question: 'Advice?', city: 'Delhi NCR', aqi: 280 } },
    res
  );

  assert.equal(res.state.statusCode, 200);
  assert.equal(res.state.body.headline.includes('<script>'), false);
  assert.equal(res.state.body.factsUsed.length, 1);
  assert.equal(res.state.body.assumptionsAndLimits.length, 1);

  const prompt = buildScientificPrompt({ city: 'Pune', aqi: 140, sourceType: 'Modeled' });
  assert.match(prompt, /Never invent pollutant readings/i);

  const parsed = parseStructuredCoachResponse('```json\n{"headline":"Clean","recommendations":["Step 1"]}\n```');
  assert.equal(parsed.headline, 'Clean');
});

test('Air Quality Service: dual-API ingestion computes 24h CPCB estimate, dispersion forecast, caching & explicit errors', async () => {
  clearAirQualityCache();
  const { aq, wx } = buildMockHourlyPayloads();
  let aqCalls = 0;

  const mockFetch = async (url) => {
    if (url.includes('air-quality-api')) {
      aqCalls += 1;
      return { ok: true, json: async () => aq };
    }
    return { ok: true, json: async () => wx };
  };

  const loc = { name: 'Pune', region: 'India', lat: 18.5204, lon: 73.8567 };
  // Concurrent deduplication + caching
  const [first, dup] = await Promise.all([
    fetchAirIntelligence(loc, { pastDays: 1, fetchImpl: mockFetch, now: () => 1000 }),
    fetchAirIntelligence(loc, { pastDays: 1, fetchImpl: mockFetch, now: () => 1000 })
  ]);
  assert.equal(aqCalls, 1);
  assert.equal(first.cpcb.isOfficialCpcb, false);
  assert.equal(first.cpcb.primaryPollutant.pollutant, 'pm25');
  assert.equal(first.dispersion.available, true);
  assert.ok(first.history.points.length >= 24);
  assert.equal(dup.location.name, 'Pune');

  const cached = await fetchAirIntelligence(loc, { pastDays: 1, fetchImpl: mockFetch, now: () => 5000 });
  assert.equal(aqCalls, 1);
  assert.equal(cached.metadata.fromCache, true);

  // Upstream failure must throw explicitly rather than silently substituting Delhi NCR
  clearAirQualityCache();
  await assert.rejects(
    () => fetchAirIntelligence(loc, { fetchImpl: async () => ({ ok: false, status: 500 }) }),
    /unavailable/i
  );
});

test('Geocoding & AI Coach Client: resolves presets and falls back transparently with limitations', async () => {
  const city = await geocodeCity('Coimbatore');
  assert.equal(city?.name, 'Coimbatore');

  const fallback = buildGroundedFallback(
    'When should I ventilate?',
    {
      location: { name: 'Coimbatore', lat: 11.0168, lon: 76.9558 },
      cpcb: { aqi: 72, band: { label: 'Satisfactory' }, primaryPollutant: { name: 'PM2.5', concentration: 43, unit: 'µg/m³', averaging: '24-hr' } },
      rollingAverages: { pm25_24h: 43 },
      metadata: { sourceType: 'Modeled Atmospheric Grid', gridResolution: '~40 km' },
      dispersion: { available: true, trend: 'steady', bestOutdoorWindow: { label: '13:00–15:00', avgPm25: 36 } }
    },
    { commuteMode: 'two-wheeler', dailyCommuteKm: 12 },
    null
  );
  assert.equal(fallback.isFallback, true);
  assert.ok(fallback.assumptionsAndLimits.length >= 2);

  const clientOut = await askVayuShieldCoach(
    {
      question: 'How is the air?',
      intel: {
        location: { name: 'Coimbatore', lat: 11.0168, lon: 76.9558 },
        cpcb: { aqi: 72, band: { label: 'Satisfactory' }, primaryPollutant: { name: 'PM2.5' } },
        rollingAverages: { pm25_24h: 43, pm10_24h: 65, no2_24h: 14 },
        current: { pm25: 43, pm10: 65, no2: 14 },
        metadata: { sourceType: 'Modeled', gridResolution: '~40 km' },
        dispersion: { available: false, trend: 'unavailable' }
      },
      profile: {},
      indoorEval: null
    },
    { fetchImpl: async () => ({ ok: false, status: 503 }) }
  );
  assert.equal(clientOut.isFallback, true);
});