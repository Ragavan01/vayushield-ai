/**
 * @fileoverview Deterministic Offline Grounded Engine for VayuShield AI Coach.
 * Provides transparent, physics- and telemetry-backed answers whenever upstream
 * Gemini inference is unavailable (never claims Gemini ran).
 */

import { normalizeProfile } from '../core/impactModel.js';
import { sanitizeText } from '../core/security.js';
import { classifyCoachIntent } from './aiContextBuilder.js';

function createSnapshot(intel, rawProfile, indoorEval, diagnosticCode, intent) {
  const profile = normalizeProfile(rawProfile);
  const disp = intel?.dispersion;
  const dispOk = Boolean(disp && disp.available !== false);
  const resLabel = intel?.metadata?.gridResolution || '~40 km CAMS grid';
  const ts = intel?.current?.timestamp || null;

  return {
    profile,
    indoorEval,
    intel,
    city: intel?.location?.name || 'Selected Location',
    aqi: intel?.cpcb?.aqi ?? null,
    band: intel?.cpcb?.band?.label || 'Unavailable',
    primary: intel?.cpcb?.primaryPollutant || null,
    todayPm25: intel?.rollingAverages?.pm25_24h ?? intel?.current?.pm25 ?? null,
    yestPm25: intel?.rollingAverages?.yesterdayPm25_24h ?? null,
    disp,
    firstHr: disp?.hourly?.[0] || null,
    dayWin: dispOk ? (disp.bestDaytimeWindow || disp.bestOutdoorWindow || null) : null,
    lowWin: dispOk ? (disp.lowestPollutionWindow || null) : null,
    peakWin: dispOk ? (disp.peakAccumulationWindow || null) : null,
    resLabel,
    mkFact: (label, value, unit = '', sourceType = 'modeled') => ({
      label,
      value: value === null || value === undefined ? null : value,
      unit,
      sourceType: value === null || value === undefined ? 'unavailable' : sourceType,
      timestamp: ts
    }),
    mkRec: (title, description, reason, priority = 'medium', timeWindow = 'Today') => ({
      title, description, reason, priority, timeWindow
    }),
    commonLimits: [
      `Offline grounded response (${diagnosticCode || 'API_UNAVAILABLE'}): generated deterministically without Gemini.`,
      `Modeled ${resLabel} telemetry (not a direct CPCB ground station; NH₃ & Pb unavailable). Informational only, not medical advice.`
    ],
    baseMeta: {
      provider: 'vayushield-deterministic',
      model: null,
      engine: 'VayuShield Grounded Engine · Offline Mode',
      mode: 'grounded-fallback',
      isFallback: true,
      status: 'fallback',
      diagnosticCode: diagnosticCode || 'OFFLINE_FALLBACK',
      intent
    }
  };
}

function finalize(snap, content) {
  return {
    ...snap.baseMeta,
    headline: content.headline,
    answer: content.answer,
    directAnswer: content.answer,
    factsUsed: content.factsUsed,
    recommendations: content.recommendations,
    indoorGuidance: content.indoorGuidance ?? '',
    assumptionsAndLimits: content.assumptionsAndLimits || snap.commonLimits,
    followUpSuggestions: content.followUpSuggestions
  };
}

function buildGreeting(s) {
  const answer = s.aqi !== null
    ? `Hello! Currently ${s.city} shows a modeled CPCB-derived AQI of ${s.aqi} (${s.band}), led by ${s.primary?.name || 'PM2.5'}. Ask me about outdoor windows, yesterday’s trend, indoor air improvements, or CADR sizing for your ${s.profile.roomSqFt} sq.ft room.`
    : `Hello! I’m ready to analyze air quality, dispersion windows, and indoor filtration for ${s.city}. Pick any prompt above or type a specific question.`;
  return finalize(s, {
    headline: `VayuShield Coach · ${s.city}`,
    answer,
    factsUsed: [s.mkFact('Est. AQI', s.aqi, s.band, 'modeled')],
    recommendations: [s.mkRec('Check Outdoor Timing', 'Ask when the cleanest practical daytime window occurs.', 'Avoids peak stagnation periods.', 'low', 'Daytime')],
    followUpSuggestions: ['Explain my current air quality', 'Compare today vs. yesterday', 'Explain my room’s CADR']
  });
}

