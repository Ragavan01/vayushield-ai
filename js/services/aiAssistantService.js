/**
 * @fileoverview VayuShield AI Coach client.
 * Strictly communicates with `/api/gemini`, never coerces missing pollutants to 0,
 * and supplies yesterday-vs-today 24-hr PM2.5 telemetry for factual comparisons.
 */

import { normalizeProfile } from '../core/impactModel.js';
import { sanitizeText } from '../core/security.js';

const CLIENT_TIMEOUT_MS = 13_000;

export const COACH_PROMPT_TEMPLATES = Object.freeze([
  Object.freeze({
    id: 'explain-aqi',
    label: 'Explain my current air quality',
    prompt: 'Explain our current CPCB-derived AQI estimate, which pollutant is driving it, and how reliable this modeled reading is.'
  }),
  Object.freeze({
    id: 'pollution-drivers',
    label: 'What is causing today’s pollution?',
    prompt: 'Based on our primary pollutant, boundary-layer height, and wind speed, what dispersion conditions are shaping today’s air quality?'
  }),
  Object.freeze({
    id: 'compare-yesterday',
    label: 'Compare today vs. yesterday',
    prompt: 'Compare today’s 24-hour rolling PM2.5 against yesterday’s 24-hour average and the next 6-hour forecast trend.'
  }),
  Object.freeze({
    id: 'daytime-window',
    label: 'When is outdoor activity most practical?',
    prompt: 'When is the most practical daytime window for outdoor activity or ventilation, and why should overnight lows not be used for exercise?'
  }),
  Object.freeze({
    id: 'improve-indoor',
    label: 'How can I improve my indoor air?',
    prompt: 'Give practical steps to improve indoor air quality for our household profile and kitchen fuel setup without relying on ozone ionizers.'
  }),
  Object.freeze({
    id: 'room-cadr',
    label: 'What filtration capacity does my room need?',
    prompt: 'Explain the mass-balance CADR and filter-efficiency calculation for my room dimensions and compare zero-cost, DIY, and True H13 options.'
  })
]);

export function buildGroundedFallback(question, intel, rawProfile, indoorEval) {
  const profile = normalizeProfile(rawProfile);
  const city = intel?.location?.name || 'Selected Location';
  const aqi = intel?.cpcb?.aqi ?? null;
  const band = intel?.cpcb?.band?.label || 'Unavailable';
  const primary = intel?.cpcb?.primaryPollutant;
  const todayPm25 = intel?.rollingAverages?.pm25_24h ?? null;
  const yestPm25 = intel?.rollingAverages?.yesterdayPm25_24h ?? null;
  const disp = intel?.dispersion;
  const cleanQ = sanitizeText(question, 240);

  const dayWin = disp?.available ? disp.bestDaytimeWindow : null;
  const yestCompare = todayPm25 !== null && yestPm25 !== null
    ? `24-hr rolling PM2.5 is ${todayPm25} µg/m³ vs. yesterday’s ${yestPm25} µg/m³ (${todayPm25 - yestPm25 >= 0 ? '+' : ''}${(todayPm25 - yestPm25).toFixed(1)} µg/m³).`
    : 'Yesterday’s 24-hr comparison average was unavailable in this payload.';

  const factsUsed = [
    `${city} (${intel?.location?.lat ?? '—'}°, ${intel?.location?.lon ?? '—'}°) · Valid ${intel?.current?.timestamp || 'Unavailable'}: ${intel?.metadata?.sourceType || 'Modeled Atmospheric Grid'} (${intel?.metadata?.gridResolution || '~40 km'}).`,
    aqi !== null
      ? `CPCB-derived estimate: AQI ${aqi} (${band}); Primary pollutant: ${primary ? `${primary.name} (${primary.concentration} ${primary.unit}, ${primary.averaging})` : 'Unavailable'}.`
      : 'Pollutant data was insufficient to compute a complete CPCB-derived AQI.',
    `${yestCompare} ${dayWin ? `Best practical daytime window: ${dayWin.label} (Projected PM2.5: ${dayWin.avgPm25} µg/m³).` : ''}`.trim()
  ];

  const recommendations = [
    disp?.available && disp.bestVentilationWindow
      ? disp.bestVentilationWindow.guidance
      : 'Keep exterior openings closed during stagnant low-wind periods and flush briefly during cleaner daylight hours.',
    `For your ${profile.dailyCommuteKm} km ${profile.commuteMode} commute, ${aqi !== null && aqi > 150 ? 'wear a tight-seal N95/FFP2 respirator along traffic corridors and avoid peak exhaust queues.' : 'standard precautions apply; monitor evening boundary-layer drops.'}`,
    profile.cookingFuel === 'induction'
      ? 'Continue electric/induction cooking with pan lids and kitchen exhaust during high-heat frying.'
      : 'Run outward kitchen exhaust during LPG/solid-fuel cooking and shift boiling/simmering to electric appliances to reduce indoor NO₂ spikes.'
  ];

  const indoorGuidance = indoorEval
    ? `For your ${indoorEval.dimensions.floorAreaSqFt} sq.ft room (${indoorEval.dimensions.volumeM3} m³ volume, ${indoorEval.assumptions.filterGradeLabel}), target CADR ≥ ${indoorEval.sizing.recommendedCadrM3h} m³/h (${indoorEval.sizing.recommendedAch} ACH). Steady-state mass-balance modeling estimates indoor PM2.5 dropping from ${indoorEval.outcomes.unfilteredIndoorPm25} to ${indoorEval.outcomes.filteredIndoorPm25} µg/m³ (range ${indoorEval.outcomes.filteredRange[0]}–${indoorEval.outcomes.filteredRange[1]} µg/m³). Note: True HEPA captures particles only, not NO₂/VOCs; avoid ozone ionizers.`
    : 'Size mechanical True HEPA filtration to 4–5 air changes per hour and keep ozone/ionizer modes off.';

  const assumptionsAndLimits = [
    'Generated by VayuShield Deterministic Grounded Engine because the server-side Gemini API proxy was unreachable or GEMINI_API_KEY is not active in this environment.',
    `Modeled ${intel?.metadata?.gridResolution || '~40 km'} grid averages can underestimate street-level hotspots compared to nearby CPCB CAAQMS monitors; NH₃ and Pb are unavailable in CAMS; guidance is not medical advice.`,
    cleanQ ? `Query context evaluated: "${cleanQ}"` : 'Default household smog assessment.'
  ];

  return {
    engine: 'VayuShield Grounded Engine (Server Proxy Unavailable)',
    isFallback: true,
    headline: aqi !== null
      ? `${city}: ${band} Modeled Air (Est. AQI ${aqi}) — Grounded Household Plan`
      : `${city}: Grounded Air Quality Guidance`,
    factsUsed,
    recommendations,
    indoorGuidance,
    assumptionsAndLimits
  };
}

