/**
 * @fileoverview Condition-driven Intelligent Daily Routine engine.
 * Generates practical household guidance strictly from actual modeled AQI,
 * atmospheric dispersion windows, weather context, and room filtration sizing.
 * Never guarantees medical outcomes or hardcodes fixed clock windows.
 */

import { normalizeProfile } from './impactModel.js';

/**
 * Generates an immediate "What should I do right now?" headline and guidance block
 * based on current AQI, dispersion risk, and household vulnerability.
 * @param {any} intel
 * @param {any} rawProfile
 */
export function buildImmediateAction(intel, rawProfile) {
  const profile = normalizeProfile(rawProfile);
  const aqi = intel?.cpcb?.aqi ?? null;
  const bandLabel = intel?.cpcb?.band?.label || 'Unavailable';
  const primary = intel?.cpcb?.primaryPollutant?.name || 'PM2.5';
  const disp = intel?.dispersion;
  const isSensitive = profile.householdProfile === 'kids' || profile.householdProfile === 'seniors-asthma' || profile.householdProfile === 'multi-gen';

  if (aqi === null) {
    return {
      level: 'neutral',
      headline: 'Telemetry incomplete — verify local readings before strenuous outdoor activity',
      detail: 'Pollutant data did not meet minimum completeness thresholds. Use the retry control or check an official CPCB CAAQMS station.'
    };
  }

  const bestWindowText = disp?.available && disp.bestOutdoorWindow
    ? `Lowest forecasted PM2.5 window is ${disp.bestOutdoorWindow.label} (~${disp.bestOutdoorWindow.avgPm25} µg/m³).`
    : 'Hourly dispersion forecast is currently unavailable.';

  if (aqi > 300) {
    return {
      level: 'alert',
      headline: `${bandLabel} air (est. AQI ${aqi}, primary ${primary}) — move activities indoors and run mechanical filtration`,
      detail: `Avoid outdoor exertion${isSensitive ? ', especially for children, elders, and asthma-sensitive members' : ''}. Wear a well-fitted N95/FFP2 respirator for unavoidable trips. ${bestWindowText}`
    };
  }

  if (aqi > 200) {
    return {
      level: 'alert',
      headline: `${bandLabel} air (est. AQI ${aqi}, primary ${primary}) — limit prolonged outdoor exposure`,
      detail: `Use a tight-seal N95 mask on traffic corridors and keep windows closed during stagnation periods. ${bestWindowText}`
    };
  }

  if (aqi > 100) {
    return {
      level: 'warn',
      headline: `${bandLabel} air (est. AQI ${aqi}, primary ${primary}) — pace outdoor exertion`,
      detail: `${isSensitive ? 'Sensitive household members should reduce prolonged outdoor activity near heavy traffic. ' : ''}${bestWindowText}`
    };
  }

  return {
    level: 'favorable',
    headline: `${bandLabel} air (est. AQI ${aqi}, primary ${primary}) — favorable for outdoor activity and ventilation`,
    detail: `Modeled conditions are relatively clean. Natural cross-ventilation is suitable while monitoring for evening wind drops. ${bestWindowText}`
  };
}

/**
 * Generates 6 conditional daily routine modules tied directly to live location forecast data.
 * @param {any} intel
 * @param {any} rawProfile
 * @param {any} indoorEval
 */