function buildFiltration(s) {
  const ev = s.indoorEval;
  const answer = ev
    ? `Your ${ev.dimensions.floorAreaSqFt} sq.ft room (${ev.dimensions.ceilingHeightFt} ft ceiling = ${ev.dimensions.volumeM3} m³ volume) needs ≥ ${ev.sizing.recommendedCadrM3h} m³/h CADR for ${ev.sizing.recommendedAch} ACH. At ${ev.sizing.effectiveCadrM3h} m³/h effective CADR (${ev.assumptions.filterGradeLabel}), modeled steady-state indoor PM2.5 drops from ${ev.outcomes.unfilteredIndoorPm25} to ${ev.outcomes.filteredIndoorPm25} µg/m³ (-${ev.outcomes.reductionPct}%).`
    : 'Room CADR sizing requires valid room area and ceiling height values.';
  return finalize(s, {
    headline: `Room Filtration Sizing: ${ev?.sizing?.recommendedCadrM3h ?? 'N/A'} m³/h CADR`,
    answer,
    factsUsed: ev ? [
      s.mkFact('Room Volume', ev.dimensions.volumeM3, 'm³', 'calculated'),
      s.mkFact('Target CADR', ev.sizing.recommendedCadrM3h, 'm³/h', 'calculated'),
      s.mkFact('Filtered PM2.5', ev.outcomes.filteredIndoorPm25, 'µg/m³', 'calculated')
    ] : [],
    recommendations: [
      s.mkRec('Zero-Cost Sealing', `Weather-strip door gaps to lower infiltration from ${ev?.assumptions?.infiltrationAch ?? 0.6} ACH toward 0.3 ACH.`, 'Reduces outdoor PM2.5 ingress before filtration.', 'medium', 'Continuous'),
      s.mkRec('Budget DIY HEPA/MERV-13 Box', 'Build a sealed exhaust-fan + MERV-13/HEPA box (~₹2,400, ~250–300 m³/h CADR).', 'Delivers high particle CADR at low cost.', 'high', 'Sleep & High-AQI Hours'),
      s.mkRec('Certified True H13 HEPA', `Choose a purifier rated ≥ ${ev?.sizing?.recommendedCadrM3h ?? 250} m³/h at medium/sleep speed with ionizer OFF.`, 'Avoids ozone irritation while sustaining target ACH.', 'high', 'Evening & Night')
    ],
    indoorGuidance: 'True HEPA removes particles (PM2.5/PM10) only—not gaseous NO₂, CO, or VOCs. Use outward kitchen exhaust for combustion gases.',
    assumptionsAndLimits: [s.commonLimits[0], 'Single-zone steady-state mass balance (±15% door-opening uncertainty).'],
    followUpSuggestions: ['How can I improve my indoor air?', 'What if I seal window gaps better?', 'Compare today vs. yesterday']
  });
}

