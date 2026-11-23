/**
 * @fileoverview VayuShield AI Coach Client Service (Project ORACLE).
 * - Builds strictly validated nested environmental context preserving null values
 * - Manages session-level multi-turn conversation history with automatic location-change reset
 * - Classifies user prompts into 13 environmental intents without keyword collisions
 * - Supports AbortSignal cancellation (Stop Generation) and clean offline fallback metadata
 */

import { normalizeProfile } from '../core/impactModel.js';
import { sanitizeText } from '../core/security.js';

const CLIENT_TIMEOUT_MS = 18_000;
const MAX_STORED_TURNS = 10;
const MAX_SENT_HISTORY_MESSAGES = 6;

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

/**
 * Classifies a user prompt into 1 of 13 structured intents with deterministic priority
 * (prevents "improve indoor air" or "compare DIY vs H13 CADR" from being misrouted to yesterday trends).
 */
export function classifyCoachIntent(question, historyLength = 0) {
  const lower = String(question || '').toLowerCase().trim();

  if (/^(hi|hello|hey|yo|namaste|vanakkam|good morning|good evening|help|\?)[!., ]*$/.test(lower) || lower.length <= 4) {
    return 'greeting';
  }
  if (/\b(cadr|ach|purifier|hepa|merv|filter|filtration|sizing|capacity|room volume|bigger purifier|diy box)\b/.test(lower)) {
    return 'filtration-cadr';
  }
  if (/\b(commute|mask|n95|ffp2|kf94|two-wheeler|scooter|bike|car|metro|bus|school run|roadside)\b/.test(lower)) {
    return 'commute-protection';
  }
  if (/\b(outdoor|outside|walk|jog|run|exercise|workout|sport|daytime window|practical.*window|overnight|sunrise|sunset)\b/.test(lower)) {
    return 'outdoor-activity';
  }
  if (/\b(indoors?|inside|open .*window|windows|ventilat|kitchen|cook|lpg|induction|chimney|seal|incense|room air)\b/.test(lower)) {
    return 'indoor-air';
  }
  if (/\b(yesterday|tomorrow|next 6|6-hour|6h|getting better|getting worse|is the air improving|trend|forecast|uncertaint|confidence|limitation)\b/.test(lower)) {
    return 'forecast-interpretation';
  }
  if (/\b(dispersion|boundary[- ]?layer|\bblh\b|ventilation coefficient|\bvc\b|stagnation|inversion|wind|mixing)\b/.test(lower)) {
    return 'atmospheric-dispersion';
  }
  if (/\b(causing|causes|driving|driver|why is aqi|why is pollution|source of)\b/.test(lower)) {
    return 'pollution-causes';
  }
  if (/\b(pm2\.?5|pm10|no2|so2|ozone|\bo3\b|\bco\b|nh3|lead|\bpb\b|who 2021|sub-index)\b/.test(lower)) {
    return 'pollutant-analysis';
  }
  if (/\b(co2|carbon|emissions|savings|carpool|sustainable|impact simulator)\b/.test(lower)) {
    return 'environmental-impact';
  }
  if (/\b(household|family|kids|children|senior|elderly|asthma|what should .* do|routine)\b/.test(lower)) {
    return 'household-advice';
  }
  if (/\b(aqi|air quality|index|bad|safe|severe|poor|moderate|good|satisfactory|calculation|methodology|modeled)\b/.test(lower)) {
    return 'aqi-explanation';
  }
  if (historyLength > 0 && /\b(it|its|that|those|them|simpler|simple terms|explain more|what if|how about|why|elaborate)\b/.test(lower)) {
    return 'follow-up';
  }
  return 'general-education';
}

/**
 * Builds the full nested ORACLE environmental context object preserving nulls and provenance.
 */
