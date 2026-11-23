/**
 * @fileoverview Hardened Vercel Serverless Proxy for Google Gemini 2.5 Flash.
 * Strictly server-side GEMINI_API_KEY only, null-safe metric serialization
 * (never turns missing pollutants into 0), and bounded sliding-window IP rate limiter.
 */

import { clampNumber, sanitizeText } from '../js/core/security.js';

const GEMINI_MODEL = 'gemini-2.5-flash';
const MAX_BODY_BYTES = 18_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 15;
const MAX_TRACKED_IPS = 2_000;
const UPSTREAM_TIMEOUT_MS = 12_000;

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
    'You are VayuShield, an evidence-based Urban Air Quality and Atmospheric Dispersion Assistant.',
    'CRITICAL SCIENTIFIC & AI RULES:',
    '1. Never invent pollutant readings, station names, citations, or medical diagnoses.',
    '2. Never treat "Unavailable" fields as zero. If a metric is missing, state explicitly that it is unavailable.',
    '3. Clearly distinguish modeled atmospheric estimates, deterministic calculations, assumptions, and recommendations.',
    '4. Never pretend a modeled forecast is a direct ground monitoring-station observation.',
    '5. Never recommend ozone-generating ionizers; distinguish True HEPA particle capture from gas/VOC removal.',
    '',
    'Return ONLY a valid JSON object matching this exact schema:',
    '{',
    '  "headline": "concise 1-line grounded summary",',
    '  "factsUsed": ["2-3 exact numbers/timestamps from the provided telemetry context with source type"],',
    '  "recommendations": ["3 specific, practical steps tailored to the household profile and dispersion trend"],',
    '  "indoorGuidance": "specific room filtration / ventilation advice grounded in provided room CADR and filter efficiency",',
    '  "assumptionsAndLimits": ["1-2 explicit uncertainties or missing inputs (e.g., model grid resolution, missing NH3/Pb, no medical diagnosis)"]',
    '}',
    '',
    'Validated Telemetry & Profile Context:',
    `- Location: ${ctx.city} (${ctx.lat}, ${ctx.lon}) · Local Valid Timestamp: ${ctx.measurementTime}`,
    `- Data Source Type: ${ctx.sourceType}`,
    `- CPCB-Derived AQI Estimate: ${fmtMetric(ctx.aqi)} (${ctx.aqiBand}), Primary Pollutant: ${ctx.primaryPollutant}`,
    `- 24h Rolling PM2.5: ${fmtMetric(ctx.pm25, 'ug/m3')} | Prior 24h (Yesterday) PM2.5: ${fmtMetric(ctx.yesterdayPm25, 'ug/m3')}`,
    `- 24h PM10: ${fmtMetric(ctx.pm10, 'ug/m3')}, 24h NO2: ${fmtMetric(ctx.no2, 'ug/m3')}, 24h SO2: ${fmtMetric(ctx.so2, 'ug/m3')}`,
    `- 8h O3: ${fmtMetric(ctx.o3, 'ug/m3')}, 8h CO: ${fmtMetric(ctx.coMg, 'mg/m3')}, NH3 & Pb: Unavailable in CAMS model`,
    `- Dispersion Trend: ${ctx.trend}, Best Practical Daytime Window: ${ctx.bestWindow}`,
    `- Household Profile: ${ctx.householdProfile}, Commute: ${ctx.commuteMode} (${ctx.dailyCommuteKm} km/day)`,
    `- Room Volume/CADR Target: ${ctx.roomSqFt} sq.ft (Recommended CADR: ${fmtMetric(ctx.recommendedCadr, 'm3/h')}), Cooking: ${ctx.cookingFuel}`,
    `- User Question: ${ctx.question}`
  ].join('\n');
}

export function parseStructuredCoachResponse(rawText) {
  const cleaned = String(rawText || '').replace(/```json/gi, '').replace(/```/g, '').trim();
  const parsed = JSON.parse(cleaned);

  const toCleanList = (arr, limit = 4) => (
    Array.isArray(arr)
      ? arr.map((item) => sanitizeText(item, 240)).filter(Boolean).slice(0, limit)
      : []
  );

  return {
    headline: sanitizeText(parsed.headline, 180) || 'Grounded Air Quality Guidance',
    factsUsed: toCleanList(parsed.factsUsed, 3),
    recommendations: toCleanList(parsed.recommendations, 4),
    indoorGuidance: sanitizeText(parsed.indoorGuidance, 340),
    assumptionsAndLimits: toCleanList(parsed.assumptionsAndLimits, 3)
  };
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
      return res.status(429).json({ error: 'Rate limit exceeded. Please wait 60 seconds.' });
    }

    const body = req.body && typeof req.body === 'object' ? req.body : null;
    if (!body) {
      return res.status(400).json({ error: 'Invalid JSON request body.' });
    }
    if (JSON.stringify(body).length > MAX_BODY_BYTES) {
      return res.status(413).json({ error: 'Payload exceeds maximum allowed size.' });
    }

    const apiKey = typeof env.GEMINI_API_KEY === 'string' ? env.GEMINI_API_KEY.trim() : '';
    if (!apiKey) {
      return res.status(503).json({
        error: 'Server-side GEMINI_API_KEY is not configured.',
        fallbackRecommended: true
      });
    }

    const ctx = {
      question: sanitizeText(body.question, 360) || 'What precautions should my household take based on current air quality?',
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
      trend: sanitizeText(body.trend, 24) || 'unavailable',
      bestWindow: sanitizeText(body.bestWindow, 32) || 'Unavailable',
      householdProfile: sanitizeText(body.householdProfile, 32) || 'multi-gen',
      commuteMode: sanitizeText(body.commuteMode, 32) || 'two-wheeler',
      dailyCommuteKm: Math.round(clampNumber(body.dailyCommuteKm, 0, 120, 18)),
      roomSqFt: Math.round(clampNumber(body.roomSqFt, 60, 2000, 220)),
      recommendedCadr: parseNullableMetric(body.recommendedCadr, 100, 2000, 0),
      cookingFuel: sanitizeText(body.cookingFuel, 32) || 'lpg-no-chimney'
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

    try {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
      const upstream = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{ parts: [{ text: buildScientificPrompt(ctx) }] }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 780,
            responseMimeType: 'application/json'
          }
        })
      });

      if (!upstream.ok) {
        return res.status(502).json({
          error: 'Upstream Gemini service unavailable.',
          fallbackRecommended: true
        });
      }

      const data = await upstream.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const structured = parseStructuredCoachResponse(text);

      return res.status(200).json({
        engine: 'Google Gemini 2.5 Flash (Server-Side Proxy)',
        ...structured
      });
    } catch {
      return res.status(504).json({
        error: 'Gemini request timed out or returned invalid JSON.',
        fallbackRecommended: true
      });
    } finally {
      clearTimeout(timeoutId);
    }
  };
}

export default createGeminiHandler();