function buildIndoorAir(s) {
  const ev = s.indoorEval;
  const answer = `For ${s.city} (modeled PM2.5 ${s.todayPm25 ?? 'Unavailable'} µg/m³) with your ${s.profile.cookingFuel} kitchen and ${ev?.assumptions?.leakageLabel?.toLowerCase() || 'typical'} room envelope, focus on three levers: venting cooking gases outward, closing windows during peak stagnation, and running mechanical HEPA filtration sized to ≥ ${ev?.sizing?.recommendedCadrM3h ?? 250} m³/h.`;
  return finalize(s, {
    headline: `${s.city}: Indoor Air Quality Protection Plan`,
    answer,
    factsUsed: [
      s.mkFact('Outdoor PM2.5', s.todayPm25, 'µg/m³', 'modeled'),
      s.mkFact('Unfiltered Indoor', ev?.outcomes?.unfilteredIndoorPm25 ?? null, 'µg/m³', 'calculated'),
      s.mkFact('Filtered Indoor', ev?.outcomes?.filteredIndoorPm25 ?? null, 'µg/m³', 'calculated')
    ],
    recommendations: [
      s.mkRec('Control Kitchen Emissions', s.profile.cookingFuel === 'induction' ? 'Cover pans and run kitchen exhaust during high-heat frying.' : 'Run an outward exhaust fan during LPG/solid-fuel cooking and shift boiling to an electric kettle or induction plate.', 'Combustion releases NO₂ and PM2.5 that True HEPA alone cannot fully remove.', 'high', 'During Meal Prep'),
      s.mkRec('Timed Brief Ventilation', s.disp?.bestVentilationWindow?.guidance || 'Keep windows shut during stagnation and flush briefly during cleaner midday hours.', 'Manages indoor CO₂ without importing peak smog.', 'medium', s.dayWin?.label || 'Midday'),
      s.mkRec('Mechanical True HEPA (No Ozone)', `Run ≥ ${ev?.sizing?.recommendedCadrM3h ?? 250} m³/h HEPA filtration in your main living/sleep room; avoid incense, candles, and ozone ionizers.`, 'Cuts steady-state indoor PM2.5 without generating indoor ozone.', 'high', 'Evening & Sleep')
    ],
    indoorGuidance: ev ? `Modeled steady-state indoor PM2.5 drops from ${ev.outcomes.unfilteredIndoorPm25} to ${ev.outcomes.filteredIndoorPm25} µg/m³ at ${ev.sizing.effectiveCadrM3h} m³/h effective CADR.` : 'Size mechanical HEPA filtration to 4–5 ACH.',
    followUpSuggestions: ['Explain my room’s CADR', 'When is a practical outdoor activity window?', 'What should my household do?']
  });
}

function buildOutdoorActivity(s) {
  const daylightSpan = s.disp?.daylight?.sunriseLabel && s.disp?.daylight?.sunsetLabel
    ? ` between sunrise (${s.disp.daylight.sunriseLabel}) and sunset (${s.disp.daylight.sunsetLabel})` : '';
  const overnightExplain = s.lowWin && !s.lowWin.isDaytime
    ? ` Although modeled PM2.5 dips lower overnight (${s.lowWin.label} at ${s.lowWin.avgPm25} µg/m³), overnight hours are excluded from outdoor exercise guidance for safety and sleep hygiene.` : '';
  const pmDetail = typeof s.dayWin?.avgPm25 === 'number'
    ? ` with projected PM2.5 of ${s.dayWin.avgPm25} µg/m³${s.dayWin.deltaText ? ` (${s.dayWin.deltaText})` : ''}` : '';
  const answer = s.dayWin
    ? `For ${s.city}, the cleanest practical daytime window${daylightSpan} is ${s.dayWin.label}${pmDetail}.${overnightExplain}`
    : `Daytime forecast windows are currently unavailable for ${s.city}; inspect the 24-hour dispersion bars after refreshing telemetry.`;
  return finalize(s, {
    headline: `${s.city}: Practical Daytime Outdoor Window`,
    answer,
    factsUsed: [
      s.mkFact('Daytime Window', s.dayWin?.label ?? null, typeof s.dayWin?.avgPm25 === 'number' ? `${s.dayWin.avgPm25} µg/m³` : '', 'modeled'),
      s.mkFact('Peak Risk Window', s.peakWin?.label ?? null, typeof s.peakWin?.avgPm25 === 'number' ? `${s.peakWin.avgPm25} µg/m³` : '', 'modeled')
    ],
    recommendations: [
      s.mkRec('Schedule Activity in Daylight Window', s.aqi !== null && s.aqi > 200 ? `Est. AQI is ${s.aqi} (${s.band})—move vigorous exercise indoors and use ${s.dayWin?.label || 'midday'} only for brief errands.` : `Plan light-to-moderate outdoor activity during ${s.dayWin?.label || 'well-mixed daylight hours'} away from heavy traffic.`, 'Aligns activity with deeper afternoon boundary-layer mixing.', 'high', s.dayWin?.label || 'Daytime'),
      s.mkRec('Avoid Peak Accumulation', s.peakWin ? `Minimize outdoor exposure during ${s.peakWin.label} (projected ${s.peakWin.avgPm25} µg/m³).` : 'Avoid calm early-morning and late-evening haze.', 'Low wind and shallow mixing trap near-ground emissions.', 'medium', s.peakWin?.label || 'Evening')
    ],
    indoorGuidance: 'Keep exterior doors closed outside your chosen daytime ventilation window.',
    followUpSuggestions: ['How can I improve my indoor air?', 'What is driving pollution?', 'Explain forecast uncertainty']
  });
}

