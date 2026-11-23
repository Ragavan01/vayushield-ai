/**
 * @fileoverview Practical, daylight-aware Intelligent Daily Routine engine (Chimera v2.5).
 * Explicitly separates:
 * 1. Lowest modeled pollution period (often overnight — informational only)
 * 2. Best practical daytime activity period (between sunrise & sunset, precipitation-checked)
 * 3. Indoor protection & evening recovery periods
 */

import { normalizeProfile } from './impactModel.js';

export function buildImmediateAction(intel, rawProfile) {
  const profile = normalizeProfile(rawProfile);
  const aqi = intel?.cpcb?.aqi ?? null;
  const bandLabel = intel?.cpcb?.band?.label || 'Unavailable';
  const primary = intel?.cpcb?.primaryPollutant?.name || 'PM2.5';
  const disp = intel?.dispersion;
  const isSensitive = profile.householdProfile !== 'general';

  if (aqi === null) {
    return {
      level: 'neutral',
      headline: 'Telemetry incomplete — verify local conditions before strenuous outdoor activity',
      detail: 'Pollutant readings did not satisfy minimum completeness criteria. Use Refresh or verify an official CPCB CAAQMS monitor.'
    };
  }

  const daytimeText = disp?.available && disp.bestDaytimeWindow
    ? `Best practical daytime window is ${disp.bestDaytimeWindow.label} (Projected PM2.5: ${disp.bestDaytimeWindow.avgPm25} µg/m³).`
    : 'Daytime forecast window is currently unavailable.';

  const overnightNote = disp?.available && disp.lowestPollutionWindow && !disp.lowestPollutionWindow.isDaytime
    ? ` Overnight minimum occurs ${disp.lowestPollutionWindow.label} (${disp.lowestPollutionWindow.avgPm25} µg/m³), shown for context rather than outdoor exercise.`
    : '';

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

export function buildIntelligentRoutine(intel, rawProfile, indoorEval) {
  const profile = normalizeProfile(rawProfile);
  const aqi = intel?.cpcb?.aqi ?? 0;
  const pm25_24h = intel?.rollingAverages?.pm25_24h ?? intel?.current?.pm25 ?? 0;
  const tempC = intel?.current?.tempC;
  const windKmh = intel?.current?.windKmh;
  const disp = intel?.dispersion;

  const daytimeWindow = disp?.available && disp.bestDaytimeWindow ? disp.bestDaytimeWindow : null;
  const lowestWindow = disp?.available && disp.lowestPollutionWindow ? disp.lowestPollutionWindow : null;
  const peakWindow = disp?.available && disp.peakAccumulationWindow ? disp.peakAccumulationWindow : null;
  const eveningWatch = disp?.available && disp.eveningWatchWindow ? disp.eveningWatchWindow : peakWindow;
  const ventWindow = disp?.available && disp.bestVentilationWindow ? disp.bestVentilationWindow : null;

  const weatherNote = typeof tempC === 'number' && typeof windKmh === 'number'
    ? `Surface context: ${tempC.toFixed(1)} °C, wind ${windKmh.toFixed(1)} km/h.`
    : 'Surface weather telemetry unavailable.';

  const lowestContext = lowestWindow && !lowestWindow.isDaytime
    ? ` Note: The absolute lowest modeled PM2.5 occurs overnight (${lowestWindow.label}, ${lowestWindow.avgPm25} µg/m³), which is unsuitable for outdoor exercise.`
    : '';

  const rainWarning = daytimeWindow && daytimeWindow.maxPrecipMm >= 1.5
    ? ` Forecast also indicates rain (~${daytimeWindow.maxPrecipMm} mm/hr); consider indoor alternatives.`
    : '';

  const commuteMap = {
    car: `For your ${profile.dailyCommuteKm} km car commute, use cabin Recirculate mode through congested corridors (flush briefly with outside air every 20–30 min to avoid CO₂ buildup) and consider public transit 2–3 days/week.`,
    'two-wheeler': `For your ${profile.dailyCommuteKm} km two-wheeler ride, ${aqi > 150 ? 'wear a well-fitted N95/KF94 respirator without seal gaps' : 'keep a fitted N95 mask accessible for heavy-traffic stretches'} and avoid idling directly behind diesel exhaust.`,
    'public-transit': `Your ${profile.dailyCommuteKm} km transit commute lowers per-passenger tailpipe emissions. ${aqi > 200 ? 'Wear a fitted N95 respirator at road-level stops.' : 'Wait away from busy curbside idling lanes.'}`,
    'wfh-walk': `Schedule walking errands during ${daytimeWindow ? `the practical daytime window (${daytimeWindow.label})` : 'midday well-mixed hours'} along lower-traffic side streets.`
  };

  const cookingAdvice = profile.cookingFuel === 'induction'
    ? 'Continue electric/induction cooking with pan lids and kitchen exhaust during high-heat frying to capture cooking aerosols.'
    : profile.cookingFuel === 'lpg-exhaust'
      ? 'Run ducted kitchen exhaust throughout cooking and for 10 minutes afterward; shift boiling/simmering to an electric kettle or induction plate when windows stay closed.'
      : 'Unvented gas or solid-fuel cooking sharply raises indoor NO₂ and PM2.5. Crack a kitchen window with an outward exhaust fan during meal prep, cover pans, and shift boiling tasks to electric appliances where feasible.';

  const vulnerabilityNote = {
    kids: 'Remove outdoor shoes at the entry, shift vigorous youth sports indoors when AQI exceeds 200, and follow pediatrician guidance for any child with asthma.',
    'seniors-asthma': 'Keep prescribed inhalers/medications accessible, prioritize a filtered room on Poor/Severe days, and consult a clinician promptly for respiratory symptoms.',
    'multi-gen': 'Maintain one well-sealed shared room with mechanical filtration for children and older adults during high-stagnation periods.',
    general: 'Avoid intense outdoor cardio during peak accumulation windows and stay hydrated.'
  }[profile.householdProfile];

  return [
    {
      id: 'daytime-activity',
      phase: 'Practical Daytime Activity Period',
      window: daytimeWindow ? `Daytime: ${daytimeWindow.label}` : 'Daylight Window Pending',
      condition: daytimeWindow
        ? `Projected PM2.5: ${daytimeWindow.avgPm25} µg/m³ (${daytimeWindow.deltaText}). Sunrise ${disp.daylight.sunriseLabel} · Sunset ${disp.daylight.sunsetLabel}. ${weatherNote}`
        : `24-hr rolling PM2.5: ${pm25_24h} µg/m³. ${weatherNote}`,
      action: aqi > 200
        ? `Prioritize indoor movement today rather than outdoor workouts. If outdoor errands are necessary, use the cleanest practical daytime period (${daytimeWindow ? daytimeWindow.label : 'midday'}).${lowestContext}${rainWarning}`
        : aqi > 100
          ? `Schedule light-to-moderate daytime outdoor activity during ${daytimeWindow ? daytimeWindow.label : 'well-mixed daylight hours'} away from arterial traffic.${lowestContext}${rainWarning}`
          : `Daytime conditions (${daytimeWindow ? daytimeWindow.label : 'daylight hours'}) are favorable for normal outdoor activity.${rainWarning}`,
      basis: 'Constrained strictly to local sunrise–sunset daylight hours and precipitation forecasts; lower pollution reduces risk without guaranteeing safety.'
    },
    {
      id: 'commute-school',
      phase: 'Work & School Commute Guidance',
      window: `${profile.dailyCommuteKm} km · ${profile.commuteMode}`,
      condition: `Est. AQI ${aqi} (${intel?.cpcb?.band?.label || 'N/A'}) · Primary pollutant: ${intel?.cpcb?.primaryPollutant?.name || 'PM2.5'}`,
      action: `${commuteMap[profile.commuteMode]} ${vulnerabilityNote}`,
      basis: 'Tailored to commute mode, daily distance, and household vulnerability.'
    },
    {
      id: 'ventilation',
      phase: 'Daytime Ventilation Window',
      window: ventWindow ? `Flush: ${ventWindow.label}` : 'Monitor Daylight PM2.5',
      condition: disp?.classification || 'Modeled dispersion estimate',
      action: ventWindow
        ? ventWindow.guidance
        : 'Keep exterior openings closed during stagnation; flush briefly during lower-haze daylight periods to manage indoor CO₂.',
      basis: 'Aligned to practical daytime Ventilation Coefficient (BLH × 10m wind speed) rather than overnight minimums.'
    },
    {
      id: 'cooking',
      phase: 'Kitchen & Indoor Combustion Control',
      window: 'During Meal Prep',
      condition: `Fuel setup: ${profile.cookingFuel} · Avoid incense, candles, and mosquito coils during elevated AQI`,
      action: cookingAdvice,
      basis: 'Indoor combustion emits both PM2.5 and gaseous NO₂/CO; True HEPA captures particles only, not gases.'
    },
    {
      id: 'indoor-filtration',
      phase: 'Indoor Protection & Filtration Target',
      window: `${profile.roomSqFt} sq.ft · ${profile.ceilingHeightFt} ft ceiling`,
      condition: `Room volume ${indoorEval.dimensions.volumeM3} m³ · Target ${indoorEval.sizing.recommendedAch} ACH`,
      action: aqi > 100
        ? `Operate mechanical True HEPA filtration (recommended CADR ≥ ${indoorEval.sizing.recommendedCadrM3h} m³/h; ionizer OFF). Under ${indoorEval.assumptions.leakageLabel.toLowerCase()} assumptions, modeled steady-state indoor PM2.5 drops from ${indoorEval.outcomes.unfilteredIndoorPm25} µg/m³ to ${indoorEval.outcomes.filteredIndoorPm25} µg/m³ (uncertainty range ${indoorEval.outcomes.filteredRange[0]}–${indoorEval.outcomes.filteredRange[1]} µg/m³).`
        : 'Active HEPA filtration is optional today unless cooking smoke, indoor dust, or allergies are present.',
      basis: 'Computed from single-zone steady-state mass-balance physics (infiltration + deposition + CADR).'
    },
    {
      id: 'evening-night',
      phase: 'Evening & Overnight Recovery',
      window: eveningWatch ? `Night Watch: ${eveningWatch.label}` : 'Evening to Dawn',
      condition: eveningWatch
        ? `Peak overnight/evening accumulation risk: ${eveningWatch.label} (Projected PM2.5: ${eveningWatch.avgPm25} µg/m³). Next 6h trend: ${disp?.trend || 'steady'}.`
        : 'Monitor evening radiative cooling and boundary-layer compression.',
      action: aqi > 150 || (eveningWatch && eveningWatch.avgPm25 > 60)
        ? 'Close exterior windows and door gaps before evening wind drops compress the surface boundary layer. Damp-mop floors instead of dry sweeping and run bedroom filtration on quiet night mode.'
        : 'Maintain normal bedroom comfort, avoid outdoor waste/leaf burning, and check morning air quality before early workouts.',
      basis: 'Tracks evening-to-dawn stagnation separately from daytime peaks.'
    }
  ];
}