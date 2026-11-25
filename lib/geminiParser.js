/**
 * @fileoverview Configuration parsing, null-safe environmental context validation,
 * conversation history normalization, and structured JSON output validation.
 */

import { sanitizeText } from '../js/core/security.js';
import {
  DEFAULT_GEMINI_MODEL_ID,
  GEMINI_LIMITS,
  MODEL_ID_REGEX
} from './geminiSchema.js';

const VALID_SOURCE_TYPES = new Set(['observed', 'modeled', 'calculated', 'estimated', 'unavailable']);
const VALID_PRIORITIES = new Set(['high', 'medium', 'low']);

/**
 * Strips optional "models/" prefix and validates a Gemini model identifier.
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeModelId(raw) {
  if (typeof raw !== 'string') return '';
  const stripped = raw.trim().replace(/^models\//i, '');
  return MODEL_ID_REGEX.test(stripped) ? stripped : '';
}

/**
 * Resolves server-side Gemini credentials and model selection from environment variables.
 * @param {Record<string, string | undefined>} [env=process.env]
 * @returns {{ apiKey: string, primaryModel: string, primaryValid: boolean, fallbackModel: string, usedDefaultModel: boolean }}
 */
export function resolveModelConfig(env = process.env) {
  const apiKey = typeof env.GEMINI_API_KEY === 'string' ? env.GEMINI_API_KEY.trim() : '';
  const rawPrimary = typeof env.GEMINI_MODEL_ID === 'string' ? env.GEMINI_MODEL_ID.trim() : '';
  const rawFallback = typeof env.GEMINI_FALLBACK_MODEL_ID === 'string' ? env.GEMINI_FALLBACK_MODEL_ID.trim() : '';

  const primaryModel = rawPrimary ? normalizeModelId(rawPrimary) : DEFAULT_GEMINI_MODEL_ID;
  const fallbackModel = rawFallback ? normalizeModelId(rawFallback) : '';

  return {
    apiKey,
    primaryModel,
    primaryValid: Boolean(primaryModel),
    fallbackModel: fallbackModel && fallbackModel !== primaryModel ? fallbackModel : '',
    usedDefaultModel: !rawPrimary
  };
}

/**
 * Parses an optional numeric metric without ever coercing missing or out-of-range inputs to 0.
 * @param {unknown} raw
 * @param {number} min
 * @param {number} max
 * @param {number} [decimals=1]
 * @returns {number | null}
 */
export function parseNullableMetric(raw, min, max, decimals = 1) {
  if (raw === null || raw === undefined || raw === '') return null;
  const num = Number(raw);
  if (!Number.isFinite(num) || num < min || num > max) return null;
  return Number(num.toFixed(decimals));
}

function formatMetric(val, unit = '') {
  if (val === null || val === undefined) return 'Unavailable (missing — do not assume zero)';
  return unit ? `${val} ${unit}` : String(val);
}

function buildLocationSection(loc, body) {
  return {
    city: sanitizeText(loc.city ?? body.city, 80) || 'Selected Location',
    region: sanitizeText(loc.region ?? body.region, 80) || null,
    lat: parseNullableMetric(loc.lat ?? body.lat, -90, 90, 4),
    lon: parseNullableMetric(loc.lon ?? body.lon, -180, 180, 4),
    timezone: sanitizeText(loc.timezone ?? body.timezone, 48) || null
  };
}

function buildProvenanceSection(prov, body) {
  return {
    provider: sanitizeText(prov.provider, 90) || 'Open-Meteo / Copernicus CAMS',
    sourceType: sanitizeText(prov.sourceType ?? body.sourceType, 96) || 'Modeled Atmospheric Grid (Not Ground Station)',
    retrievalTimestamp: sanitizeText(prov.retrievalTimestamp, 40) || null,
    measurementTimestamp: sanitizeText(prov.measurementTimestamp ?? body.measurementTime, 40) || null,
    spatialResolution: sanitizeText(prov.spatialResolution, 64) || null,
    averagingPeriod: sanitizeText(prov.averagingPeriod, 96) || '24h rolling PM2.5/PM10/NO2/SO2; 8h rolling O3/CO',
    freshness: sanitizeText(prov.freshness, 48) || null
  };
}

