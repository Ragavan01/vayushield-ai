/**
 * @fileoverview Prompt templates, deterministic 13-intent router, null-preserving
 * environmental context serializer, and in-memory multi-turn conversation session manager.
 */

import { normalizeProfile } from '../core/impactModel.js';
import { sanitizeText } from '../core/security.js';

const MAX_STORED_TURNS = 10;
const MAX_SENT_HISTORY_MESSAGES = 6;

/** @type {ReadonlyArray<Readonly<{ id: string, label: string, prompt: string }>>} */
export const COACH_PROMPT_TEMPLATES = Object.freeze([
  Object.freeze({
    id: 'explain-aqi',
    label: 'Explain my current air quality',
    prompt: 'Explain the current air-quality information for my selected location and clearly identify which information is modeled.'
  }),
  Object.freeze({
    id: 'pollution-drivers',
    label: 'What is driving pollution?',
    prompt: 'What pollutant and meteorological dispersion factors are driving today’s air quality?'
  }),
  Object.freeze({
    id: 'compare-yesterday',
    label: 'Compare today vs. yesterday',
    prompt: 'Compare today’s 24-hour rolling PM2.5 against yesterday’s average and the next 6-hour forecast trend.'
  }),
  Object.freeze({
    id: 'outdoor-window',
    label: 'Practical outdoor window',
    prompt: 'When is a practical daytime outdoor activity window today, and why are overnight lows excluded?'
  }),
  Object.freeze({
    id: 'improve-indoor',
    label: 'Improve indoor air',
    prompt: 'How can I improve my indoor air quality given our kitchen fuel setup and current outdoor PM2.5?'
  }),
  Object.freeze({
    id: 'room-cadr',
    label: 'Explain my room’s CADR',
    prompt: 'Explain my room’s CADR and ACH sizing calculation and compare zero-cost, DIY HEPA, and True H13 options.'
  }),
  Object.freeze({
    id: 'household-today',
    label: 'What should my household do?',
    prompt: 'What practical steps should our household take today across commute, ventilation, and evening protection?'
  }),
  Object.freeze({
    id: 'forecast-uncertainty',
    label: 'Explain forecast uncertainty',
    prompt: 'Explain the data limitations, spatial grid resolution, and forecast uncertainty for this location.'
  })
]);

const INTENT_RULES = Object.freeze([
  ['filtration-cadr', /\b(cadr|ach|purifier|hepa|merv|filter|filtration|sizing|capacity|room volume|bigger purifier|diy box)\b/],
  ['commute-protection', /\b(commute|mask|n95|ffp2|kf94|two-wheeler|scooter|bike|car|metro|bus|school run|roadside)\b/],
  ['outdoor-activity', /\b(outdoor|outside|walk|jog|run|exercise|workout|sport|daytime window|practical.*window|overnight|sunrise|sunset)\b/],
  ['indoor-air', /\b(indoors?|inside|open .*window|windows|ventilat|kitchen|cook|lpg|induction|chimney|seal|incense|room air)\b/],
  ['forecast-interpretation', /\b(yesterday|tomorrow|next 6|6-hour|6h|getting better|getting worse|is the air improving|trend|forecast|uncertaint|confidence|limitation)\b/],
  ['atmospheric-dispersion', /\b(dispersion|boundary[- ]?layer|\bblh\b|ventilation coefficient|\bvc\b|stagnation|inversion|wind|mixing)\b/],
  ['pollution-causes', /\b(causing|causes|driving|driver|why is aqi|why is pollution|source of)\b/],
  ['pollutant-analysis', /\b(pm2\.?5|pm10|no2|so2|ozone|\bo3\b|\bco\b|nh3|lead|\bpb\b|who 2021|sub-index)\b/],
  ['environmental-impact', /\b(co2|carbon|emissions|savings|carpool|sustainable|impact simulator)\b/],
  ['household-advice', /\b(household|family|kids|children|senior|elderly|asthma|what should .* do|routine)\b/],
  ['aqi-explanation', /\b(aqi|air quality|index|bad|safe|severe|poor|moderate|good|satisfactory|calculation|methodology|modeled)\b/]
]);

