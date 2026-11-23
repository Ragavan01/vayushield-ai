/**
 * @fileoverview VayuShield AI Coach client.
 * - Forwards full telemetry, yesterday's 24h average, dispersion metrics, and room physics
 *   to `/api/gemini` without ever coercing missing values to zero.
 * - Provides an Intent-Routed Deterministic Grounded Engine so even if the server proxy is
 *   offline or unconfigured, every prompt ("hi", "Compare today vs. yesterday", "Best outdoor window",
 *   "Room CADR", etc.) receives a distinct, tailored answer instead of identical boilerplate.
 */

import { normalizeProfile } from '../core/impactModel.js';
import { sanitizeText } from '../core/security.js';

const CLIENT_TIMEOUT_MS = 15_000;

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

function detectQuestionIntent(q) {
  const lower = String(q || '').toLowerCase().trim();
  if (/^(hi|hello|hey|yo|good morning|good evening|namaste|vanakkam|help|\?)[!. ]*$/.test(lower) || lower.length <= 4) {
    return 'greeting';
  }
  if (/yesterday|compare|trend|worse|better|improv/.test(lower)) {
    return 'compare-yesterday';
  }
  if (/window|outdoor|walk|run|exercise|ventilat|night|overnight|sunrise|sunset|when/.test(lower)) {
    return 'daytime-window';
  }
  if (/cadr|ach|room|volume|purifier|hepa|merv|sizing|capacity|sqft|sq\.ft/.test(lower)) {
    return 'room-cadr';
  }
  if (/indoor|kitchen|cook|lpg|induction|chimney|seal|house|home/.test(lower)) {
    return 'improve-indoor';
  }
  if (/caus|driver|wind|boundary|blh|stagnat|inversion|dispersion|why/.test(lower)) {
    return 'pollution-drivers';
  }
  if (/commute|mask|n95|bike|two-wheeler|car|travel|school/.test(lower)) {
    return 'commute';
  }
  return 'explain-aqi';
}

