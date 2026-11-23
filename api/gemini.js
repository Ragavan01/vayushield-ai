/**
 * @fileoverview Hardened Vercel Serverless Proxy for Google Gemini 2.5 Flash.
 * Security & scientific guardrails:
 * - Strictly server-side GEMINI_API_KEY only (never accepts browser-supplied secrets)
 * - Bounded sliding-window IP rate limiter (prevents unbounded Map memory growth)
 * - Structured JSON schema forcing explicit separation of facts, assumptions, recommendations & uncertainties
 */

import { clampNumber, sanitizeText } from '../js/core/security.js';

const GEMINI_MODEL = 'gemini-2.5-flash';
const MAX_BODY_BYTES = 18_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 15;
const MAX_TRACKED_IPS = 2_000;
const UPSTREAM_TIMEOUT_MS = 12_000;

/** @type {Map<string, number[]>} */
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

export function buildScientificPrompt(ctx) {
  return [
    'You are VayuShield, an evidence-based Urban Air Quality and Atmospheric Dispersion Assistant.',
    'STRICT SCIENTIFIC RULES:',
    '1. Never invent pollutant readings, station names, or medical guarantees.',
    '2. Explicitly distinguish between modeled atmospheric estimates provided below, general assumptions, and actionable recommendations.',
    '3. If the provided telemetry is missing a pollutant or vertical radiosonde data, state that limitation explicitly.',
    '4. Never recommend ozone-generating ionizers; distinguish HEPA particle capture from gas/VOC ventilation or activated carbon.',
    '',
    'Return ONLY a valid JSON object matching this exact schema:',
    '{',
    '  "headline": "concise 1-line grounded summary",',
    '  "factsUsed": ["2-3 exact numbers/conditions from the provided telemetry context with source type"],',
    '  "recommendations": ["3 specific, practical steps tailored to the household profile and current dispersion trend"],',
    '  "indoorGuidance": "specific room filtration / ventilation advice grounded in provided room CADR and source type",',
    '  "assumptionsAndLimits": ["1-2 explicit uncertainties or missing inputs (e.g., 40km model grid vs street level, no medical diagnosis)"]',
    '}',
    '',
    'Validated Telemetry & Profile Context:',
    `- Location: ${ctx.city} (${ctx.lat}, ${ctx.lon})`,
    `- Data Source Type: ${ctx.sourceType}`,
    `- CPCB-Derived AQI Estimate: ${ctx.aqi} (${ctx.aqiBand}), Primary Pollutant: ${ctx.primaryPollutant}`,
    `- 24h Rolling PM2.5: ${ctx.pm25} ug/m3, PM10: ${ctx.pm10} ug/m3, NO2: ${ctx.no2} ug/m3`,
    `- Dispersion Trend: ${ctx.trend}, Best Forecasted Window: ${ctx.bestWindow}`,
    `- Household Profile: ${ctx.householdProfile}, Commute: ${ctx.commuteMode} (${ctx.dailyCommuteKm} km/day)`,
    `- Room Volume/CADR Target: ${ctx.roomSqFt} sq.ft (Recommended CADR: ${ctx.recommendedCadr} m3/h), Cooking: ${ctx.cookingFuel}`,
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
    indoorGuidance: sanitizeText(parsed.indoorGuidance, 320),
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

    // Strict server-side credential isolation: ignore any client-supplied API keys
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
      sourceType: sanitizeText(body.sourceType, 80) || 'Modeled Atmospheric Grid (Open-Meteo/CAMS)',
      aqi: Math.round(clampNumber(body.aqi, 0, 500, 0)),
      aqiBand: sanitizeText(body.aqiBand, 32) || 'Unknown',
      primaryPollutant: sanitizeText(body.primaryPollutant, 24) || 'PM2.5',
      pm25: Number(clampNumber(body.pm25, 0, 600, 0).toFixed(1)),
      pm10: Number(clampNumber(body.pm10, 0, 800, 0).toFixed(1)),
      no2: Number(clampNumber(body.no2, 0, 500, 0).toFixed(1)),
      trend: sanitizeText(body.trend, 24) || 'steady',
      bestWindow: sanitizeText(body.bestWindow, 32) || 'Unavailable',
      householdProfile: sanitizeText(body.householdProfile, 32) || 'multi-gen',
      commuteMode: sanitizeText(body.commuteMode, 32) || 'two-wheeler',
      dailyCommuteKm: Math.round(clampNumber(body.dailyCommuteKm, 0, 120, 18)),
      roomSqFt: Math.round(clampNumber(body.roomSqFt, 60, 2000, 220)),
      recommendedCadr: Math.round(clampNumber(body.recommendedCadr, 100, 2000, 250)),
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
            temperature: 0.25,
            maxOutputTokens: 750,
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