function buildAirQualitySection(aq, body) {
  return {
    aqi: parseNullableMetric(aq.aqi ?? body.aqi, 0, 500, 0),
    standard: sanitizeText(aq.standard, 64) || 'CPCB-Derived Modeled Estimate',
    category: sanitizeText(aq.category ?? body.aqiBand, 32) || null,
    primaryPollutant: sanitizeText(aq.primaryPollutant ?? body.primaryPollutant, 24) || null,
    completenessMet: typeof aq.completenessMet === 'boolean' ? aq.completenessMet : null,
    pm25_24h: parseNullableMetric(aq.pm25_24h ?? body.pm25, 0, 600, 1),
    yesterdayPm25_24h: parseNullableMetric(aq.yesterdayPm25_24h ?? body.yesterdayPm25, 0, 600, 1),
    pm10_24h: parseNullableMetric(aq.pm10_24h ?? body.pm10, 0, 800, 1),
    no2_24h: parseNullableMetric(aq.no2_24h ?? body.no2, 0, 500, 1),
    so2_24h: parseNullableMetric(aq.so2_24h ?? body.so2, 0, 2500, 1),
    o3_8h: parseNullableMetric(aq.o3_8h ?? body.o3, 0, 1000, 1),
    coMg_8h: parseNullableMetric(aq.coMg_8h ?? body.coMg, 0, 60, 2),
    nh3_24h: null,
    pb_24h: null
  };
}

function buildAtmosphericSection(atm, body) {
  return {
    tempC: parseNullableMetric(atm.tempC, -60, 65, 1),
    windKmh: parseNullableMetric(atm.windKmh ?? body.windKmh, 0, 250, 1),
    windCompass: sanitizeText(atm.windCompass, 8) || null,
    rhPct: parseNullableMetric(atm.rhPct, 0, 100, 0),
    blhMeters: parseNullableMetric(atm.blhMeters ?? body.blh, 10, 6000, 0),
    ventilationCoeff: parseNullableMetric(atm.ventilationCoeff ?? body.vc, 0, 250000, 0),
    dispersionCategory: sanitizeText(atm.dispersionCategory, 96) || null,
    trend: sanitizeText(atm.trend ?? body.trend, 24) || null,
    trendDeltaPct: parseNullableMetric(atm.trendDeltaPct, -100, 500, 0),
    lowestWindow: sanitizeText(atm.lowestWindow, 48) || null,
    bestDaytimeWindow: sanitizeText(atm.bestDaytimeWindow ?? body.bestWindow, 48) || null,
    bestDaytimePm25: parseNullableMetric(atm.bestDaytimePm25 ?? body.bestWindowPm25, 0, 600, 1),
    peakAccumulationWindow: sanitizeText(atm.peakAccumulationWindow ?? body.peakWindow, 48) || null,
    confidenceNote: sanitizeText(atm.confidenceNote, 180) || null
  };
}

function buildHouseholdSection(hh, body) {
  return {
    vulnerability: sanitizeText(hh.vulnerability ?? body.householdProfile, 32) || null,
    commuteMode: sanitizeText(hh.commuteMode ?? body.commuteMode, 32) || null,
    dailyCommuteKm: parseNullableMetric(hh.dailyCommuteKm ?? body.dailyCommuteKm, 0, 120, 0),
    cookingFuel: sanitizeText(hh.cookingFuel ?? body.cookingFuel, 32) || null,
    roomSqFt: parseNullableMetric(hh.roomSqFt ?? body.roomSqFt, 60, 2000, 0),
    ceilingHeightFt: parseNullableMetric(hh.ceilingHeightFt, 7, 16, 1),
    leakageId: sanitizeText(hh.leakageId, 24) || null,
    budgetTier: sanitizeText(hh.budgetTier, 24) || null
  };
}

function buildIndoorPhysicsSection(ip, body) {
  return {
    roomVolumeM3: parseNullableMetric(ip.roomVolumeM3 ?? body.roomVolumeM3, 10, 1000, 1),
    recommendedCadrM3h: parseNullableMetric(ip.recommendedCadrM3h ?? body.recommendedCadr, 50, 2000, 0),
    effectiveCadrM3h: parseNullableMetric(ip.effectiveCadrM3h, 0, 2000, 0),
    targetAch: parseNullableMetric(ip.targetAch, 1, 12, 1),
    filterGrade: sanitizeText(ip.filterGrade, 48) || null,
    unfilteredIndoorPm25: parseNullableMetric(ip.unfilteredIndoorPm25 ?? body.unfilteredIndoorPm25, 0, 600, 1),
    filteredIndoorPm25: parseNullableMetric(ip.filteredIndoorPm25 ?? body.filteredIndoorPm25, 0, 600, 1),
    assumptions: sanitizeText(ip.assumptions, 220) || null
  };
}