/**
 * Classifies a user prompt into 1 of 13 structured intents with deterministic priority.
 * @param {string} question
 * @param {number} [historyLength=0]
 * @returns {string}
 */
export function classifyCoachIntent(question, historyLength = 0) {
  const lower = String(question || '').toLowerCase().trim();
  if (/^(hi|hello|hey|yo|namaste|vanakkam|good morning|good evening|help|\?)[!., ]*$/.test(lower) || lower.length <= 4) {
    return 'greeting';
  }
  for (const [intent, pattern] of INTENT_RULES) {
    if (pattern.test(lower)) return intent;
  }
  if (historyLength > 0 && /\b(it|its|that|those|them|simpler|simple terms|explain more|what if|how about|why|elaborate)\b/.test(lower)) {
    return 'follow-up';
  }
  return 'general-education';
}

function buildAtmosphericPayload(intel) {
  const disp = intel?.dispersion || null;
  const dispOk = Boolean(disp && disp.available !== false);
  const firstHr = disp?.hourly?.[0] || null;
  const dayWin = dispOk ? (disp.bestDaytimeWindow || disp.bestOutdoorWindow || null) : null;
  const lowWin = dispOk ? (disp.lowestPollutionWindow || null) : null;
  const peakWin = dispOk ? (disp.peakAccumulationWindow || null) : null;

  return {
    tempC: intel?.current?.tempC ?? null,
    windKmh: intel?.current?.windKmh ?? firstHr?.windKmh ?? null,
    windCompass: firstHr?.windCompass ?? null,
    rhPct: intel?.current?.rhPct ?? null,
    blhMeters: firstHr?.blh ?? null,
    ventilationCoeff: firstHr?.vc ?? null,
    dispersionCategory: firstHr?.dispersionCategory ?? disp?.classification ?? null,
    trend: disp?.trend ?? null,
    trendDeltaPct: disp?.trendDeltaPct ?? null,
    lowestWindow: lowWin ? `${lowWin.label} (${lowWin.avgPm25} µg/m³)` : null,
    bestDaytimeWindow: dayWin ? dayWin.label : null,
    bestDaytimePm25: dayWin?.avgPm25 ?? null,
    peakAccumulationWindow: peakWin ? `${peakWin.label} (${peakWin.avgPm25} µg/m³)` : null,
    confidenceNote: disp?.confidence?.reason ?? null
  };
}

function buildIndoorPayload(indoorEval) {
  if (!indoorEval) return null;
  return {
    roomVolumeM3: indoorEval.dimensions.volumeM3,
    recommendedCadrM3h: indoorEval.sizing.recommendedCadrM3h,
    effectiveCadrM3h: indoorEval.sizing.effectiveCadrM3h,
    targetAch: indoorEval.sizing.recommendedAch,
    filterGrade: indoorEval.assumptions.filterGradeLabel,
    unfilteredIndoorPm25: indoorEval.outcomes.unfilteredIndoorPm25,
    filteredIndoorPm25: indoorEval.outcomes.filteredIndoorPm25,
    assumptions: indoorEval.safetyNotes?.[0] || null
  };
}

/**
 * Builds the full nested ORACLE environmental context object preserving nulls and provenance.
 * @param {Record<string, any> | null} intel
 * @param {Record<string, any> | null} rawProfile
 * @param {Record<string, any> | null} indoorEval
 * @returns {Record<string, any>}
 */
