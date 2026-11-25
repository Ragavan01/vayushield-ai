/**
 * @fileoverview Practical, daylight-aware Intelligent Daily Routine engine.
 * Never coerces missing/null AQI into 0 ("Good") and separates overnight lows
 * from practical sunrise-to-sunset daytime activity windows.
 */

import { normalizeProfile } from './impactModel.js';

function selectImmediateBandAdvice(aqi, bandLabel, primary, isSensitive, daytimeText, overnightNote) {
  if (aqi > 300) {
    return {
      level: 'alert',
      headline: `${bandLabel} air (Est. AQI ${aqi}, primary ${primary}) — stay indoors and run True HEPA filtration`,
      detail: `Avoid outdoor exertion${isSensitive ? ', particularly for children, seniors, and respiratory-sensitive members' : ''}. Wear a well-fitted N95/FFP2 respirator for unavoidable trips. ${daytimeText}`
    };
  }
  if (aqi > 200) {
    return {
      level: 'alert',
      headline: `${bandLabel} air (Est. AQI ${aqi}, primary ${primary}) — reduce prolonged outdoor exposure`,
      detail: `Use a tight-seal N95 mask on traffic corridors and keep windows closed during stagnation periods. ${daytimeText}`
    };
  }
  if (aqi > 100) {
    return {
      level: 'warn',
      headline: `${bandLabel} air (Est. AQI ${aqi}, primary ${primary}) — pace daytime outdoor exertion`,
      detail: `${isSensitive ? 'Sensitive household members should limit sustained exertion near heavy traffic. ' : ''}${daytimeText}${overnightNote}`
    };
  }
  return {
    level: 'favorable',
    headline: `${bandLabel} air (Est. AQI ${aqi}, primary ${primary}) — generally favorable for daytime activity`,
    detail: `Modeled ambient air is comparatively clean (lower pollution reduces risk but does not guarantee health safety for sensitive individuals). ${daytimeText}`
  };
}

/**
 * Generates the top-level immediate action callout banner tailored to AQI and household vulnerability.
 * @param {Record<string, any> | null} intel
 * @param {Record<string, any> | null} rawProfile
 * @returns {{ level: string, headline: string, detail: string }}
 */
export function buildImmediateAction(intel, rawProfile) {
  const profile = normalizeProfile(rawProfile);
  const aqi = typeof intel?.cpcb?.aqi === 'number' && Number.isFinite(intel.cpcb.aqi) ? intel.cpcb.aqi : null;
  if (aqi === null) {
    return {
      level: 'neutral',
      headline: 'Telemetry incomplete — verify local conditions before strenuous outdoor activity',
      detail: 'Pollutant readings did not satisfy minimum completeness criteria. Missing data is never treated as clean air; refresh or verify an official CPCB CAAQMS monitor.'
    };
  }

  const disp = intel?.dispersion;
  const daytimeText = disp?.available && disp.bestDaytimeWindow
    ? `Best practical daytime window is ${disp.bestDaytimeWindow.label} (Projected PM2.5: ${disp.bestDaytimeWindow.avgPm25} µg/m³).`
    : 'Daytime forecast window is currently unavailable.';
  const overnightNote = disp?.available && disp.lowestPollutionWindow && !disp.lowestPollutionWindow.isDaytime
    ? ` Overnight minimum occurs ${disp.lowestPollutionWindow.label} (${disp.lowestPollutionWindow.avgPm25} µg/m³), shown for context rather than outdoor exercise.`
    : '';

  return selectImmediateBandAdvice(
    aqi, intel?.cpcb?.band?.label || 'Unavailable', intel?.cpcb?.primaryPollutant?.name || 'PM2.5',
    profile.householdProfile !== 'general', daytimeText, overnightNote
  );
}

const VULNERABILITY_NOTES = Object.freeze({
  kids: 'Remove outdoor shoes at the entry, shift vigorous youth sports indoors when AQI exceeds 200, and follow pediatrician guidance for any child with asthma.',
  'seniors-asthma': 'Keep prescribed inhalers/medications accessible, prioritize a filtered room on Poor/Severe days, and consult a clinician promptly for respiratory symptoms.',
  'multi-gen': 'Maintain one well-sealed shared room with mechanical filtration for children and older adults during high-stagnation periods.',
  general: 'Avoid intense outdoor cardio during peak accumulation windows and stay hydrated.'
});

