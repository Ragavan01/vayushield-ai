/**
 * @fileoverview Hardened Vercel Serverless Proxy for Google Gemini.
 * - Strictly server-side GEMINI_API_KEY only
 * - Safe JSON body parsing for Vercel Node runtime
 * - Multi-model resilience (gemini-2.5-flash -> gemini-2.0-flash -> gemini-2.5-flash-lite)
 * - Logs sanitized upstream status/reason (never API keys) for Vercel Observability
 */

import { clampNumber, sanitizeText } from '../js/core/security.js';

const GEMINI_ATTEMPTS = Object.freeze([
  Object.freeze({ model: 'gemini-2.5-flash', label: 'Google Gemini 2.5 Flash', disableThinking: true }),
  Object.freeze({ model: 'gemini-2.5-flash', label: 'Google Gemini 2.5 Flash', disableThinking: false }),
  Object.freeze({ model: 'gemini-2.0-flash', label: 'Google Gemini 2.0 Flash', disableThinking: false }),
  Object.freeze({ model: 'gemini-2.5-flash-lite', label: 'Google Gemini 2.5 Flash-Lite', disableThinking: false })
]);

const MAX_BODY_BYTES = 18_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 15;
const MAX_TRACKED_IPS = 2_000;
const UPSTREAM_TIMEOUT_MS = 14_000;

const ipRequestLog = new Map();

export function checkRateLimit(ip, now = Date.now()) {
  const key = sanitizeText(ip || 'unknown', 64) || 'unknown';
  const windowStart = now - RATE_LIMIT_WINDOW_MS;

  if (ipRequestLog.size >= MAX_TRACKED_IPS && !ipRequestLog.has(key)) {
    const oldestKey = ipRequestLog.keys().next().value;
    if (oldestKey) ipRequestLog.delete(oldestKey);
  }

  const recent = (ipRequestLog.get(key) || []).filter((ts) => ts > windowStart);
  if (recent.length >= RATE_LIMIT_MAX_REQUESTS) {
    ipRequestLog.set(key, recent);
    return false;
  }

  recent.push(now);
  ipRequestLog.set(key, recent);
  return true;
}

export function resetRateLimiter() {
  ipRequestLog.clear();
}

export function parseNullableMetric(raw, min, max, decimals = 1) {
  if (raw === null || raw === undefined || raw === '') return null;
  const num = Number(raw);
  if (!Number.isFinite(num) || num < min || num > max) return null;
  return Number(num.toFixed(decimals));
}

function fmtMetric(val, unit = '') {
  if (val === null || val === undefined) return 'Unavailable (missing — do not assume zero)';
  return unit ? `${val} ${unit}` : String(val);
}

export function buildScientificPrompt(ctx) {
  return [
    'You are VayuShield AI, an evidence-based Urban Air Quality and Atmospheric Dispersion Assistant.',
    'STRICT OPERATING RULES:',
    '1. Directly answer the exact User Question below first. If the user says "hi" or greets you, greet them warmly in 1 sentence, summarize the active city AQI status in 1 sentence, and suggest 2 specific environmental questions they can ask.',
    '2. Never repeat generic boilerplate across different questions—tailor every point specifically to what the user asked.',
    '3. Never invent pollutant readings, station names, citations, or medical diagnoses.',
    '4. Never treat "Unavailable" fields as zero. Distinguish modeled grid estimates from direct station measurements.',
    '5. Never recommend ozone-generating ionizers; distinguish True HEPA particle capture from gas/VOC removal.',
    '',
    'Return ONLY a valid JSON object matching this exact schema:',
    '{',
    '  "headline": "short 5-10 word title specific to the user question",',
    '  "directAnswer": "2-4 clear, natural sentences directly answering the user question using exact numbers from the context",',
    '  "recommendations": ["2-3 concise, practical steps directly relevant to the user question"],',
    '  "factsUsed": ["1-2 exact telemetry or physics figures backing this answer, noting modeled vs calculated source"],',
    '  "assumptionsAndLimits": ["1 concise sentence stating key uncertainty or limitation (e.g., ~40 km CAMS grid, not medical advice)"]',
    '}',
    '',
    'Validated Telemetry & Household Context:',
    `- Location: ${ctx.city} (${ctx.lat}, ${ctx.lon}) · Local Valid Timestamp: ${ctx.measurementTime}`,
    `- Data Source Type: ${ctx.sourceType}`,
    `- CPCB-Derived AQI Estimate: ${fmtMetric(ctx.aqi)} (${ctx.aqiBand}), Primary Pollutant: ${ctx.primaryPollutant}`,
    `- 24h Rolling PM2.5: ${fmtMetric(ctx.pm25, 'ug/m3')} | Prior 24h (Yesterday) PM2.5: ${fmtMetric(ctx.yesterdayPm25, 'ug/m3')}`,
    `- 24h PM10: ${fmtMetric(ctx.pm10, 'ug/m3')}, 24h NO2: ${fmtMetric(ctx.no2, 'ug/m3')}, 24h SO2: ${fmtMetric(ctx.so2, 'ug/m3')}`,
    `- 8h O3: ${fmtMetric(ctx.o3, 'ug/m3')}, 8h CO: ${fmtMetric(ctx.coMg, 'mg/m3')}, NH3 & Pb: Unavailable in CAMS model`,
    `- Dispersion & Wind: BLH ${fmtMetric(ctx.blh, 'm')}, Wind ${fmtMetric(ctx.windKmh, 'km/h')}, VC ${fmtMetric(ctx.vc, 'm2/s')}, 6h Trend: ${ctx.trend}`,
    `- Best Practical Daytime Window: ${ctx.bestWindow} (Projected PM2.5: ${fmtMetric(ctx.bestWindowPm25, 'ug/m3')}) | Peak Accumulation Window: ${ctx.peakWindow}`,
    `- Household Profile: ${ctx.householdProfile}, Commute: ${ctx.commuteMode} (${ctx.dailyCommuteKm} km/day), Cooking: ${ctx.cookingFuel}`,
    `- Room Physics: ${ctx.roomSqFt} sq.ft (${fmtMetric(ctx.roomVolumeM3, 'm3')}), Recommended CADR: ${fmtMetric(ctx.recommendedCadr, 'm3/h')}, Unfiltered Indoor PM2.5: ${fmtMetric(ctx.unfilteredIndoorPm25, 'ug/m3')} -> Filtered: ${fmtMetric(ctx.filteredIndoorPm25, 'ug/m3')}`,
    '',
    `User Question: "${ctx.question}"`
  ].join('\n');
}