export function buildGroundedFallback(question, intel, rawProfile, indoorEval, diagnosticCode = null) {
  const profile = normalizeProfile(rawProfile);
  const city = intel?.location?.name || 'Selected Location';
  const aqi = intel?.cpcb?.aqi ?? null;
  const band = intel?.cpcb?.band?.label || 'Unavailable';
  const primary = intel?.cpcb?.primaryPollutant;
  const todayPm25 = intel?.rollingAverages?.pm25_24h ?? null;
  const yestPm25 = intel?.rollingAverages?.yesterdayPm25_24h ?? null;
  const disp = intel?.dispersion;
  const firstHr = disp?.hourly?.[0];
  const dayWin = disp?.available ? disp.bestDaytimeWindow : null;
  const lowWin = disp?.available ? disp.lowestPollutionWindow : null;
  const peakWin = disp?.available ? disp.peakAccumulationWindow : null;
  const cleanQ = sanitizeText(question, 240);
  const intent = detectQuestionIntent(cleanQ);

  const engineLabel = diagnosticCode
    ? `VayuShield Grounded Engine (${diagnosticCode})`
    : 'VayuShield Grounded Engine (Offline Fallback)';

  const commonLimit = `Modeled ${intel?.metadata?.gridResolution || '~40 km'} grid data (not a ground CPCB station; NH₃ & Pb unavailable). Informational only, not medical advice.`;

  if (intent === 'greeting') {
    return {
      engine: engineLabel,
      isFallback: true,
      headline: `VayuShield Assistant · ${city}`,
      directAnswer: aqi !== null
        ? `Hello! Right now ${city} has a modeled CPCB-derived AQI of ${aqi} (${band}), driven primarily by ${primary?.name || 'PM2.5'}. Ask me about today’s vs. yesterday’s trend, the safest daytime window for outdoor activity, or CADR sizing for your ${profile.roomSqFt} sq.ft room.`
        : `Hello! I’m ready to analyze air quality, atmospheric dispersion, and room filtration for ${city}. Select any suggested question above or ask about outdoor windows, commute protection, or purifier sizing.`,
      recommendations: [
        'Tap "Compare today vs. yesterday" to check 24-hour PM2.5 direction.',
        'Tap "When is outdoor activity most practical?" for sunrise-to-sunset scheduling.',
        'Tap "What filtration capacity does my room need?" for CADR math.'
      ],
      factsUsed: [
        aqi !== null ? `${city} Est. AQI ${aqi} (${band}) · Valid ${intel?.current?.timestamp || 'now'}` : `${city} telemetry active`
      ],
      indoorGuidance: '',
      assumptionsAndLimits: [commonLimit]
    };
  }

  if (intent === 'compare-yesterday') {
    const diff = todayPm25 !== null && yestPm25 !== null ? Number((todayPm25 - yestPm25).toFixed(1)) : null;
    const directAnswer = diff !== null
      ? `In ${city}, the current 24-hour rolling PM2.5 mean is ${todayPm25} µg/m³ compared with ${yestPm25} µg/m³ over the prior 24-hour period—a change of ${diff >= 0 ? '+' : ''}${diff} µg/m³ (${diff < 0 ? 'cleaner than yesterday' : diff > 0 ? 'higher than yesterday' : 'unchanged'}). Over the next 6 hours, dispersion modeling projects a ${disp?.trend || 'steady'} trend (${disp?.trendDeltaPct >= 0 ? '+' : ''}${disp?.trendDeltaPct ?? 0}%).`
      : `Current 24-hour rolling PM2.5 in ${city} is ${todayPm25 !== null ? `${todayPm25} µg/m³` : 'unavailable'}, while a full prior-24h baseline was unavailable in this fetch. Over the next 6 hours, modeled PM2.5 is ${disp?.trend || 'steady'} (${disp?.trendDeltaPct >= 0 ? '+' : ''}${disp?.trendDeltaPct ?? 0}%).`;

    return {
      engine: engineLabel,
      isFallback: true,
      headline: `${city}: Today vs. Yesterday PM2.5 Trend`,
      directAnswer,
      recommendations: [
        dayWin
          ? `Plan unavoidable daytime errands during ${dayWin.label} (Projected PM2.5: ${dayWin.avgPm25} µg/m³).`
          : 'Monitor hourly updates before scheduling outdoor exertion.',
        peakWin
          ? `Keep windows sealed during the peak accumulation window (${peakWin.label}, projected ${peakWin.avgPm25} µg/m³).`
          : 'Close exterior openings during evening wind drops.'
      ],
      factsUsed: [
        `Today 24h PM2.5: ${todayPm25 ?? 'N/A'} µg/m³ · Yesterday 24h PM2.5: ${yestPm25 ?? 'N/A'} µg/m³`,
        `Next 6h modeled trend: ${disp?.trend || 'unavailable'} (${disp?.trendDeltaPct ?? 0}%)`
      ],
      indoorGuidance: directAnswer,
      assumptionsAndLimits: [commonLimit]
    };
  }

  if (intent === 'daytime-window') {
    const overnightExplain = lowWin && !lowWin.isDaytime
      ? ` While the absolute lowest concentration occurs overnight (${lowWin.label} at ${lowWin.avgPm25} µg/m³), VayuShield excludes overnight hours from exercise recommendations due to darkness, safety, and sleep recovery.`
      : '';
    const directAnswer = dayWin
      ? `For ${city}, the best practical daytime window between sunrise (${disp.daylight.sunriseLabel}) and sunset (${disp.daylight.sunsetLabel}) is ${dayWin.label}, with projected PM2.5 of ${dayWin.avgPm25} µg/m³ (${dayWin.deltaText}).${overnightExplain}`
      : `Daytime forecast windows are currently unavailable for ${city}; check the 24-hour dispersion bar chart once telemetry refreshes.`;

    return {
      engine: engineLabel,
      isFallback: true,
      headline: `${city}: Practical Daytime Activity & Ventilation Window`,
      directAnswer,
      recommendations: [
        disp?.bestVentilationWindow?.guidance || 'Limit open-window flushing to 10–15 minutes during afternoon mixing.',
        aqi !== null && aqi > 200
          ? `Because AQI is ${aqi} (${band}), keep vigorous cardio indoors even during ${dayWin?.label || 'midday'}.`
          : `Use ${dayWin?.label || 'midday hours'} for light-to-moderate outdoor activity away from heavy traffic.`
      ],
      factsUsed: [
        dayWin ? `Daytime window ${dayWin.label}: Projected ${dayWin.avgPm25} µg/m³ · Ventilation Coeff. ${dayWin.avgVc ?? 'N/A'} m²/s` : 'Daytime window pending',
        peakWin ? `Peak accumulation risk: ${peakWin.label} (${peakWin.avgPm25} µg/m³)` : 'Peak window pending'
      ],
      indoorGuidance: directAnswer,
      assumptionsAndLimits: [commonLimit]
    };
  }

  if (intent === 'room-cadr') {
    const directAnswer = indoorEval
      ? `Your ${indoorEval.dimensions.floorAreaSqFt} sq.ft room (${indoorEval.dimensions.ceilingHeightFt} ft ceiling = ${indoorEval.dimensions.volumeM3} m³ volume) requires a target CADR of ≥ ${indoorEval.sizing.recommendedCadrM3h} m³/h to achieve ${indoorEval.sizing.recommendedAch} air changes per hour (ACH). At ${indoorEval.sizing.effectiveCadrM3h} m³/h effective CADR (${indoorEval.assumptions.filterGradeLabel}), steady-state indoor PM2.5 drops from ${indoorEval.outcomes.unfilteredIndoorPm25} µg/m³ to ${indoorEval.outcomes.filteredIndoorPm25} µg/m³ (-${indoorEval.outcomes.reductionPct}%).`
      : 'Room filtration sizing requires room area and ceiling height parameters.';

    return {
      engine: engineLabel,
      isFallback: true,
      headline: `Room Filtration Sizing: ${indoorEval?.sizing?.recommendedCadrM3h || 250} m³/h Target CADR`,
      directAnswer,
      recommendations: [
        `Zero-cost step: Weather-strip door gaps to cut infiltration from ${indoorEval?.assumptions?.infiltrationAch ?? 0.6} ACH toward 0.3 ACH.`,
        `Budget DIY option (~₹2,400/unit): A sealed exhaust-fan + MERV-13/HEPA box delivers ~250–300 m³/h effective CADR.`,
        `Commercial option: Choose a certified True H13 HEPA unit rated ≥ ${indoorEval?.sizing?.recommendedCadrM3h || 250} m³/h at medium/sleep speed with ionizer OFF.`
      ],
      factsUsed: [
        indoorEval ? `Volume ${indoorEval.dimensions.volumeM3} m³ × ${indoorEval.sizing.recommendedAch} ACH = ${indoorEval.sizing.recommendedCadrM3h} m³/h CADR` : 'Room volume active',
        indoorEval ? `Steady-state PM2.5: ${indoorEval.outcomes.unfilteredIndoorPm25} -> ${indoorEval.outcomes.filteredIndoorPm25} µg/m³ (±15%)` : 'Mass-balance model'
      ],
      indoorGuidance: directAnswer,
      assumptionsAndLimits: ['True HEPA removes particles (PM2.5/PM10) only—not gaseous NO₂ or VOCs. Assumes well-mixed single zone (±15%).']
    };
  }

  if (intent === 'improve-indoor' || intent === 'commute') {
    const directAnswer = intent === 'commute'
      ? `For your ${profile.dailyCommuteKm} km ${profile.commuteMode} commute in ${city} (Est. AQI ${aqi ?? 'N/A'}), ${aqi !== null && aqi > 150 ? 'wear a tight-seal N95/FFP2 respirator along traffic corridors and avoid idling behind diesel vehicles.' : 'standard precautions apply, though keeping a fitted N95 handy for congested intersections reduces peak roadside exposure.'}`
      : `With a ${profile.cookingFuel} kitchen setup and ${indoorEval?.assumptions?.leakageLabel?.toLowerCase() || 'typical'} envelope in ${city}, indoor air quality depends on sealing outdoor infiltration during peak haze, venting cooking combustion gases, and running ≥ ${indoorEval?.sizing?.recommendedCadrM3h || 250} m³/h mechanical HEPA filtration.`;

    return {
      engine: engineLabel,
      isFallback: true,
      headline: intent === 'commute' ? `${city}: Commute Exposure Protection` : `${city}: Indoor Air Quality Action Plan`,
      directAnswer,
      recommendations: [
        profile.cookingFuel === 'induction'
          ? 'Use pan lids and kitchen exhaust during high-heat frying to capture cooking aerosols.'
          : 'Run an outward kitchen exhaust fan during LPG/solid-fuel cooking and shift boiling/simmering to electric appliances to prevent NO₂ buildup.',
        `Operate True HEPA filtration at ≥ ${indoorEval?.sizing?.recommendedCadrM3h || 250} m³/h in your primary living/sleeping room (keep ozone/ionizer modes OFF).`,
        'Avoid indoor incense, candles, and mosquito coils on Moderate-to-Severe AQI days.'
      ],
      factsUsed: [
        `Kitchen: ${profile.cookingFuel} · Commute: ${profile.dailyCommuteKm} km (${profile.commuteMode})`,
        indoorEval ? `Filtered indoor PM2.5 estimate: ${indoorEval.outcomes.filteredIndoorPm25} µg/m³ vs ${indoorEval.outcomes.unfilteredIndoorPm25} µg/m³ unfiltered` : 'Indoor mass balance'
      ],
      indoorGuidance: directAnswer,
      assumptionsAndLimits: [commonLimit]
    };
  }

  if (intent === 'pollution-drivers') {
    const blhText = typeof firstHr?.blh === 'number' ? `${firstHr.blh} m` : 'unavailable';
    const windText = typeof firstHr?.windKmh === 'number' ? `${firstHr.windKmh} km/h ${firstHr.windCompass || ''}`.trim() : 'unavailable';
    const vcText = typeof firstHr?.vc === 'number' ? `${firstHr.vc.toLocaleString('en-IN')} m²/s` : 'unavailable';

    const directAnswer = `Today’s AQI in ${city} (${aqi ?? 'N/A'}, ${band}) is driven primarily by ${primary ? `${primary.name} (${primary.concentration} ${primary.unit}, ${primary.averaging} mean)` : 'fine particulates'}. Surface meteorology shows a modeled boundary-layer height of ${blhText} and 10m wind of ${windText}, yielding a Ventilation Coefficient of ${vcText} (${firstHr?.dispersionCategory || disp?.classification || 'limited dispersion'}).`;

    return {
      engine: engineLabel,
      isFallback: true,
      headline: `${city}: Pollution Drivers & Boundary-Layer Dispersion`,
      directAnswer,
      recommendations: [
        'Low Ventilation Coefficients (< 2,000 m²/s) trap traffic and combustion emissions near ground level—keep windows closed during stagnant hours.',
        dayWin
          ? `Wait for afternoon boundary-layer growth (${dayWin.label}, projected ${dayWin.avgPm25} µg/m³) for brief ventilation.`
          : 'Flush indoor air briefly only during afternoon thermal mixing.'
      ],
      factsUsed: [
        `Primary driver: ${primary ? `${primary.name} ${primary.concentration} ${primary.unit} (SI ${primary.subIndex})` : 'N/A'}`,
        `BLH ${blhText} · Wind ${windText} · VC ${vcText}`
      ],
      indoorGuidance: directAnswer,
      assumptionsAndLimits: ['Stagnation risk is inferred from modeled BLH × wind speed, not confirmed radiosonde vertical temperature profiles.']
    };
  }

  // Default: explain-aqi
  const directAnswer = aqi !== null
    ? `${city} currently has a CPCB-derived modeled AQI of ${aqi} (${band}), driven by ${primary ? `${primary.name} at ${primary.concentration} ${primary.unit} (${primary.averaging} rolling average, sub-index ${primary.subIndex})` : 'particulate matter'}. Because this comes from the Copernicus CAMS atmospheric grid (${intel?.metadata?.gridResolution || '~40 km'}) rather than a roadside CAAQMS sensor, local traffic corridors may read higher.`
    : `Telemetry for ${city} is currently incomplete, so a reliable CPCB-derived AQI cannot be computed without fabricating missing data.`;

  return {
    engine: engineLabel,
    isFallback: true,
    headline: aqi !== null ? `${city}: Est. AQI ${aqi} (${band}) Explained` : `${city}: Telemetry Incomplete`,
    directAnswer,
    recommendations: [
      aqi !== null && aqi > 200
        ? 'Minimize prolonged outdoor exertion, wear a fitted N95 mask in traffic, and run True HEPA filtration indoors.'
        : 'Pace prolonged outdoor exertion near heavy traffic and monitor evening dispersion changes.',
      dayWin
        ? `Best practical daytime window is ${dayWin.label} (Projected PM2.5: ${dayWin.avgPm25} µg/m³).`
        : 'Check hourly forecast bars for cleaner afternoon mixing.'
    ],
    factsUsed: [
      `Valid ${intel?.current?.timestamp || 'now'} · ${intel?.metadata?.sourceType || 'Modeled Grid'} (${intel?.metadata?.gridResolution || '~40 km'})`,
      primary ? `Primary sub-index: ${primary.name} = ${primary.subIndex} (${primary.concentration} ${primary.unit})` : 'Sub-index incomplete'
    ],
    indoorGuidance: directAnswer,
    assumptionsAndLimits: [commonLimit]
  };
}