function buildCommuteAdvice(profile, aqi, daytimeWindow) {
  const map = {
    car: `For your ${profile.dailyCommuteKm} km car commute, use cabin Recirculate mode through congested corridors (flush briefly with outside air every 20–30 min to avoid CO₂ buildup) and consider public transit 2–3 days/week.`,
    'two-wheeler': `For your ${profile.dailyCommuteKm} km two-wheeler ride, ${aqi === null ? 'carry a fitted N95 respirator because live AQI is unavailable' : aqi > 150 ? 'wear a well-fitted N95/KF94 respirator without seal gaps' : 'keep a fitted N95 mask accessible for heavy-traffic stretches'} and avoid idling directly behind diesel exhaust.`,
    'public-transit': `Your ${profile.dailyCommuteKm} km transit commute lowers per-passenger tailpipe emissions. ${aqi === null || aqi > 200 ? 'Keep a fitted N95 respirator ready at road-level stops.' : 'Wait away from busy curbside idling lanes.'}`,
    'wfh-walk': `Schedule walking errands during ${daytimeWindow ? `the practical daytime window (${daytimeWindow.label})` : 'midday well-mixed hours'} along lower-traffic side streets.`
  };
  return `${map[profile.commuteMode]} ${VULNERABILITY_NOTES[profile.householdProfile]}`;
}

function buildCookingAdvice(cookingFuel) {
  if (cookingFuel === 'induction') {
    return 'Continue electric/induction cooking with pan lids and kitchen exhaust during high-heat frying to capture cooking aerosols.';
  }
  if (cookingFuel === 'lpg-exhaust') {
    return 'Run ducted kitchen exhaust throughout cooking and for 10 minutes afterward; shift boiling/simmering to an electric kettle or induction plate when windows stay closed.';
  }
  return 'Unvented gas or solid-fuel cooking sharply raises indoor NO₂ and PM2.5. Crack a kitchen window with an outward exhaust fan during meal prep, cover pans, and shift boiling tasks to electric appliances where feasible.';
}

function buildPhaseActions(aqi, daytimeWindow, lowestWindow, eveningWatch, indoorEval) {
  const lowestNote = lowestWindow && !lowestWindow.isDaytime
    ? ` Note: The absolute lowest modeled PM2.5 occurs overnight (${lowestWindow.label}, ${lowestWindow.avgPm25} µg/m³), which is unsuitable for outdoor exercise.` : '';
  const rainNote = daytimeWindow && daytimeWindow.maxPrecipMm >= 1.5
    ? ` Forecast also indicates rain (~${daytimeWindow.maxPrecipMm} mm/hr); consider indoor alternatives.` : '';

  const outdoor = aqi === null
    ? 'Live AQI is currently unavailable. Avoid strenuous outdoor workouts until readings refresh or are confirmed via a nearby CPCB station; choose indoor alternatives if haze is visible.'
    : aqi > 200
      ? `Prioritize indoor movement today rather than outdoor workouts. If outdoor errands are necessary, use the cleanest practical daytime period (${daytimeWindow ? daytimeWindow.label : 'midday'}).${lowestNote}${rainNote}`
      : aqi > 100
        ? `Schedule light-to-moderate daytime outdoor activity during ${daytimeWindow ? daytimeWindow.label : 'well-mixed daylight hours'} away from arterial traffic.${lowestNote}${rainNote}`
        : `Daytime conditions (${daytimeWindow ? daytimeWindow.label : 'daylight hours'}) are generally favorable for outdoor activity.${rainNote}`;

  const filtration = aqi === null
    ? `Telemetry is unavailable; if outdoor haze or indoor cooking smoke is present, operate True HEPA filtration sized to ≥ ${indoorEval.sizing.recommendedCadrM3h} m³/h (ionizer OFF).`
    : aqi > 100
      ? `Operate mechanical True HEPA filtration (recommended CADR ≥ ${indoorEval.sizing.recommendedCadrM3h} m³/h; ionizer OFF). Under ${indoorEval.assumptions.leakageLabel.toLowerCase()} assumptions, modeled steady-state indoor PM2.5 drops from ${indoorEval.outcomes.unfilteredIndoorPm25} µg/m³ to ${indoorEval.outcomes.filteredIndoorPm25} µg/m³ (uncertainty range ${indoorEval.outcomes.filteredRange[0]}–${indoorEval.outcomes.filteredRange[1]} µg/m³).`
      : 'Active HEPA filtration is optional today unless cooking smoke, indoor dust, or allergies are present.';

  const evening = aqi === null
    ? 'Refresh telemetry before evening; close windows if visible haze or calm stagnant air develops after sunset.'
    : aqi > 150 || (eveningWatch && eveningWatch.avgPm25 > 60)
      ? 'Close exterior windows and door gaps before evening wind drops compress the surface boundary layer. Damp-mop floors instead of dry sweeping and run bedroom filtration on quiet night mode.'
      : 'Maintain normal bedroom comfort, avoid outdoor waste/leaf burning, and check morning air quality before early workouts.';

  return { outdoor, filtration, evening };
}