export function buildCoachContextPayload(intel, rawProfile, indoorEval) {
  const profile = normalizeProfile(rawProfile);
  const firstHr = intel?.dispersion?.hourly?.[0] || null;
  const disp = intel?.dispersion || null;
  const dispOk = Boolean(disp && disp.available !== false);
  const dayWin = dispOk ? (disp.bestDaytimeWindow || disp.bestOutdoorWindow || null) : null;
  const lowWin = dispOk ? (disp.lowestPollutionWindow || null) : null;
  const peakWin = dispOk ? (disp.peakAccumulationWindow || null) : null;

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
    atmospheric: {
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
    },
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
    indoorPhysics: indoorEval
      ? {
          roomVolumeM3: indoorEval.dimensions.volumeM3,
          recommendedCadrM3h: indoorEval.sizing.recommendedCadrM3h,
          effectiveCadrM3h: indoorEval.sizing.effectiveCadrM3h,
          targetAch: indoorEval.sizing.recommendedAch,
          filterGrade: indoorEval.assumptions.filterGradeLabel,
          unfilteredIndoorPm25: indoorEval.outcomes.unfilteredIndoorPm25,
          filteredIndoorPm25: indoorEval.outcomes.filteredIndoorPm25,
          assumptions: indoorEval.safetyNotes?.[0] || null
        }
      : null
  };
}

/**
 * Session-level Conversation Manager (in-memory only; never persists private chat to localStorage).
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
      return true; // Reset occurred
    }
    locationKey = nextKey;
    return false;
  }

  function reset() {
    turns = [];
    olderSummary = '';
  }

  function addExchange(question, answerText, intent) {
    turns.push({
      question: sanitizeText(question, 360),
      answer: sanitizeText(answerText, 600),
      intent
    });
    if (turns.length > MAX_STORED_TURNS) {
      const evicted = turns.shift();
      const snippet = `Earlier discussed ${evicted.intent}: "${evicted.question.slice(0, 70)}".`;
      olderSummary = `${olderSummary} ${snippet}`.trim().slice(-380);
    }
  }

  function exportHistoryPayload() {
    const recent = turns.slice(-Math.floor(MAX_SENT_HISTORY_MESSAGES / 2));
    const history = [];
    for (const t of recent) {
      history.push({ role: 'user', text: t.question });
      history.push({ role: 'model', text: t.answer });
    }
    return { history, historySummary: olderSummary };
  }

  return {
    setLocation,
    reset,
    addExchange,
    exportHistoryPayload,
    getTurnCount: () => turns.length
  };
}

/**
 * Deterministic Grounded Fallback Engine (clearly marked Offline Mode; never claims Gemini ran).
 */