export async function askVayuShieldCoach(params, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const profile = normalizeProfile(params.profile);
  const intel = params.intel;
  const indoorEval = params.indoorEval;
  const question = sanitizeText(params.question, 360) || COACH_PROMPT_TEMPLATES[0].prompt;

  if (!intel || !intel.location) {
    return buildGroundedFallback(question, intel, profile, indoorEval, 'NO_TELEMETRY');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);
  const firstHr = intel.dispersion?.hourly?.[0];

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
        blh: firstHr?.blh ?? null,
        windKmh: intel.current?.windKmh ?? firstHr?.windKmh ?? null,
        vc: firstHr?.vc ?? null,
        trend: intel.dispersion?.trend ?? 'unavailable',
        bestWindow: intel.dispersion?.bestDaytimeWindow?.label ?? 'Unavailable',
        bestWindowPm25: intel.dispersion?.bestDaytimeWindow?.avgPm25 ?? null,
        peakWindow: intel.dispersion?.peakAccumulationWindow?.label ?? 'Unavailable',
        householdProfile: profile.householdProfile,
        commuteMode: profile.commuteMode,
        dailyCommuteKm: profile.dailyCommuteKm,
        roomSqFt: profile.roomSqFt,
        roomVolumeM3: indoorEval?.dimensions?.volumeM3 ?? null,
        recommendedCadr: indoorEval?.sizing?.recommendedCadrM3h ?? null,
        unfilteredIndoorPm25: indoorEval?.outcomes?.unfilteredIndoorPm25 ?? null,
        filteredIndoorPm25: indoorEval?.outcomes?.filteredIndoorPm25 ?? null,
        cookingFuel: profile.cookingFuel
      })
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || !payload.headline || !Array.isArray(payload.recommendations)) {
      const code = payload?.diagnosticCode || `HTTP_${response.status}`;
      return buildGroundedFallback(question, intel, profile, indoorEval, code);
    }

    return { ...payload, isFallback: false };
  } catch (err) {
    const code = err?.name === 'AbortError' ? 'CLIENT_TIMEOUT' : 'NETWORK_UNAVAILABLE';
    return buildGroundedFallback(question, intel, profile, indoorEval, code);
  } finally {
    clearTimeout(timer);
  }
}