export function buildIntelligentRoutine(intel, rawProfile, indoorEval) {
  const profile = normalizeProfile(rawProfile);
  const aqi = intel?.cpcb?.aqi ?? 0;
  const pm25_24h = intel?.rollingAverages?.pm25_24h ?? intel?.current?.pm25 ?? 0;
  const tempC = intel?.current?.tempC;
  const windKmh = intel?.current?.windKmh;
  const disp = intel?.dispersion;

  const bestWindow = disp?.available && disp.bestOutdoorWindow ? disp.bestOutdoorWindow : null;
  const worstWindow = disp?.available && disp.peakAccumulationWindow ? disp.peakAccumulationWindow : null;
  const ventWindow = disp?.available && disp.bestVentilationWindow ? disp.bestVentilationWindow : null;

  const weatherNote = typeof tempC === 'number' && typeof windKmh === 'number'
    ? `Current surface context: ${tempC.toFixed(1)} °C, wind ${windKmh.toFixed(1)} km/h.`
    : 'Surface weather telemetry unavailable.';

  const commuteMap = {
    car: `For your ${profile.dailyCommuteKm} km car commute, switch cabin HVAC to Recirculate on congested corridors (briefly flush with outside air every 20–30 min to avoid CO₂ buildup) and consider shifting 2–3 days/week to public transit.`,
    'two-wheeler': `For your ${profile.dailyCommuteKm} km two-wheeler ride, ${aqi > 150 ? 'wear a tight-seal N95/KF94 mask without loose gaps' : 'keep an N95 mask ready for heavy-traffic intersections'} and avoid riding immediately behind diesel exhaust plumes.`,
    'public-transit': `Your transit commute (${profile.dailyCommuteKm} km) already lowers per-passenger tailpipe emissions. ${aqi > 200 ? 'Wear an N95 mask while waiting at road-level stops.' : 'Prefer shaded or enclosed waiting areas during peak traffic.'}`,
    'wfh-walk': `Batch walking errands into ${bestWindow ? `the forecasted lower-PM2.5 window (${bestWindow.label})` : 'midday hours with higher wind mixing'} and prefer residential streets over arterial roads.`
  };

  const cookingAdvice = profile.cookingFuel === 'induction'
    ? 'Continue using electric/induction cooking with pan lids and range exhaust during high-heat frying to limit cooking aerosols.'
    : profile.cookingFuel === 'lpg-exhaust'
      ? 'Run your ducted chimney/exhaust continuously during cooking and for 10 minutes after; shift boiling/simmering to an electric kettle or induction plate when outdoor ventilation is restricted.'
      : 'Unvented gas or solid-fuel combustion rapidly elevates indoor NO₂ and PM2.5. Crack a kitchen window with an outward exhaust fan while cooking, cover pans, and shift boiling tasks to electric appliances where feasible.';

  const vulnerabilityNote = {
    kids: 'Keep school/play shoes at the entrance, shift vigorous outdoor sports indoors when AQI exceeds 200, and review pediatrician asthma action plans if applicable.',
    'seniors-asthma': 'Keep prescribed respiratory medications accessible, prioritize a filtered rest room on Poor/Severe days, and seek medical advice promptly if shortness of breath or wheezing occurs.',
    'multi-gen': 'Designate one well-sealed room as a shared clean-air zone for children and older adults during high-stagnation periods.',
    general: 'Avoid heavy outdoor cardio during peak accumulation hours and stay hydrated.'
  }[profile.householdProfile];

  return [
    {
      id: 'morning-outdoor',
      phase: 'Outdoor Activity & Exercise Timing',
      window: bestWindow ? `Preferred: ${bestWindow.label}` : 'Check Hourly Forecast',
      condition: worstWindow
        ? `Peak modeled accumulation: ${worstWindow.label} (avg ~${worstWindow.avgPm25} µg/m³ PM2.5). ${weatherNote}`
        : `24-hr rolling PM2.5: ${pm25_24h} µg/m³. ${weatherNote}`,
      action: aqi > 200
        ? `Move vigorous cardio indoors today. If outdoor movement is essential, schedule light activity during ${bestWindow ? bestWindow.label : 'the lowest wind-stagnation period'}.`
        : aqi > 100
          ? `Prefer moderate outdoor activity during ${bestWindow ? bestWindow.label : 'well-mixed hours'} away from main arterial roads.`
          : 'Modeled ambient air is favorable for standard outdoor exercise and walking.',
      basis: 'Conditioned on modeled 24-hr hourly PM2.5 curve and breathing-rate exposure physics (no medical guarantee).'
    },
    {
      id: 'commute-school',
      phase: 'Work & School Commute Guidance',
      window: `${profile.dailyCommuteKm} km · ${profile.commuteMode}`,
      condition: `Estimated AQI ${aqi} (${intel?.cpcb?.band?.label || 'N/A'}) · Primary pollutant: ${intel?.cpcb?.primaryPollutant?.name || 'PM2.5'}`,
      action: `${commuteMap[profile.commuteMode]} ${vulnerabilityNote}`,
      basis: 'Tailored to commute mode, distance, and roadside traffic exposure dynamics.'
    },
    {
      id: 'ventilation',
      phase: 'Smart Ventilation Window',
      window: ventWindow ? ventWindow.label : 'Monitor Wind & PM2.5',
      condition: disp?.classification || 'Modeled dispersion estimate',
      action: ventWindow
        ? ventWindow.guidance
        : 'Keep windows closed during visible haze or low-wind stagnation; flush briefly when outdoor haze clears to control indoor CO₂.',
      basis: 'Derived from hourly modeled PM2.5 and Ventilation Coefficient (BLH × 10m wind speed).'
    },
    {
      id: 'cooking',
      phase: 'Kitchen & Indoor Combustion Control',
      window: 'During Meal Prep',
      condition: `Kitchen setup: ${profile.cookingFuel} · Avoid indoor incense, candles, and mosquito coils on high-AQI days`,
      action: cookingAdvice,
      basis: 'Combustion produces both fine particulates (PM2.5) and gaseous NO₂/CO, which HEPA filters alone do not remove.'
    },
    {
      id: 'indoor-filtration',
      phase: 'Indoor Air Filtration Target',
      window: `${profile.roomSqFt} sq.ft · ${profile.ceilingHeightFt} ft ceiling`,
      condition: `Room volume ${indoorEval.dimensions.volumeM3} m³ · Target ${indoorEval.sizing.recommendedAch} ACH`,
      action: aqi > 100
        ? `Run mechanical True HEPA filtration (recommended CADR ≥ ${indoorEval.sizing.recommendedCadrM3h} m³/h; ionizer OFF). Under ${indoorEval.assumptions.leakageLabel.toLowerCase()} assumptions, steady-state indoor PM2.5 is modeled at ~${indoorEval.outcomes.filteredIndoorPm25} µg/m³ (range ${indoorEval.outcomes.filteredRange[0]}–${indoorEval.outcomes.filteredRange[1]} µg/m³) vs. ~${indoorEval.outcomes.unfilteredIndoorPm25} µg/m³ unfiltered.`
        : 'Active HEPA filtration is optional today unless indoor cooking, dust, or allergy triggers are present.',
      basis: 'Computed from single-zone steady-state mass-balance physics (infiltration + deposition + CADR).'
    },
    {
      id: 'evening-night',
      phase: 'Evening & Overnight Recovery',
      window: worstWindow ? `Watch: ${worstWindow.label}` : 'Evening to Dawn',
      condition: disp?.trend ? `Next 6-hr PM2.5 trend: ${disp.trend} (${disp.trendDeltaPct >= 0 ? '+' : ''}${disp.trendDeltaPct}%)` : 'Monitor evening dispersion drop',
      action: aqi > 150
        ? 'Close exterior windows and door gaps before evening cooling reduces boundary-layer mixing. Use damp microfiber mopping rather than dry sweeping, and run bedroom filtration on quiet night mode.'
        : 'Maintain normal bedroom ventilation and avoid burning yard waste or trash outdoors.',
      basis: 'Evening radiative cooling typically compresses the surface mixing layer and traps local emissions.'
    }
  ];
}