export function buildGroundedFallback(question, intel, rawProfile, indoorEval, options = {}) {
  const diagnosticCode = typeof options === 'string' ? options : (options.diagnosticCode || null);
  const history = Array.isArray(options?.history) ? options.history : [];
  const profile = normalizeProfile(rawProfile);
  const city = intel?.location?.name || 'Selected Location';
  const aqi = intel?.cpcb?.aqi ?? null;
  const band = intel?.cpcb?.band?.label || 'Unavailable';
  const primary = intel?.cpcb?.primaryPollutant || null;
  const todayPm25 = intel?.rollingAverages?.pm25_24h ?? intel?.current?.pm25 ?? null;
  const yestPm25 = intel?.rollingAverages?.yesterdayPm25_24h ?? null;
  const disp = intel?.dispersion;
  const dispOk = Boolean(disp && disp.available !== false);
  const firstHr = disp?.hourly?.[0] || null;
  const dayWin = dispOk ? (disp.bestDaytimeWindow || disp.bestOutdoorWindow || null) : null;
  const lowWin = dispOk ? (disp.lowestPollutionWindow || null) : null;
  const peakWin = dispOk ? (disp.peakAccumulationWindow || null) : null;
  const ts = intel?.current?.timestamp || null;
  const resLabel = intel?.metadata?.gridResolution || '~40 km CAMS grid';

  const cleanQ = sanitizeText(question, 360);
  const intent = classifyCoachIntent(cleanQ, history.length);

  const mkFact = (label, value, unit = '', sourceType = 'modeled') => ({
    label,
    value: value === null || value === undefined ? null : value,
    unit,
    sourceType: value === null || value === undefined ? 'unavailable' : sourceType,
    timestamp: ts
  });

  const mkRec = (title, description, reason, priority = 'medium', timeWindow = 'Today') => ({
    title,
    description,
    reason,
    priority,
    timeWindow
  });

  const commonLimits = [
    `Offline grounded response (${diagnosticCode || 'API_UNAVAILABLE'}): generated deterministically without Gemini.`,
    `Modeled ${resLabel} telemetry (not a direct CPCB ground station; NH₃ & Pb unavailable). Informational only, not medical advice.`
  ];

  const baseMeta = {
    provider: 'vayushield-deterministic',
    model: null,
    engine: 'VayuShield Grounded Engine · Offline Mode',
    mode: 'grounded-fallback',
    isFallback: true,
    status: 'fallback',
    diagnosticCode: diagnosticCode || 'OFFLINE_FALLBACK',
    intent
  };

  if (intent === 'greeting') {
    const answer = aqi !== null
      ? `Hello! Currently ${city} shows a modeled CPCB-derived AQI of ${aqi} (${band}), led by ${primary?.name || 'PM2.5'}. Ask me about outdoor windows, yesterday’s trend, indoor air improvements, or CADR sizing for your ${profile.roomSqFt} sq.ft room.`
      : `Hello! I’m ready to analyze air quality, dispersion windows, and indoor filtration for ${city}. Pick any prompt above or type a specific question.`;
    return {
      ...baseMeta,
      headline: `VayuShield Coach · ${city}`,
      answer,
      directAnswer: answer,
      factsUsed: [mkFact('Est. AQI', aqi, band, 'modeled')],
      recommendations: [
        mkRec('Check Outdoor Timing', 'Ask when the cleanest practical daytime window occurs.', 'Avoids peak stagnation periods.', 'low', 'Daytime')
      ],
      indoorGuidance: '',
      assumptionsAndLimits: commonLimits,
      followUpSuggestions: ['Explain my current air quality', 'Compare today vs. yesterday', 'Explain my room’s CADR']
    };
  }

  if (intent === 'filtration-cadr') {
    const answer = indoorEval
      ? `Your ${indoorEval.dimensions.floorAreaSqFt} sq.ft room (${indoorEval.dimensions.ceilingHeightFt} ft ceiling = ${indoorEval.dimensions.volumeM3} m³ volume) needs ≥ ${indoorEval.sizing.recommendedCadrM3h} m³/h CADR for ${indoorEval.sizing.recommendedAch} ACH. At ${indoorEval.sizing.effectiveCadrM3h} m³/h effective CADR (${indoorEval.assumptions.filterGradeLabel}), modeled steady-state indoor PM2.5 drops from ${indoorEval.outcomes.unfilteredIndoorPm25} to ${indoorEval.outcomes.filteredIndoorPm25} µg/m³ (-${indoorEval.outcomes.reductionPct}%).`
      : 'Room CADR sizing requires valid room area and ceiling height values.';
    return {
      ...baseMeta,
      headline: `Room Filtration Sizing: ${indoorEval?.sizing?.recommendedCadrM3h ?? 'N/A'} m³/h CADR`,
      answer,
      directAnswer: answer,
      factsUsed: indoorEval
        ? [
            mkFact('Room Volume', indoorEval.dimensions.volumeM3, 'm³', 'calculated'),
            mkFact('Target CADR', indoorEval.sizing.recommendedCadrM3h, 'm³/h', 'calculated'),
            mkFact('Filtered PM2.5', indoorEval.outcomes.filteredIndoorPm25, 'µg/m³', 'calculated')
          ]
        : [],
      recommendations: [
        mkRec('Zero-Cost Sealing', `Weather-strip door gaps to lower infiltration from ${indoorEval?.assumptions?.infiltrationAch ?? 0.6} ACH toward 0.3 ACH.`, 'Reduces outdoor PM2.5 ingress before filtration.', 'medium', 'Continuous'),
        mkRec('Budget DIY HEPA/MERV-13 Box', 'Build a sealed exhaust-fan + MERV-13/HEPA box (~₹2,400, ~250–300 m³/h CADR).', 'Delivers high particle CADR at low cost.', 'high', 'Sleep & High-AQI Hours'),
        mkRec('Certified True H13 HEPA', `Choose a purifier rated ≥ ${indoorEval?.sizing?.recommendedCadrM3h ?? 250} m³/h at medium/sleep speed with ionizer OFF.`, 'Avoids ozone irritation while sustaining target ACH.', 'high', 'Evening & Night')
      ],
      indoorGuidance: 'True HEPA removes particles (PM2.5/PM10) only—not gaseous NO₂, CO, or VOCs. Use outward kitchen exhaust for combustion gases.',
      assumptionsAndLimits: [commonLimits[0], 'Single-zone steady-state mass balance (±15% door-opening uncertainty).'],
      followUpSuggestions: ['How can I improve my indoor air?', 'What if I seal window gaps better?', 'Compare today vs. yesterday']
    };
  }

  if (intent === 'indoor-air') {
    const answer = `For ${city} (modeled PM2.5 ${todayPm25 ?? 'Unavailable'} µg/m³) with your ${profile.cookingFuel} kitchen and ${indoorEval?.assumptions?.leakageLabel?.toLowerCase() || 'typical'} room envelope, focus on three levers: venting cooking gases outward, closing windows during peak stagnation, and running mechanical HEPA filtration sized to ≥ ${indoorEval?.sizing?.recommendedCadrM3h ?? 250} m³/h.`;
    return {
      ...baseMeta,
      headline: `${city}: Indoor Air Quality Protection Plan`,
      answer,
      directAnswer: answer,
      factsUsed: [
        mkFact('Outdoor PM2.5', todayPm25, 'µg/m³', 'modeled'),
        mkFact('Unfiltered Indoor', indoorEval?.outcomes?.unfilteredIndoorPm25 ?? null, 'µg/m³', 'calculated'),
        mkFact('Filtered Indoor', indoorEval?.outcomes?.filteredIndoorPm25 ?? null, 'µg/m³', 'calculated')
      ],
      recommendations: [
        mkRec(
          'Control Kitchen Emissions',
          profile.cookingFuel === 'induction'
            ? 'Cover pans and run kitchen exhaust during high-heat frying.'
            : 'Run an outward exhaust fan during LPG/solid-fuel cooking and shift boiling to an electric kettle or induction plate.',
          'Combustion releases NO₂ and PM2.5 that True HEPA alone cannot fully remove.',
          'high',
          'During Meal Prep'
        ),
        mkRec(
          'Timed Brief Ventilation',
          disp?.bestVentilationWindow?.guidance || 'Keep windows shut during stagnation and flush briefly during cleaner midday hours.',
          'Manages indoor CO₂ without importing peak smog.',
          'medium',
          dayWin?.label || 'Midday'
        ),
        mkRec(
          'Mechanical True HEPA (No Ozone)',
          `Run ≥ ${indoorEval?.sizing?.recommendedCadrM3h ?? 250} m³/h HEPA filtration in your main living/sleep room; avoid incense, candles, and ozone ionizers.`,
          'Cuts steady-state indoor PM2.5 without generating indoor ozone.',
          'high',
          'Evening & Sleep'
        )
      ],
      indoorGuidance: indoorEval
        ? `Modeled steady-state indoor PM2.5 drops from ${indoorEval.outcomes.unfilteredIndoorPm25} to ${indoorEval.outcomes.filteredIndoorPm25} µg/m³ at ${indoorEval.sizing.effectiveCadrM3h} m³/h effective CADR.`
        : 'Size mechanical HEPA filtration to 4–5 ACH.',
      assumptionsAndLimits: commonLimits,
      followUpSuggestions: ['Explain my room’s CADR', 'When is a practical outdoor activity window?', 'What should my household do?']
    };
  }

  if (intent === 'outdoor-activity') {
    const daylightSpan = disp?.daylight?.sunriseLabel && disp?.daylight?.sunsetLabel
      ? ` between sunrise (${disp.daylight.sunriseLabel}) and sunset (${disp.daylight.sunsetLabel})`
      : '';
    const overnightExplain = lowWin && !lowWin.isDaytime
      ? ` Although modeled PM2.5 dips lower overnight (${lowWin.label} at ${lowWin.avgPm25} µg/m³), overnight hours are excluded from outdoor exercise guidance for safety and sleep hygiene.`
      : '';
    const pmDetail = typeof dayWin?.avgPm25 === 'number'
      ? ` with projected PM2.5 of ${dayWin.avgPm25} µg/m³${dayWin.deltaText ? ` (${dayWin.deltaText})` : ''}`
      : '';
    const answer = dayWin
      ? `For ${city}, the cleanest practical daytime window${daylightSpan} is ${dayWin.label}${pmDetail}.${overnightExplain}`
      : `Daytime forecast windows are currently unavailable for ${city}; inspect the 24-hour dispersion bars after refreshing telemetry.`;
    return {
      ...baseMeta,
      headline: `${city}: Practical Daytime Outdoor Window`,
      answer,
      directAnswer: answer,
      factsUsed: [
        mkFact('Daytime Window', dayWin?.label ?? null, typeof dayWin?.avgPm25 === 'number' ? `${dayWin.avgPm25} µg/m³` : '', 'modeled'),
        mkFact('Peak Risk Window', peakWin?.label ?? null, typeof peakWin?.avgPm25 === 'number' ? `${peakWin.avgPm25} µg/m³` : '', 'modeled')
      ],
      recommendations: [
        mkRec(
          'Schedule Activity in Daylight Window',
          aqi !== null && aqi > 200
            ? `Est. AQI is ${aqi} (${band})—move vigorous exercise indoors and use ${dayWin?.label || 'midday'} only for brief errands.`
            : `Plan light-to-moderate outdoor activity during ${dayWin?.label || 'well-mixed daylight hours'} away from heavy traffic.`,
          'Aligns activity with deeper afternoon boundary-layer mixing.',
          'high',
          dayWin?.label || 'Daytime'
        ),
        mkRec(
          'Avoid Peak Accumulation',
          peakWin ? `Minimize outdoor exposure during ${peakWin.label} (projected ${peakWin.avgPm25} µg/m³).` : 'Avoid calm early-morning and late-evening haze.',
          'Low wind and shallow mixing trap near-ground emissions.',
          'medium',
          peakWin?.label || 'Evening'
        )
      ],
      indoorGuidance: 'Keep exterior doors closed outside your chosen daytime ventilation window.',
      assumptionsAndLimits: commonLimits,
      followUpSuggestions: ['How can I improve my indoor air?', 'What is driving pollution?', 'Explain forecast uncertainty']
    };
  }

  if (intent === 'forecast-interpretation') {
    const diff = todayPm25 !== null && yestPm25 !== null ? Number((todayPm25 - yestPm25).toFixed(1)) : null;
    const answer = diff !== null
      ? `In ${city}, the current 24-hour rolling PM2.5 mean is ${todayPm25} µg/m³ versus yesterday’s ${yestPm25} µg/m³ (${diff >= 0 ? '+' : ''}${diff} µg/m³ — ${diff < 0 ? 'cleaner than yesterday' : diff > 0 ? 'higher than yesterday' : 'unchanged'}). Over the next 6 hours, dispersion forecasts indicate a ${disp?.trend || 'unavailable'} trend (${disp?.trendDeltaPct ?? 'N/A'}%).`
      : `In ${city}, current 24-hour PM2.5 is ${todayPm25 ?? 'Unavailable'} µg/m³; yesterday’s full 24-hour baseline was unavailable in this fetch. Next 6-hour modeled trend: ${disp?.trend || 'unavailable'}. Note that modeled ${resLabel} grids smooth out sharp street-level spikes.`;
    return {
      ...baseMeta,
      headline: `${city}: Trend, Yesterday Comparison & Uncertainty`,
      answer,
      directAnswer: answer,
      factsUsed: [
        mkFact('Today 24h PM2.5', todayPm25, 'µg/m³', 'modeled'),
        mkFact('Yesterday 24h PM2.5', yestPm25, 'µg/m³', 'modeled'),
        mkFact('6h Forecast Trend', disp?.trend ?? null, typeof disp?.trendDeltaPct === 'number' ? `${disp.trendDeltaPct}%` : '', 'modeled')
      ],
      recommendations: [
        mkRec('Plan Around Daylight Mixing', dayWin ? `Use ${dayWin.label} (projected ${dayWin.avgPm25} µg/m³) for essential errands.` : 'Check hourly forecast updates before planning outdoor activity.', 'Accounts for projected dispersion changes.', 'medium', dayWin?.label || 'Daytime'),
        mkRec('Cross-Check Local Stations', 'Verify severe local smoke or roadside haze against an official CPCB CAAQMS monitor.', `CAMS ${resLabel} cells average across wide urban areas.`, 'low', 'Ongoing')
      ],
      indoorGuidance: 'Run filtration proactively ahead of worsening evening trends.',
      assumptionsAndLimits: commonLimits,
      followUpSuggestions: ['What is driving pollution?', 'Practical outdoor window', 'What should my household do?']
    };
  }

  if (intent === 'atmospheric-dispersion' || intent === 'pollution-causes') {
    const blh = typeof firstHr?.blh === 'number' ? firstHr.blh : null;
    const wind = intel?.current?.windKmh ?? firstHr?.windKmh ?? null;
    const vc = typeof firstHr?.vc === 'number' ? firstHr.vc : null;
    const answer = `Air quality in ${city} (Est. AQI ${aqi ?? 'Unavailable'}, ${band}) is primarily driven by ${primary ? `${primary.name} (${primary.concentration} ${primary.unit}, ${primary.averaging} mean)` : 'unavailable primary pollutant data'}. Current modeled boundary-layer height is ${blh !== null ? `${blh} m` : 'unavailable'} with 10m wind of ${wind !== null ? `${wind} km/h` : 'unavailable'}, yielding a Ventilation Coefficient of ${vc !== null ? `${vc.toLocaleString('en-IN')} m²/s` : 'unavailable'} (${firstHr?.dispersionCategory || disp?.classification || 'stagnation risk estimate'}).`;
    return {
      ...baseMeta,
      headline: `${city}: Pollution Drivers & Dispersion`,
      answer,
      directAnswer: answer,
      factsUsed: [
        mkFact('Primary Driver', primary?.concentration ?? null, primary ? `${primary.name} ${primary.unit}` : '', 'modeled'),
        mkFact('Boundary Layer', blh, 'm', 'modeled'),
        mkFact('Ventilation Coeff.', vc, 'm²/s', 'calculated')
      ],
      recommendations: [
        mkRec('Close Up During Stagnation', 'Keep windows closed when Ventilation Coefficient drops below 2,000 m²/s.', 'Shallow mixing traps traffic and combustion plumes near ground level.', 'high', peakWin?.label || 'Evening'),
        mkRec('Flush During Thermal Mixing', dayWin ? `Brief cross-ventilation works best around ${dayWin.label}.` : 'Ventilate briefly during breezy afternoon hours.', 'Deeper mixing dilutes surface pollutants.', 'medium', dayWin?.label || 'Afternoon')
      ],
      indoorGuidance: 'Stagnation risk is derived from modeled BLH × wind speed—not confirmed radiosonde temperature inversion data.',
      assumptionsAndLimits: commonLimits,
      followUpSuggestions: ['Practical outdoor window', 'Compare today vs. yesterday', 'Improve indoor air']
    };
  }

  if (intent === 'commute-protection' || intent === 'household-advice') {
    const answer = `For your ${profile.householdProfile} household in ${city} (Est. AQI ${aqi ?? 'Unavailable'}, ${band}) and ${profile.dailyCommuteKm} km ${profile.commuteMode} commute: ${aqi !== null && aqi > 150 ? 'wear a tight-seal N95/FFP2 respirator along traffic corridors, keep indoor spaces sealed during evening wind drops, and run mechanical HEPA filtration.' : 'pace prolonged roadside exertion, ventilate cooking fumes outward, and monitor evening dispersion changes.'}`;
    return {
      ...baseMeta,
      headline: `${city}: Household & Commute Guidance`,
      answer,
      directAnswer: answer,
      factsUsed: [
        mkFact('Est. AQI', aqi, band, 'modeled'),
        mkFact('Commute', profile.dailyCommuteKm, `km (${profile.commuteMode})`, 'estimated')
      ],
      recommendations: [
        mkRec('Commute Protection', profile.commuteMode === 'car' ? 'Use cabin Recirculate in congested traffic and flush briefly every 20–30 min.' : 'Keep a well-fitted N95/FFP2 respirator ready on traffic corridors and avoid idling behind diesel exhaust.', 'Roadside PM2.5 and NO₂ spike well above regional grid averages.', 'high', 'Commute Hours'),
        mkRec('Evening Indoor Recovery', `Close windows before sunset and target ≥ ${indoorEval?.sizing?.recommendedCadrM3h ?? 250} m³/h HEPA CADR in bedrooms.`, 'Counters nocturnal boundary-layer compression.', 'medium', 'Evening & Night')
      ],
      indoorGuidance: 'Maintain one well-sealed, filtered room for children, older adults, or respiratory-sensitive family members.',
      assumptionsAndLimits: commonLimits,
      followUpSuggestions: ['Explain my room’s CADR', 'Improve indoor air', 'Practical outdoor window']
    };
  }

  // Default: aqi-explanation / pollutant-analysis / general-education / follow-up
  const subIdxText = primary && primary.subIndex != null ? `, sub-index ${primary.subIndex}` : '';
  const avgText = primary?.averaging ? `${primary.averaging} rolling mean` : 'rolling mean';
  const winText = dayWin
    ? ` Best practical daytime window: ${dayWin.label}${typeof dayWin.avgPm25 === 'number' ? ` (projected ${dayWin.avgPm25} µg/m³)` : ''}.`
    : '';
  const answer = aqi !== null
    ? `${city} currently has a modeled CPCB-derived AQI estimate of ${aqi} (${band}), driven by ${primary ? `${primary.name} at ${primary.concentration} ${primary.unit} (${avgText}${subIdxText})` : 'available particulate readings'}.${winText} This figure is computed from ${resLabel} modeled data—not an official ground CPCB CAAQMS monitor—so nearby roadside areas may read higher.`
    : `Pollutant data for ${city} is currently incomplete, so a valid CPCB-derived AQI cannot be reported without fabricating missing values.`;
    return {
    ...baseMeta,
    headline: aqi !== null ? `${city}: Est. AQI ${aqi} (${band}) Explained` : `${city}: Incomplete Telemetry`,
    answer,
    directAnswer: answer,
    factsUsed: [
      mkFact('Est. AQI', aqi, band, 'modeled'),
      mkFact(primary?.name || 'PM2.5', primary?.concentration ?? todayPm25, primary?.unit || 'µg/m³', 'modeled')
    ],
    recommendations: [
      mkRec('Adjust Outdoor Effort', aqi !== null && aqi > 200 ? 'Shift workouts indoors and wear a fitted N95 for essential trips.' : 'Pace sustained exertion near busy roads.', 'Matches CPCB band guidance without overstating certainty.', 'high', 'Today'),
      mkRec('Use Practical Daytime Window', dayWin ? `Cleanest practical daylight period is ${dayWin.label} (projected ${dayWin.avgPm25} µg/m³).` : 'Check dispersion forecast once refreshed.', 'Optimizes timing around atmospheric mixing.', 'medium', dayWin?.label || 'Daytime')
    ],
    indoorGuidance: indoorEval
      ? `Target ≥ ${indoorEval.sizing.recommendedCadrM3h} m³/h True HEPA CADR for your ${indoorEval.dimensions.floorAreaSqFt} sq.ft room (ionizer OFF).`
      : 'Run mechanical True HEPA filtration when outdoor haze rises.',
    assumptionsAndLimits: commonLimits,
    followUpSuggestions: ['What is driving pollution?', 'Compare today vs. yesterday', 'Improve indoor air']
  };
}