export async function askVayuShieldCoach(params, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const profile = normalizeProfile(params.profile);
  const intel = params.intel;
  const indoorEval = params.indoorEval;
  const question = sanitizeText(params.question, 360) || COACH_PROMPT_TEMPLATES[0].prompt;

  if (!intel || !intel.location) {
    return buildGroundedFallback(question, intel, profile, indoorEval);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);

  try {
    const response = await fetchImpl('/api/gemini', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        question,
        city: intel.location.name,
        lat: intel.location.lat,
        lon: intel.location.lon,
        measurementTime: intel.current?.timestamp ?? null,
        sourceType: `${intel.metadata.sourceType} (${intel.metadata.gridResolution})`,
        aqi: intel.cpcb?.aqi ?? null,
        aqiBand: intel.cpcb?.band?.label ?? null,
        primaryPollutant: intel.cpcb?.primaryPollutant?.name ?? null,
        pm25: intel.rollingAverages?.pm25_24h ?? intel.current?.pm25 ?? null,
        yesterdayPm25: intel.rollingAverages?.yesterdayPm25_24h ?? null,
        pm10: intel.rollingAverages?.pm10_24h ?? intel.current?.pm10 ?? null,
        no2: intel.rollingAverages?.no2_24h ?? intel.current?.no2 ?? null,
        so2: intel.rollingAverages?.so2_24h ?? intel.current?.so2 ?? null,
        o3: intel.rollingAverages?.o3_8h ?? intel.current?.o3 ?? null,
        coMg: intel.rollingAverages?.coMg_8h ?? intel.current?.coMg ?? null,
        trend: intel.dispersion?.trend ?? 'unavailable',
        bestWindow: intel.dispersion?.bestDaytimeWindow?.label ?? 'Unavailable',
        householdProfile: profile.householdProfile,
        commuteMode: profile.commuteMode,
        dailyCommuteKm: profile.dailyCommuteKm,
        roomSqFt: profile.roomSqFt,
        recommendedCadr: indoorEval?.sizing?.recommendedCadrM3h ?? null,
        cookingFuel: profile.cookingFuel
      })
    });

    if (!response.ok) throw new Error(`Proxy HTTP ${response.status}`);

    const payload = await response.json();
    if (!payload || !payload.headline || !Array.isArray(payload.recommendations)) {
      throw new Error('Malformed coach response');
    }

    return { ...payload, isFallback: false };
  } catch {
    return buildGroundedFallback(question, intel, profile, indoorEval);
  } finally {
    clearTimeout(timer);
  }
}