export function buildCoachContextPayload(intel, rawProfile, indoorEval) {
  const profile = normalizeProfile(rawProfile);
  return {
    location: {
      city: intel?.location?.name ?? null,
      region: intel?.location?.region ?? null,
      lat: intel?.location?.lat ?? null,
      lon: intel?.location?.lon ?? null,
      timezone: intel?.location?.timezone ?? null
    },
    provenance: {
      provider: intel?.metadata?.provider ?? null,
      sourceType: intel?.metadata?.sourceType ?? 'Modeled Atmospheric Grid (Not Ground Station)',
      retrievalTimestamp: intel?.metadata?.fetchedAt ?? null,
      measurementTimestamp: intel?.current?.timestamp ?? null,
      spatialResolution: intel?.metadata?.gridResolution ?? null,
      averagingPeriod: intel?.metadata?.averagingNote ?? null,
      freshness: intel?.metadata?.freshness ?? null
    },
    airQuality: {
      aqi: intel?.cpcb?.aqi ?? null,
      standard: intel?.cpcb?.methodologyLabel ?? 'CPCB-Derived Modeled Estimate',
      category: intel?.cpcb?.band?.label ?? null,
      primaryPollutant: intel?.cpcb?.primaryPollutant?.name ?? null,
      completenessMet: intel?.cpcb?.meetsCompletenessRule ?? null,
      pm25_24h: intel?.rollingAverages?.pm25_24h ?? intel?.current?.pm25 ?? null,
      yesterdayPm25_24h: intel?.rollingAverages?.yesterdayPm25_24h ?? null,
      pm10_24h: intel?.rollingAverages?.pm10_24h ?? intel?.current?.pm10 ?? null,
      no2_24h: intel?.rollingAverages?.no2_24h ?? intel?.current?.no2 ?? null,
      so2_24h: intel?.rollingAverages?.so2_24h ?? intel?.current?.so2 ?? null,
      o3_8h: intel?.rollingAverages?.o3_8h ?? intel?.current?.o3 ?? null,
      coMg_8h: intel?.rollingAverages?.coMg_8h ?? intel?.current?.coMg ?? null,
      nh3_24h: null,
      pb_24h: null
    },
    atmospheric: buildAtmosphericPayload(intel),
    household: {
      vulnerability: profile.householdProfile,
      commuteMode: profile.commuteMode,
      dailyCommuteKm: profile.dailyCommuteKm,
      cookingFuel: profile.cookingFuel,
      roomSqFt: profile.roomSqFt,
      ceilingHeightFt: profile.ceilingHeightFt,
      leakageId: profile.leakageId,
      budgetTier: profile.budgetTier
    },
    indoorPhysics: buildIndoorPayload(indoorEval)
  };
}

/**
 * Creates an in-memory conversation session manager that automatically resets on location change.
 * @returns {{ setLocation: (loc: any) => boolean, reset: () => void, addExchange: (q: string, a: string, intent: string) => void, exportHistoryPayload: () => { history: Array<{ role: string, text: string }>, historySummary: string }, getTurnCount: () => number }}
 */
export function createConversationSession() {
  let locationKey = '';
  let turns = [];
  let olderSummary = '';

  function setLocation(loc) {
    const nextKey = loc ? `${loc.name || ''}:${loc.lat ?? ''},${loc.lon ?? ''}` : '';
    if (locationKey && nextKey && nextKey !== locationKey) {
      turns = [];
      olderSummary = '';
      locationKey = nextKey;
      return true;
    }
    locationKey = nextKey;
    return false;
  }

  function reset() {
    turns = [];
    olderSummary = '';
  }

  function addExchange(question, answerText, intent) {
    turns.push({ question: sanitizeText(question, 360), answer: sanitizeText(answerText, 600), intent });
    if (turns.length > MAX_STORED_TURNS) {
      const evicted = turns.shift();
      olderSummary = `${olderSummary} Earlier discussed ${evicted.intent}: "${evicted.question.slice(0, 70)}".`.trim().slice(-380);
    }
  }

  function exportHistoryPayload() {
    const recent = turns.slice(-Math.floor(MAX_SENT_HISTORY_MESSAGES / 2));
    const history = recent.flatMap((t) => [{ role: 'user', text: t.question }, { role: 'model', text: t.answer }]);
    return { history, historySummary: olderSummary };
  }

  return { setLocation, reset, addExchange, exportHistoryPayload, getTurnCount: () => turns.length };
}