/**
 * Calls POST /api/gemini with validated nested environmental context, session history,
 * detected intent, and AbortSignal support. Falls back transparently when unavailable.
 */
export async function askVayuShieldCoach(params, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const externalSignal = options.signal || null;
  const profile = normalizeProfile(params.profile);
  const intel = params.intel;
  const indoorEval = params.indoorEval;
  const history = Array.isArray(params.history) ? params.history : [];
  const historySummary = typeof params.historySummary === 'string' ? params.historySummary : '';
  const question = sanitizeText(params.question, 500) || COACH_PROMPT_TEMPLATES[0].prompt;
  const intent = classifyCoachIntent(question, history.length);

  if (!intel || !intel.location) {
    return buildGroundedFallback(question, intel, profile, indoorEval, { diagnosticCode: 'NO_TELEMETRY', history });
  }

  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      const err = new Error('Generation stopped by user.');
      err.name = 'UserAbortError';
      throw err;
    }
    externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);

  try {
    const context = buildCoachContextPayload(intel, profile, indoorEval);
    const response = await fetchImpl('/api/gemini', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        question,
        intent,
        context,
        history,
        historySummary
      })
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || !payload.headline || !Array.isArray(payload.recommendations)) {
      const code = payload?.diagnosticCode || `HTTP_${response.status}`;
      return buildGroundedFallback(question, intel, profile, indoorEval, {
        diagnosticCode: code,
        history
      });
    }

    return {
      ...payload,
      answer: payload.answer || payload.directAnswer || payload.indoorGuidance || '',
      directAnswer: payload.directAnswer || payload.answer || payload.indoorGuidance || '',
      isFallback: false,
      intent
    };
  } catch (err) {
    if (externalSignal?.aborted) {
      const abortErr = new Error('Generation stopped by user.');
      abortErr.name = 'UserAbortError';
      throw abortErr;
    }
    const code = err?.name === 'AbortError' ? 'CLIENT_TIMEOUT' : 'NETWORK_UNAVAILABLE';
    return buildGroundedFallback(question, intel, profile, indoorEval, {
      diagnosticCode: code,
      history
    });
  } finally {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
  }
}