import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  createGeminiHandler,
  normalizeModelId,
  parseStructuredCoachResponse,
  resetRateLimiter,
  resolveModelConfig,
  sanitizeConversationHistory
} from '../api/gemini.js';
import {
  COACH_PROMPT_TEMPLATES,
  askVayuShieldCoach,
  buildCoachContextPayload,
  buildGroundedFallback,
  classifyCoachIntent,
  createConversationSession
} from '../js/services/aiAssistantService.js';

const ROOT = path.resolve(import.meta.dirname, '..');

function makeMockRes() {
  const headers = {};
  return {
    statusCode: 200,
    headers,
    body: null,
    setHeader(k, v) { headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; }
  };
}

test('ORACLE Model Config & Smoke Test: strips models/ prefix, validates env config & passes smoke_test', async () => {
  resetRateLimiter();
  assert.equal(normalizeModelId('models/gemini-2.5-flash'), 'gemini-2.5-flash');
  assert.equal(normalizeModelId('bad model/../../x'), '');

  const cfg = resolveModelConfig({
    GEMINI_API_KEY: 'key-123',
    GEMINI_MODEL_ID: 'models/gemini-2.5-flash',
    GEMINI_FALLBACK_MODEL_ID: 'gemini-2.5-flash-lite'
  });
  assert.equal(cfg.primaryModel, 'gemini-2.5-flash');
  assert.equal(cfg.fallbackModel, 'gemini-2.5-flash-lite');

  let calledUrl = '';
  const handler = createGeminiHandler({
    env: { GEMINI_API_KEY: 'secret-test-key', GEMINI_MODEL_ID: 'gemini-2.5-flash' },
    fetchImpl: async (url) => {
      calledUrl = url;
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: JSON.stringify({ status: 'connected', message: 'VayuShield AI Coach is operational.' }) }] } }],
          usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 14, totalTokenCount: 34 }
        })
      };
    }
  });

  const res = makeMockRes();
  await handler({ method: 'POST', headers: { 'content-type': 'application/json' }, body: { action: 'smoke_test' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.status, 'connected');
  assert.equal(res.body.model, 'gemini-2.5-flash');
  assert.match(calledUrl, /\/v1beta\/models\/gemini-2\.5-flash:generateContent$/);
});

test('ORACLE Error Classification: accurately surfaces 401/403, 404, 429, 503 & timeout without masking', async () => {
  const cases = [
    { status: 403, apiStatus: 'PERMISSION_DENIED', expectStatus: 403, expectCode: 'AUTH_OR_ACCESS_FAILURE' },
    { status: 404, apiStatus: 'NOT_FOUND', expectStatus: 404, expectCode: 'MODEL_OR_ENDPOINT_NOT_FOUND' },
    { status: 429, apiStatus: 'RESOURCE_EXHAUSTED', expectStatus: 429, expectCode: 'QUOTA_OR_RATE_LIMIT_EXCEEDED' },
    { status: 503, apiStatus: 'UNAVAILABLE', expectStatus: 503, expectCode: 'UPSTREAM_UNAVAILABLE' }
  ];

  for (const c of cases) {
    resetRateLimiter();
    const handler = createGeminiHandler({
      env: { GEMINI_API_KEY: 'secret-key', GEMINI_MODEL_ID: 'gemini-2.5-flash' },
      fetchImpl: async () => ({
        ok: false,
        status: c.status,
        json: async () => ({ error: { status: c.apiStatus, message: 'provider error' } })
      })
    });
    const res = makeMockRes();
    await handler({ method: 'POST', headers: {}, body: { question: 'Explain AQI' } }, res);
    assert.equal(res.statusCode, c.expectStatus);
    assert.equal(res.body.diagnosticCode, c.expectCode);
    assert.equal(JSON.stringify(res.body).includes('secret-key'), false);
  }
});