function buildForecast(s) {
  const diff = s.todayPm25 !== null && s.yestPm25 !== null ? Number((s.todayPm25 - s.yestPm25).toFixed(1)) : null;
  const answer = diff !== null
    ? `In ${s.city}, the current 24-hour rolling PM2.5 mean is ${s.todayPm25} µg/m³ versus yesterday’s ${s.yestPm25} µg/m³ (${diff >= 0 ? '+' : ''}${diff} µg/m³ — ${diff < 0 ? 'cleaner than yesterday' : diff > 0 ? 'higher than yesterday' : 'unchanged'}). Over the next 6 hours, dispersion forecasts indicate a ${s.disp?.trend || 'unavailable'} trend (${s.disp?.trendDeltaPct ?? 'N/A'}%).`
    : `In ${s.city}, current 24-hour PM2.5 is ${s.todayPm25 ?? 'Unavailable'} µg/m³; yesterday’s full 24-hour baseline was unavailable in this fetch. Next 6-hour modeled trend: ${s.disp?.trend || 'unavailable'}. Note that modeled ${s.resLabel} grids smooth out sharp street-level spikes.`;
  return finalize(s, {
    headline: `${s.city}: Trend, Yesterday Comparison & Uncertainty`,
    answer,
    factsUsed: [
      s.mkFact('Today 24h PM2.5', s.todayPm25, 'µg/m³', 'modeled'),
      s.mkFact('Yesterday 24h PM2.5', s.yestPm25, 'µg/m³', 'modeled'),
      s.mkFact('6h Forecast Trend', s.disp?.trend ?? null, typeof s.disp?.trendDeltaPct === 'number' ? `${s.disp.trendDeltaPct}%` : '', 'modeled')
    ],
    recommendations: [
      s.mkRec('Plan Around Daylight Mixing', s.dayWin ? `Use ${s.dayWin.label} (projected ${s.dayWin.avgPm25} µg/m³) for essential errands.` : 'Check hourly forecast updates before planning outdoor activity.', 'Accounts for projected dispersion changes.', 'medium', s.dayWin?.label || 'Daytime'),
      s.mkRec('Cross-Check Local Stations', 'Verify severe local smoke or roadside haze against an official CPCB CAAQMS monitor.', `CAMS ${s.resLabel} cells average across wide urban areas.`, 'low', 'Ongoing')
    ],
    indoorGuidance: 'Run filtration proactively ahead of worsening evening trends.',
    followUpSuggestions: ['What is driving pollution?', 'Practical outdoor window', 'What should my household do?']
  });
}

