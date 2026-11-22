/**
 * @fileoverview Hardened Vercel Serverless Function proxying Google Gemini 2.5 Flash
 * for VayuShield AI. Protects API keys server-side, enforces rate limiting,
 * validates payloads, and strips unsafe markup before returning structured JSON.
 */

import { classifyAqi } from '../js/core/aqiEngine.js';
import { clampNumber, isPlausibleApiKey, sanitizeText } from '../js/core/security.js';

const GEMINI_MODEL = 'gemini-2.5-flash';
const MAX_BODY_BYTES = 16_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 18;
const UPSTREAM_TIMEOUT_MS = 12_000;

/** @type {Map<string, number[]>} */
const ipRequestLog = new Map();

/**
 * Checks whether a client IP is within the sliding-window rate limit.
 * @param {string} ip
 * @param {number} now
 * @returns {boolean}
 */
export function checkRateLimit(ip, now = Date.now()) {
  const key = sanitizeText(ip || 'unknown', 64) || 'unknown';
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const recent = (ipRequestLog.get(key) || []).filter((ts) => ts > windowStart);

  if (recent.length >= RATE_LIMIT_MAX_REQUESTS) {
    ipRequestLog.set(key, recent);
    return false;
  }

  recent.push(now);
  ipRequestLog.set(key, recent);
  return true;
}

/**
 * Resets rate limit buckets (used in automated tests).
 */
export function resetRateLimiter() {
  ipRequestLog.clear();
}

/**
 * Builds a tightly constrained system + user prompt grounded in the user's live AQI and profile.
 * @param {{ question: string, city: string, aqi: number, pm25: number, commuteMode: string, householdProfile: string, budgetTier: string, cookingFuel: string, roomSqFt: number }} ctx
 * @returns {string}
 */
export function buildGroundedPrompt(ctx) {
  const band = classifyAqi(ctx.aqi);
  return [
    'You are VayuShield AI, an evidence-based Urban Air Quality & Winter Smog Assistant for families and communities.',
    'Respond ONLY with a valid JSON object (no markdown fences, no extra prose) matching this exact schema:',
    '{',
    '  "headline": "concise 1-line summary tailored to the user question and city",',
    '  "immediateSteps": ["3 specific, actionable low-emission or indoor protection steps"],',
    '  "indoorHack": "1 practical indoor air quality hack matching their budget and room size",',
    '  "sustainableSwap": "1 realistic low-emission lifestyle alternative",',
    '  "directImpact": "clear quantitative explanation of how these choices reduce PM2.5 exposure, CO2, or health risk",',
    '  "communityTip": "1 neighborhood-level action families can share"',
    '}',
    '',
    'Live Context:',
    `- Location: ${ctx.city}`,
    `- Current AQI: ${ctx.aqi} (${band.label}), PM2.5: ${ctx.pm25} ug/m3`,
    `- Household Profile: ${ctx.householdProfile}`,
    `- Commute Mode: ${ctx.commuteMode}`,
    `- Budget Tier: ${ctx.budgetTier}`,
    `- Cooking Setup: ${ctx.cookingFuel}`,
    `- Primary Room Size: ${ctx.roomSqFt} sq.ft`,
    `- User Question: ${ctx.question}`,
    '',
    'Rules: Be practical, empathetic, medically cautious (never diagnose disease), and quantify direct impact clearly.'
  ].join('\n');
}

/**
 * Parses and sanitizes the JSON returned by Gemini so the frontend never receives unsafe HTML or malformed fields.
 * @param {string} rawText
 */
export function parseSafeGeminiJson(rawText) {
  const stripped = String(rawText || '')
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();

  const parsed = JSON.parse(stripped);
  const steps = Array.isArray(parsed.immediateSteps)
    ? parsed.immediateSteps.map((s) => sanitizeText(s, 220)).filter(Boolean).slice(0, 4)
    : [];

  return {
    headline: sanitizeText(parsed.headline, 180) || 'Personalized Winter Smog Action Plan',
    immediateSteps: steps.length ? steps : ['Check afternoon ventilation window and seal room gaps during evening inversion.'],
    indoorHack: sanitizeText(parsed.indoorHack, 280),
    sustainableSwap: sanitizeText(parsed.sustainableSwap, 280),
    directImpact: sanitizeText(parsed.directImpact, 320),
    communityTip: sanitizeText(parsed.communityTip, 260)
  };
}

/**
 * Factory creating the HTTP handler with injectable dependencies for deterministic testing.
 * @param {{ fetchImpl?: typeof fetch, env?: Record<string, string | undefined>, now?: () => number }} [deps]
 */
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
      return res.status(429).json({ error: 'Rate limit exceeded. Please wait a minute and try again.' });
    }

    const body = req.body && typeof req.body === 'object' ? req.body : null;
    if (!body) {
      return res.status(400).json({ error: 'Invalid JSON request payload.' });
    }

    if (JSON.stringify(body).length > MAX_BODY_BYTES) {
      return res.status(413).json({ error: 'Request payload too large.' });
    }

    const headerKey = typeof req.headers?.['x-gemini-api-key'] === 'string'
      ? req.headers['x-gemini-api-key'].trim()
      : '';
    const apiKey = env.GEMINI_API_KEY || (isPlausibleApiKey(headerKey) ? headerKey : '');

    if (!apiKey) {
      return res.status(503).json({
        error: 'Gemini API key is not configured on the server.',
        fallbackRecommended: true
      });
    }

    const ctx = {
      question: sanitizeText(body.question, 360) || 'How should my family stay safe from smog today?',
      city: sanitizeText(body.city, 80) || 'Delhi NCR',
      aqi: Math.round(clampNumber(body.aqi, 0, 500, 250)),
      pm25: Math.round(clampNumber(body.pm25, 0, 600, 120)),
      commuteMode: sanitizeText(body.commuteMode, 32) || 'two-wheeler',
      householdProfile: sanitizeText(body.householdProfile, 32) || 'multi-gen',
      budgetTier: sanitizeText(body.budgetTier, 32) || 'diy-budget',
      cookingFuel: sanitizeText(body.cookingFuel, 32) || 'lpg-no-chimney',
      roomSqFt: Math.round(clampNumber(body.roomSqFt, 80, 1500, 220))
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
          contents: [{ parts: [{ text: buildGroundedPrompt(ctx) }] }],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 700,
            responseMimeType: 'application/json'
          }
        })
      });

      if (!upstream.ok) {
        return res.status(502).json({
          error: 'Upstream Gemini service returned an error.',
          fallbackRecommended: true
        });
      }

      const data = await upstream.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const structured = parseSafeGeminiJson(text);

      return res.status(200).json({
        engine: 'Google Gemini 2.5 Flash (Server Proxy)',
        ...structured
      });
    } catch {
      return res.status(504).json({
        error: 'Gemini request timed out or could not be parsed.',
        fallbackRecommended: true
      });
    } finally {
      clearTimeout(timeoutId);
    }
  };
}

export default createGeminiHandler();