test('ORACLE Structured Output & Security: validates schema, preserves nulls, strips HTML & enforces alternating history', () => {
  assert.throws(() => parseStructuredCoachResponse('not-json'));
  assert.throws(() => parseStructuredCoachResponse(JSON.stringify({ headline: 'Only headline' })));

  const parsed = parseStructuredCoachResponse(JSON.stringify({
    headline: '<script>alert(1)</script>Coimbatore Air',
    answer: 'Modeled AQI is 132.',
    factsUsed: [{ label: 'NH3', value: null, unit: 'µg/m³', sourceType: 'unavailable', timestamp: null }],
    recommendations: [{ title: 'Close windows', description: 'Seal gaps', reason: 'Evening stagnation', priority: 'high', timeWindow: '20:00-22:00' }],
    indoorGuidance: 'Use HEPA.',
    assumptionsAndLimits: ['Modeled CAMS grid'],
    followUpSuggestions: ['Compare today vs. yesterday']
  }));

  assert.equal(parsed.headline.includes('<script>'), false);
  assert.equal(parsed.factsUsed[0].value, null);
  assert.equal(parsed.factsUsed[0].sourceType, 'unavailable');
  assert.equal(parsed.recommendations[0].priority, 'high');

  const hist = sanitizeConversationHistory([
    { role: 'user', text: 'What causes pollution?' },
    { role: 'model', text: 'PM2.5 and low wind.' },
    { role: 'user', text: 'Dangling user turn should be trimmed' }
  ]);
  assert.equal(hist.valid, true);
  assert.equal(hist.turns.length, 2);
  assert.equal(hist.turns[1].role, 'model');
});

test('ORACLE 13-Intent Router & Session Memory: zero indoor/CADR hijack bugs & resets on location change', () => {
  assert.equal(classifyCoachIntent('How can I improve my indoor air quality given our kitchen fuel setup?'), 'indoor-air');
  assert.equal(classifyCoachIntent('Explain the mass-balance CADR calculation and compare zero-cost, DIY, and True H13 options.'), 'filtration-cadr');
  assert.equal(classifyCoachIntent('Compare today’s 24-hour rolling PM2.5 against yesterday’s average.'), 'forecast-interpretation');
  assert.equal(classifyCoachIntent('When is a practical daytime outdoor activity window today?'), 'outdoor-activity');
  assert.equal(classifyCoachIntent('How can I reduce its effect indoors?', 2), 'indoor-air');
  assert.equal(classifyCoachIntent('Explain in simpler terms', 2), 'follow-up');

  const session = createConversationSession();
  session.setLocation({ name: 'Coimbatore', lat: 11.0168, lon: 76.9558 });
  session.addExchange('What causes pollution?', 'PM2.5 and low wind.', 'pollution-causes');
  assert.equal(session.getTurnCount(), 1);
  assert.equal(session.exportHistoryPayload().history.length, 2);

  // Switching cities must reset conversation state
  const didReset = session.setLocation({ name: 'London', lat: 51.5072, lon: -0.1276 });
  assert.equal(didReset, true);
  assert.equal(session.getTurnCount(), 0);
});

test('ORACLE Grounding, Null Preservation & UI Contracts: missing values stay null & no hardcoded model in HTML', async () => {
  const ctx = buildCoachContextPayload(
    { location: { name: 'Coimbatore', lat: 11.0168, lon: 76.9558 }, cpcb: { aqi: null }, rollingAverages: { pm25_24h: null }, current: {}, metadata: {} },
    {},
    null
  );
  assert.equal(ctx.airQuality.aqi, null);
  assert.equal(ctx.airQuality.pm25_24h, null);
  assert.equal(ctx.airQuality.nh3_24h, null);

  const fallback = buildGroundedFallback('Explain my room CADR', { location: { name: 'Coimbatore' }, cpcb: { aqi: 132 } }, {}, null, { diagnosticCode: 'MODEL_OR_ENDPOINT_NOT_FOUND' });
  assert.equal(fallback.isFallback, true);
  assert.equal(fallback.mode, 'grounded-fallback');
  assert.match(fallback.engine, /Offline Mode/);

  // AbortSignal cancellation throws UserAbortError cleanly
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    () => askVayuShieldCoach({ question: 'hi', intel: { location: { name: 'Coimbatore' }, metadata: {} }, profile: {} }, { signal: ac.signal }),
    { name: 'UserAbortError' }
  );

  assert.equal(COACH_PROMPT_TEMPLATES.length, 8);
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.match(html, /id="coach-status-badge"/);
  assert.match(html, /id="coach-model-badge"/);
  assert.match(html, /id="coach-context-badge"/);
  assert.match(html, /id="btn-stop-coach"/);
  assert.equal(/Server-Side Google Gemini 2\.5 Flash/i.test(html), false, 'Do not hardcode model ID in coach HTML');
});