export function parseStructuredCoachResponse(rawText) {
  const cleaned = String(rawText || '').replace(/```json/gi, '').replace(/```/g, '').trim();
  const parsed = JSON.parse(cleaned);

  const toCleanList = (arr, limit = 3) => (
    Array.isArray(arr)
      ? arr.map((item) => sanitizeText(item, 260)).filter(Boolean).slice(0, limit)
      : []
  );

  const headline = sanitizeText(parsed.headline, 140) || 'Grounded Air Quality Insight';
  const directAnswer = sanitizeText(parsed.directAnswer || parsed.indoorGuidance, 600) || headline;

  return {
    headline,
    directAnswer,
    factsUsed: toCleanList(parsed.factsUsed, 3),
    recommendations: toCleanList(parsed.recommendations, 3),
    indoorGuidance: sanitizeText(parsed.indoorGuidance, 340) || directAnswer,
    assumptionsAndLimits: toCleanList(parsed.assumptionsAndLimits, 2)
  };
}

function parseRequestBody(rawBody) {
  if (!rawBody) return null;
  if (typeof rawBody === 'object') return rawBody;
  if (typeof rawBody === 'string') {
    try {
      const parsed = JSON.parse(rawBody);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function createGeminiHandler(deps = {}) {
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const env = deps.env || process.env;
  const now = deps.now || (() => Date.now());

  return async function handler(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed. Use POST.' });
    }

    const clientIp = String(req.headers?.['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
    if (!checkRateLimit(clientIp, now())) {
      return res.status(429).json({ error: 'Rate limit exceeded. Please wait 60 seconds.', diagnosticCode: 'RATE_LIMITED' });
    }

    const body = parseRequestBody(req.body);
    if (!body) {
      return res.status(400).json({ error: 'Invalid JSON request body.', diagnosticCode: 'BAD_REQUEST' });
    }
    if (JSON.stringify(body).length > MAX_BODY_BYTES) {
      return res.status(413).json({ error: 'Payload exceeds maximum allowed size.', diagnosticCode: 'PAYLOAD_TOO_LARGE' });
    }

    const apiKey = typeof env.GEMINI_API_KEY === 'string' ? env.GEMINI_API_KEY.trim() : '';
    if (!apiKey) {
      return res.status(503).json({
        error: 'Server-side GEMINI_API_KEY is not configured in Vercel Environment Variables.',
        diagnosticCode: 'MISSING_GEMINI_API_KEY',
        fallbackRecommended: true
      });
    }

    const ctx = {
      question: sanitizeText(body.question, 360) || 'Explain my current air quality.',
      city: sanitizeText(body.city, 80) || 'Selected Location',
      lat: Number(clampNumber(body.lat, -90, 90, 0).toFixed(3)),
      lon: Number(clampNumber(body.lon, -180, 180, 0).toFixed(3)),
      measurementTime: sanitizeText(body.measurementTime, 40) || 'Unavailable',
      sourceType: sanitizeText(body.sourceType, 80) || 'Modeled Atmospheric Grid (Open-Meteo/CAMS)',
      aqi: parseNullableMetric(body.aqi, 0, 500, 0),
      aqiBand: sanitizeText(body.aqiBand, 32) || 'Unavailable',
      primaryPollutant: sanitizeText(body.primaryPollutant, 24) || 'Unavailable',
      pm25: parseNullableMetric(body.pm25, 0, 600, 1),
      yesterdayPm25: parseNullableMetric(body.yesterdayPm25, 0, 600, 1),
      pm10: parseNullableMetric(body.pm10, 0, 800, 1),
      no2: parseNullableMetric(body.no2, 0, 500, 1),
      so2: parseNullableMetric(body.so2, 0, 2500, 1),
      o3: parseNullableMetric(body.o3, 0, 1000, 1),
      coMg: parseNullableMetric(body.coMg, 0, 60, 2),
      blh: parseNullableMetric(body.blh, 10, 6000, 0),
      windKmh: parseNullableMetric(body.windKmh, 0, 250, 1),
      vc: parseNullableMetric(body.vc, 0, 200000, 0),
      trend: sanitizeText(body.trend, 24) || 'unavailable',
      bestWindow: sanitizeText(body.bestWindow, 32) || 'Unavailable',
      bestWindowPm25: parseNullableMetric(body.bestWindowPm25, 0, 600, 1),
      peakWindow: sanitizeText(body.peakWindow, 32) || 'Unavailable',
      householdProfile: sanitizeText(body.householdProfile, 32) || 'multi-gen',
      commuteMode: sanitizeText(body.commuteMode, 32) || 'two-wheeler',
      dailyCommuteKm: Math.round(clampNumber(body.dailyCommuteKm, 0, 120, 18)),
      roomSqFt: Math.round(clampNumber(body.roomSqFt, 60, 2000, 220)),
      roomVolumeM3: parseNullableMetric(body.roomVolumeM3, 10, 1000, 1),
      recommendedCadr: parseNullableMetric(body.recommendedCadr, 50, 2000, 0),
      unfilteredIndoorPm25: parseNullableMetric(body.unfilteredIndoorPm25, 0, 600, 1),
      filteredIndoorPm25: parseNullableMetric(body.filteredIndoorPm25, 0, 600, 1),
      cookingFuel: sanitizeText(body.cookingFuel, 32) || 'lpg-no-chimney'
    };

    const promptText = buildScientificPrompt(ctx);
    let lastDiagnostic = 'UPSTREAM_ERROR';

    for (const attempt of GEMINI_ATTEMPTS) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

      try {
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${attempt.model}:generateContent`;
        const generationConfig = {
          temperature: 0.25,
          maxOutputTokens: 1400,
          responseMimeType: 'application/json'
        };
        if (attempt.disableThinking) {
          generationConfig.thinkingConfig = { thinkingBudget: 0 };
        }

        const upstream = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey
          },
          signal: controller.signal,
          body: JSON.stringify({
            contents: [{ parts: [{ text: promptText }] }],
            generationConfig
          })
        });

        if (!upstream.ok) {
          const errPayload = await upstream.json?.().catch(() => null);
          const apiReason = sanitizeText(errPayload?.error?.status || errPayload?.error?.message || '', 80);
          lastDiagnostic = `HTTP_${upstream.status}${apiReason ? `_${apiReason.replace(/[^A-Z0-9_]/gi, '_').slice(0, 24)}` : ''}`;
          console.error(`[VayuShield Gemini Proxy] model=${attempt.model} status=${upstream.status} reason=${apiReason}`);
          // Stop immediately only on invalid/unauthorized key; otherwise try next fallback model/config
          if (upstream.status === 401 || upstream.status === 403 || /API_KEY_INVALID/i.test(apiReason)) {
            lastDiagnostic = 'INVALID_GEMINI_API_KEY';
            break;
          }
          continue;
        }

        const data = await upstream.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const structured = parseStructuredCoachResponse(text);

        return res.status(200).json({
          engine: `${attempt.label} (Server-Side Proxy)`,
          ...structured
        });
      } catch (err) {
        lastDiagnostic = err?.name === 'AbortError' ? 'UPSTREAM_TIMEOUT' : 'RESPONSE_PARSE_ERROR';
        console.error(`[VayuShield Gemini Proxy] model=${attempt.model} exception=${lastDiagnostic}`);
      } finally {
        clearTimeout(timeoutId);
      }
    }

    return res.status(502).json({
      error: `Gemini proxy fallback triggered (${lastDiagnostic}).`,
      diagnosticCode: lastDiagnostic,
      fallbackRecommended: true
    });
  };
}

export default createGeminiHandler();