function buildDispersion(s) {
  const blh = typeof s.firstHr?.blh === 'number' ? s.firstHr.blh : null;
  const wind = s.intel?.current?.windKmh ?? s.firstHr?.windKmh ?? null;
  const vc = typeof s.firstHr?.vc === 'number' ? s.firstHr.vc : null;
  const answer = `Air quality in ${s.city} (Est. AQI ${s.aqi ?? 'Unavailable'}, ${s.band}) is primarily driven by ${s.primary ? `${s.primary.name} (${s.primary.concentration} ${s.primary.unit}, ${s.primary.averaging} mean)` : 'unavailable primary pollutant data'}. Current modeled boundary-layer height is ${blh !== null ? `${blh} m` : 'unavailable'} with 10m wind of ${wind !== null ? `${wind} km/h` : 'unavailable'}, yielding a Ventilation Coefficient of ${vc !== null ? `${vc.toLocaleString('en-IN')} m²/s` : 'unavailable'} (${s.firstHr?.dispersionCategory || s.disp?.classification || 'stagnation risk estimate'}).`;
  return finalize(s, {
    headline: `${s.city}: Pollution Drivers & Dispersion`,
    answer,
    factsUsed: [
      s.mkFact('Primary Driver', s.primary?.concentration ?? null, s.primary ? `${s.primary.name} ${s.primary.unit}` : '', 'modeled'),
      s.mkFact('Boundary Layer', blh, 'm', 'modeled'),
      s.mkFact('Ventilation Coeff.', vc, 'm²/s', 'calculated')
    ],
    recommendations: [
      s.mkRec('Close Up During Stagnation', 'Keep windows closed when Ventilation Coefficient drops below 2,000 m²/s.', 'Shallow mixing traps traffic and combustion plumes near ground level.', 'high', s.peakWin?.label || 'Evening'),
      s.mkRec('Flush During Thermal Mixing', s.dayWin ? `Brief cross-ventilation works best around ${s.dayWin.label}.` : 'Ventilate briefly during breezy afternoon hours.', 'Deeper mixing dilutes surface pollutants.', 'medium', s.dayWin?.label || 'Afternoon')
    ],
    indoorGuidance: 'Stagnation risk is derived from modeled BLH × wind speed—not confirmed radiosonde temperature inversion data.',
    followUpSuggestions: ['Practical outdoor window', 'Compare today vs. yesterday', 'Improve indoor air']
  });
}

function buildHousehold(s) {
  const answer = `For your ${s.profile.householdProfile} household in ${s.city} (Est. AQI ${s.aqi ?? 'Unavailable'}, ${s.band}) and ${s.profile.dailyCommuteKm} km ${s.profile.commuteMode} commute: ${s.aqi !== null && s.aqi > 150 ? 'wear a tight-seal N95/FFP2 respirator along traffic corridors, keep indoor spaces sealed during evening wind drops, and run mechanical HEPA filtration.' : 'pace prolonged roadside exertion, ventilate cooking fumes outward, and monitor evening dispersion changes.'}`;
  return finalize(s, {
    headline: `${s.city}: Household & Commute Guidance`,
    answer,
    factsUsed: [
      s.mkFact('Est. AQI', s.aqi, s.band, 'modeled'),
      s.mkFact('Commute', s.profile.dailyCommuteKm, `km (${s.profile.commuteMode})`, 'estimated')
    ],
    recommendations: [
      s.mkRec('Commute Protection', s.profile.commuteMode === 'car' ? 'Use cabin Recirculate in congested traffic and flush briefly every 20–30 min.' : 'Keep a well-fitted N95/FFP2 respirator ready on traffic corridors and avoid idling behind diesel exhaust.', 'Roadside PM2.5 and NO₂ spike well above regional grid averages.', 'high', 'Commute Hours'),
      s.mkRec('Evening Indoor Recovery', `Close windows before sunset and target ≥ ${s.indoorEval?.sizing?.recommendedCadrM3h ?? 250} m³/h HEPA CADR in bedrooms.`, 'Counters nocturnal boundary-layer compression.', 'medium', 'Evening & Night')
    ],
    indoorGuidance: 'Maintain one well-sealed, filtered room for children, older adults, or respiratory-sensitive family members.',
    followUpSuggestions: ['Explain my room’s CADR', 'Improve indoor air', 'Practical outdoor window']
  });
}