/**
 * Normalizes both nested ORACLE context and legacy flat payload fields while preserving nulls.
 * @param {Record<string, any>} [body={}]
 * @returns {Record<string, any>}
 */
export function validateEnvironmentalContext(body = {}) {
  const ctx = body.context && typeof body.context === 'object' ? body.context : {};
  return {
    intent: sanitizeText(body.intent, 32) || 'general',
    location: buildLocationSection(ctx.location || {}, body),
    provenance: buildProvenanceSection(ctx.provenance || {}, body),
    airQuality: buildAirQualitySection(ctx.airQuality || {}, body),
    atmospheric: buildAtmosphericSection(ctx.atmospheric || {}, body),
    household: buildHouseholdSection(ctx.household || {}, body),
    indoorPhysics: buildIndoorPhysicsSection(ctx.indoorPhysics || {}, body)
  };
}

/**
 * Builds the structured textual context block injected into Gemini user turns.
 * @param {Record<string, any>} ctx
 * @returns {string}
 */
export function buildScientificPrompt(ctx) {
  const isNested = Boolean(ctx && ctx.airQuality);
  const city = isNested ? ctx.location.city : ctx.city;
  const lat = isNested ? ctx.location.lat : ctx.lat;
  const lon = isNested ? ctx.location.lon : ctx.lon;
  const measurementTime = isNested ? ctx.provenance.measurementTimestamp : ctx.measurementTime;
  const sourceType = isNested ? ctx.provenance.sourceType : ctx.sourceType;
  const aqi = isNested ? ctx.airQuality.aqi : ctx.aqi;
  const aqiBand = isNested ? ctx.airQuality.category : ctx.aqiBand;
  const primaryPollutant = isNested ? ctx.airQuality.primaryPollutant : ctx.primaryPollutant;
  const pm25 = isNested ? ctx.airQuality.pm25_24h : ctx.pm25;
  const yesterdayPm25 = isNested ? ctx.airQuality.yesterdayPm25_24h : ctx.yesterdayPm25;

  return [
    '[VALIDATED_ENVIRONMENTAL_CONTEXT]',
    'Rule: Never invent pollutant readings or treat Unavailable values as zero.',
    `- Location: ${city || 'Selected Location'} (${lat ?? 'Unavailable'}, ${lon ?? 'Unavailable'}) · Valid Timestamp: ${measurementTime || 'Unavailable'}`,
    `- Data Provenance: ${sourceType || 'Modeled Atmospheric Grid'}`,
    `- CPCB-Derived AQI Estimate: ${formatMetric(aqi)} (${aqiBand || 'Unavailable'}), Primary Pollutant: ${primaryPollutant || 'Unavailable'}`,
    `- 24h Rolling PM2.5: ${formatMetric(pm25, 'ug/m3')} | Prior 24h (Yesterday) PM2.5: ${formatMetric(yesterdayPm25, 'ug/m3')}`,
    isNested ? `- Full Validated JSON Snapshot:\n${JSON.stringify(ctx)}` : '',
    '[/VALIDATED_ENVIRONMENTAL_CONTEXT]'
  ].filter(Boolean).join('\n');
}

/**
 * Sanitizes multi-turn conversation history into strictly alternating Gemini user/model turns.
 * @param {unknown} rawHistory
 * @param {string} [rawSummary='']
 * @returns {{ valid: boolean, turns: Array<{ role: string, parts: Array<{ text: string }> }> }}
 */
export function sanitizeConversationHistory(rawHistory, rawSummary = '') {
  if (rawHistory !== undefined && !Array.isArray(rawHistory)) {
    return { valid: false, turns: [] };
  }

  const turns = [];
  const summary = sanitizeText(rawSummary, 420);
  if (summary) {
    turns.push({ role: 'user', parts: [{ text: `[EARLIER_SESSION_SUMMARY]\n${summary}\n[/EARLIER_SESSION_SUMMARY]` }] });
    turns.push({ role: 'model', parts: [{ text: 'Acknowledged earlier session context.' }] });
  }

  const recentItems = Array.isArray(rawHistory) ? rawHistory.slice(-GEMINI_LIMITS.MAX_HISTORY_TURNS) : [];
  for (const item of recentItems) {
    if (!item || typeof item !== 'object') continue;
    const role = item.role === 'model' || item.role === 'assistant' ? 'model' : item.role === 'user' ? 'user' : null;
    const text = sanitizeText(item.text || item.content, 600);
    if (!role || !text || (turns.length === 0 && role === 'model')) continue;

    const prev = turns[turns.length - 1];
    if (prev && prev.role === role) {
      prev.parts[0].text = `${prev.parts[0].text}\n${text}`.slice(0, 900);
    } else {
      turns.push({ role, parts: [{ text }] });
    }
  }

  if (turns.length > 0 && turns[turns.length - 1].role === 'user') {
    turns.pop();
  }
  return { valid: true, turns };
}