function buildRoutineItems({ intel, profile, indoorEval, aqi, pm25_24h, disp, dayWin, eveningWatch, ventWin, weatherNote, copy }) {
  return [
    {
      id: 'daytime-activity', phase: 'Practical Daytime Activity Period',
      window: dayWin ? `Daytime: ${dayWin.label}` : 'Telemetry / Daylight Pending',
      condition: dayWin ? `Projected PM2.5: ${dayWin.avgPm25} µg/m³ (${dayWin.deltaText}). Sunrise ${disp.daylight.sunriseLabel} · Sunset ${disp.daylight.sunsetLabel}. ${weatherNote}` : `24-hr rolling PM2.5: ${pm25_24h !== null ? `${pm25_24h} µg/m³` : 'Unavailable'}. ${weatherNote}`,
      action: copy.outdoor,
      basis: 'Constrained strictly to local sunrise–sunset daylight hours and precipitation forecasts; lower pollution reduces risk without guaranteeing safety.'
    },
    {
      id: 'commute-school', phase: 'Work & School Commute Guidance',
      window: `${profile.dailyCommuteKm} km · ${profile.commuteMode}`,
      condition: aqi !== null ? `Est. AQI ${aqi} (${intel?.cpcb?.band?.label || 'N/A'}) · Primary pollutant: ${intel?.cpcb?.primaryPollutant?.name || 'PM2.5'}` : 'Est. AQI Unavailable — precautionary guidance active',
      action: buildCommuteAdvice(profile, aqi, dayWin),
      basis: 'Tailored to commute mode, daily distance, and household vulnerability.'
    },
    {
      id: 'ventilation', phase: 'Daytime Ventilation Window',
      window: ventWin ? `Flush: ${ventWin.label}` : 'Monitor Daylight PM2.5',
      condition: disp?.classification || 'Modeled dispersion estimate',
      action: ventWin ? ventWin.guidance : 'Keep exterior openings closed during stagnation; flush briefly during lower-haze daylight periods to manage indoor CO₂.',
      basis: 'Aligned to practical daytime Ventilation Coefficient (BLH × 10m wind speed) rather than overnight minimums.'
    },
    {
      id: 'cooking', phase: 'Kitchen & Indoor Combustion Control', window: 'During Meal Prep',
      condition: `Fuel setup: ${profile.cookingFuel} · Avoid incense, candles, and mosquito coils during elevated AQI`,
      action: buildCookingAdvice(profile.cookingFuel),
      basis: 'Indoor combustion emits both PM2.5 and gaseous NO₂/CO; True HEPA captures particles only, not gases.'
    },
    {
      id: 'indoor-filtration', phase: 'Indoor Protection & Filtration Target',
      window: `${profile.roomSqFt} sq.ft · ${profile.ceilingHeightFt} ft ceiling`,
      condition: `Room volume ${indoorEval.dimensions.volumeM3} m³ · Target ${indoorEval.sizing.recommendedAch} ACH`,
      action: copy.filtration,
      basis: 'Computed from single-zone steady-state mass-balance physics (ANSI/AHAM AC-1 CADR + infiltration + deposition).'
    },
    {
      id: 'evening-night', phase: 'Evening & Overnight Recovery',
      window: eveningWatch ? `Night Watch: ${eveningWatch.label}` : 'Evening to Dawn',
      condition: eveningWatch ? `Peak overnight/evening accumulation risk: ${eveningWatch.label} (Projected PM2.5: ${eveningWatch.avgPm25} µg/m³). Next 6h trend: ${disp?.trend || 'unavailable'}.` : 'Monitor evening radiative cooling and boundary-layer compression.',
      action: copy.evening,
      basis: 'Tracks evening-to-dawn stagnation separately from daytime peaks.'
    }
  ];
}

/**
 * Builds the 6-phase conditional daily air-quality protection schedule.
 * @param {Record<string, any> | null} intel
 * @param {Record<string, any> | null} rawProfile
 * @param {Record<string, any>} indoorEval
 * @returns {Array<{ id: string, phase: string, window: string, condition: string, action: string, basis: string }>}
 */
export function buildIntelligentRoutine(intel, rawProfile, indoorEval) {
  const profile = normalizeProfile(rawProfile);
  const aqi = typeof intel?.cpcb?.aqi === 'number' && Number.isFinite(intel.cpcb.aqi) ? intel.cpcb.aqi : null;
  const pm25_24h = intel?.rollingAverages?.pm25_24h ?? intel?.current?.pm25 ?? null;
  const disp = intel?.dispersion;
  const dayWin = disp?.available && disp.bestDaytimeWindow ? disp.bestDaytimeWindow : null;
  const lowWin = disp?.available && disp.lowestPollutionWindow ? disp.lowestPollutionWindow : null;
  const eveningWatch = disp?.available ? (disp.eveningWatchWindow || disp.peakAccumulationWindow || null) : null;
  const ventWin = disp?.available && disp.bestVentilationWindow ? disp.bestVentilationWindow : null;
  const weatherNote = typeof intel?.current?.tempC === 'number' && typeof intel?.current?.windKmh === 'number'
    ? `Surface context: ${intel.current.tempC.toFixed(1)} °C, wind ${intel.current.windKmh.toFixed(1)} km/h.`
    : 'Surface weather telemetry unavailable.';
  const copy = buildPhaseActions(aqi, dayWin, lowWin, eveningWatch, indoorEval);
  return buildRoutineItems({ intel, profile, indoorEval, aqi, pm25_24h, disp, dayWin, eveningWatch, ventWin, weatherNote, copy });
}