function buildDefaultAqi(s) {
  const subIdxText = s.primary && s.primary.subIndex != null ? `, sub-index ${s.primary.subIndex}` : '';
  const avgText = s.primary?.averaging ? `${s.primary.averaging} rolling mean` : 'rolling mean';
  const winText = s.dayWin
    ? ` Best practical daytime window: ${s.dayWin.label}${typeof s.dayWin.avgPm25 === 'number' ? ` (projected ${s.dayWin.avgPm25} µg/m³)` : ''}.` : '';
  const answer = s.aqi !== null
    ? `${s.city} currently has a modeled CPCB-derived AQI estimate of ${s.aqi} (${s.band}), driven by ${s.primary ? `${s.primary.name} at ${s.primary.concentration} ${s.primary.unit} (${avgText}${subIdxText})` : 'available particulate readings'}.${winText} This figure is computed from ${s.resLabel} modeled data—not an official ground CPCB CAAQMS monitor—so nearby roadside areas may read higher.`
    : `Pollutant data for ${s.city} is currently incomplete, so a valid CPCB-derived AQI cannot be reported without fabricating missing values.`;
  return finalize(s, {
    headline: s.aqi !== null ? `${s.city}: Est. AQI ${s.aqi} (${s.band}) Explained` : `${s.city}: Incomplete Telemetry`,
    answer,
    factsUsed: [
      s.mkFact('Est. AQI', s.aqi, s.band, 'modeled'),
      s.mkFact(s.primary?.name || 'PM2.5', s.primary?.concentration ?? s.todayPm25, s.primary?.unit || 'µg/m³', 'modeled')
    ],
    recommendations: [
      s.mkRec('Adjust Outdoor Effort', s.aqi !== null && s.aqi > 200 ? 'Shift workouts indoors and wear a fitted N95 for essential trips.' : 'Pace sustained exertion near busy roads.', 'Matches CPCB band guidance without overstating certainty.', 'high', 'Today'),
      s.mkRec('Use Practical Daytime Window', s.dayWin ? `Cleanest practical daylight period is ${s.dayWin.label} (projected ${s.dayWin.avgPm25} µg/m³).` : 'Check dispersion forecast once refreshed.', 'Optimizes timing around atmospheric mixing.', 'medium', s.dayWin?.label || 'Daytime')
    ],
    indoorGuidance: s.indoorEval
      ? `Target ≥ ${s.indoorEval.sizing.recommendedCadrM3h} m³/h True HEPA CADR for your ${s.indoorEval.dimensions.floorAreaSqFt} sq.ft room (ionizer OFF).`
      : 'Run mechanical True HEPA filtration when outdoor haze rises.',
    followUpSuggestions: ['What is driving pollution?', 'Compare today vs. yesterday', 'Improve indoor air']
  });
}

const INTENT_BUILDERS = Object.freeze({
  greeting: buildGreeting,
  'filtration-cadr': buildFiltration,
  'indoor-air': buildIndoorAir,
  'outdoor-activity': buildOutdoorActivity,
  'forecast-interpretation': buildForecast,
  'atmospheric-dispersion': buildDispersion,
  'pollution-causes': buildDispersion,
  'commute-protection': buildHousehold,
  'household-advice': buildHousehold
});

/**
 * Generates a deterministic, telemetry-grounded fallback response clearly labeled Offline Mode.
 * @param {string} question
 * @param {Record<string, any> | null} intel
 * @param {Record<string, any> | null} rawProfile
 * @param {Record<string, any> | null} indoorEval
 * @param {string | { diagnosticCode?: string, history?: Array<any> }} [options={}]
 * @returns {Record<string, any>}
 */
export function buildGroundedFallback(question, intel, rawProfile, indoorEval, options = {}) {
  const diagnosticCode = typeof options === 'string' ? options : (options.diagnosticCode || null);
  const history = Array.isArray(options?.history) ? options.history : [];
  const cleanQ = sanitizeText(question, 360);
  const intent = classifyCoachIntent(cleanQ, history.length);
  const snapshot = createSnapshot(intel, rawProfile, indoorEval, diagnosticCode, intent);
  const builder = INTENT_BUILDERS[intent] || buildDefaultAqi;
  return builder(snapshot);
}