function normalizeFactItem(item) {
  if (typeof item === 'string') {
    const text = sanitizeText(item, 220);
    return text ? { label: 'Context', value: text, unit: '', sourceType: 'modeled', timestamp: null, text } : null;
  }
  if (!item || typeof item !== 'object') return null;

  const label = sanitizeText(item.label, 48);
  if (!label) return null;

  const rawVal = item.value;
  const rawStr = typeof rawVal === 'string' ? rawVal.trim() : '';
  const value = rawVal === null || rawVal === undefined || rawStr === '' || /^(null|unavailable)$/i.test(rawStr)
    ? null
    : typeof rawVal === 'number' && Number.isFinite(rawVal)
      ? rawVal
      : sanitizeText(String(rawVal), 64);

  const rawTs = typeof item.timestamp === 'string' ? item.timestamp.trim() : '';
  return {
    label,
    value,
    unit: sanitizeText(item.unit, 24),
    sourceType: VALID_SOURCE_TYPES.has(item.sourceType) ? item.sourceType : 'modeled',
    timestamp: !rawTs || /^(null|unavailable)$/i.test(rawTs) ? null : sanitizeText(rawTs, 40)
  };
}

function normalizeRecommendationItem(item) {
  if (typeof item === 'string') {
    const desc = sanitizeText(item, 260);
    return desc ? { title: 'Recommendation', description: desc, reason: '', priority: 'medium', timeWindow: 'Today' } : null;
  }
  if (!item || typeof item !== 'object') return null;

  const title = sanitizeText(item.title, 80);
  const description = sanitizeText(item.description, 260);
  if (!title && !description) return null;

  return {
    title: title || 'Recommendation',
    description: description || title,
    reason: sanitizeText(item.reason, 180),
    priority: VALID_PRIORITIES.has(item.priority) ? item.priority : 'medium',
    timeWindow: sanitizeText(item.timeWindow, 48) || 'Unavailable'
  };
}

function sanitizeStringArray(arr, limit, maxLen = 220) {
  if (!Array.isArray(arr)) return [];
  return arr.map((item) => sanitizeText(item, maxLen)).filter(Boolean).slice(0, limit);
}

/**
 * Validates and sanitizes structured JSON returned by Gemini or test fixtures.
 * @param {string} rawText
 * @returns {Record<string, any>}
 */
export function parseStructuredCoachResponse(rawText) {
  const cleaned = String(rawText || '').replace(/```json/gi, '').replace(/```/g, '').trim();
  const parsed = JSON.parse(cleaned);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Model response must be a JSON object');
  }

  const headline = sanitizeText(parsed.headline, 140);
  const factsUsed = Array.isArray(parsed.factsUsed)
    ? parsed.factsUsed.slice(0, GEMINI_LIMITS.MAX_FACTS).map(normalizeFactItem).filter(Boolean)
    : [];
  const recommendations = Array.isArray(parsed.recommendations)
    ? parsed.recommendations.slice(0, GEMINI_LIMITS.MAX_RECOMMENDATIONS).map(normalizeRecommendationItem).filter(Boolean)
    : [];

  const firstFact = factsUsed[0];
  const fallbackSummary = recommendations[0]?.description
    || (firstFact ? (firstFact.text || `${firstFact.label}: ${firstFact.value ?? ''}`.trim()) : '');
  const answer = sanitizeText(parsed.answer || parsed.directAnswer || parsed.indoorGuidance || fallbackSummary, 1200);

  if (!headline || !answer) {
    throw new Error('Missing required headline or answer field');
  }

  return {
    headline,
    answer,
    directAnswer: answer,
    factsUsed,
    recommendations,
    indoorGuidance: sanitizeText(parsed.indoorGuidance, 420),
    assumptionsAndLimits: sanitizeStringArray(parsed.assumptionsAndLimits, GEMINI_LIMITS.MAX_ASSUMPTIONS, 220),
    followUpSuggestions: sanitizeStringArray(parsed.followUpSuggestions, GEMINI_LIMITS.MAX_FOLLOWUPS, 90)
  };
}