/**
 * @fileoverview Air quality physics, CPCB/US AQI classification, winter inversion modeling,
 * and curated Indian & global urban smog baseline datasets.
 */

import { clampNumber } from './security.js';

/**
 * @typedef {Object} AqiBand
 * @property {string} id
 * @property {string} label
 * @property {number} min
 * @property {number} max
 * @property {string} severity
 * @property {string} summary
 * @property {string} maskAdvice
 * @property {string} ventilationWindow
 */

/** @type {readonly AqiBand[]} */
export const AQI_BANDS = Object.freeze([
  Object.freeze({
    id: 'good',
    label: 'Good',
    min: 0,
    max: 50,
    severity: 'low',
    summary: 'Clean ambient air. Ideal for outdoor exercise and natural cross-ventilation.',
    maskAdvice: 'No mask required for general public.',
    ventilationWindow: 'Open windows freely throughout the day.'
  }),
  Object.freeze({
    id: 'satisfactory',
    label: 'Satisfactory',
    min: 51,
    max: 100,
    severity: 'moderate',
    summary: 'Acceptable air quality; minor breathing discomfort possible for ultra-sensitive individuals.',
    maskAdvice: 'Optional mask for asthma patients along heavy traffic corridors.',
    ventilationWindow: 'Ventilate best between 11:00 AM and 4:00 PM.'
  }),
  Object.freeze({
    id: 'moderate',
    label: 'Moderate',
    min: 101,
    max: 200,
    severity: 'elevated',
    summary: 'Noticeable haze and traffic particulates. Vulnerable groups should reduce outdoor exertion.',
    maskAdvice: 'N95/FFP2 recommended for cyclists, seniors, and children on main roads.',
    ventilationWindow: 'Cross-ventilate briefly between 1:00 PM and 3:30 PM when inversion lifts.'
  }),
  Object.freeze({
    id: 'poor',
    label: 'Poor',
    min: 201,
    max: 300,
    severity: 'high',
    summary: 'Winter smog accumulation. Breathing discomfort on prolonged exposure; indoor filtration advised.',
    maskAdvice: 'Wear certified N95/KF94 mask outdoors; avoid cloth or loose surgical masks.',
    ventilationWindow: 'Keep windows sealed mornings & nights; brief 15-min flush only at 2:00 PM.'
  }),
  Object.freeze({
    id: 'very-poor',
    label: 'Very Poor',
    min: 301,
    max: 400,
    severity: 'very-high',
    summary: 'Severe winter smog conditions. High respiratory stress for families; switch to low-emission indoor routines.',
    maskAdvice: 'Mandatory well-sealed N95 mask outdoors; keep children and seniors indoors.',
    ventilationWindow: 'Keep windows & door gaps sealed; rely on HEPA / DIY Corsi-Rosenthal filtration.'
  }),
  Object.freeze({
    id: 'severe',
    label: 'Severe',
    min: 401,
    max: 500,
    severity: 'critical',
    summary: 'Public health emergency smog layer. Affects healthy people and seriously impacts vulnerable groups.',
    maskAdvice: 'Strict N95/N99 outdoors; suspend non-essential travel and outdoor sports.',
    ventilationWindow: 'Seal indoor envelope completely; run continuous HEPA purification on high.'
  })
]);

/**
 * Curated urban city presets with realistic winter smog telemetry for instant zero-latency exploration.
 */
export const CITY_PRESETS = Object.freeze([
  Object.freeze({
    id: 'delhi-ncr',
    name: 'Delhi NCR',
    region: 'India',
    lat: 28.6139,
    lon: 77.209,
    aqi: 342,
    pm25: 196,
    pm10: 318,
    no2: 68,
    temperatureC: 14,
    humidityPct: 74,
    windKmh: 5.2,
    dominantSource: 'Thermal inversion + vehicular exhaust + regional biomass smoke'
  }),
  Object.freeze({
    id: 'lucknow',
    name: 'Lucknow',
    region: 'India',
    lat: 26.8467,
    lon: 80.9462,
    aqi: 278,
    pm25: 142,
    pm10: 234,
    no2: 49,
    temperatureC: 16,
    humidityPct: 71,
    windKmh: 6.4,
    dominantSource: 'Winter fog trapping urban diesel exhaust & construction dust'
  }),
  Object.freeze({
    id: 'mumbai',
    name: 'Mumbai',
    region: 'India',
    lat: 19.076,
    lon: 72.8777,
    aqi: 174,
    pm25: 82,
    pm10: 158,
    no2: 44,
    temperatureC: 25,
    humidityPct: 68,
    windKmh: 11.5,
    dominantSource: 'Coastal inversion + dense corridor traffic & infrastructure dust'
  }),
  Object.freeze({
    id: 'kolkata',
    name: 'Kolkata',
    region: 'India',
    lat: 22.5726,
    lon: 88.3639,
    aqi: 238,
    pm25: 118,
    pm10: 205,
    no2: 53,
    temperatureC: 19,
    humidityPct: 76,
    windKmh: 7.1,
    dominantSource: 'Evening thermal trapping + humid particulate haze'
  }),
  Object.freeze({
    id: 'bengaluru',
    name: 'Bengaluru',
    region: 'India',
    lat: 12.9716,
    lon: 77.5946,
    aqi: 118,
    pm25: 48,
    pm10: 96,
    no2: 36,
    temperatureC: 20,
    humidityPct: 62,
    windKmh: 12.8,
    dominantSource: 'Peak-hour commuter congestion & localized road dust'
  }),
  Object.freeze({
    id: 'coimbatore',
    name: 'Coimbatore',
    region: 'India',
    lat: 11.0168,
    lon: 76.9558,
    aqi: 88,
    pm25: 32,
    pm10: 68,
    no2: 24,
    temperatureC: 23,
    humidityPct: 64,
    windKmh: 14.2,
    dominantSource: 'Localized industrial corridor emissions & morning mist'
  })
]);

/**
 * Classifies an AQI value (0-500) into its CPCB-aligned severity band.
 * @param {number} aqi
 * @returns {AqiBand}
 */
export function classifyAqi(aqi) {
  const safeAqi = Math.round(clampNumber(aqi, 0, 500, 150));
  return AQI_BANDS.find((band) => safeAqi >= band.min && safeAqi <= band.max) || AQI_BANDS[AQI_BANDS.length - 1];
}

/**
 * Converts PM2.5 concentration (µg/m³) into an Indian CPCB sub-index AQI estimate.
 * @param {number} pm25
 * @returns {number}
 */
export function pm25ToCpcbAqi(pm25) {
  const c = clampNumber(pm25, 0, 600, 50);
  const breakpoints = [
    [0, 30, 0, 50],
    [30, 60, 51, 100],
    [60, 90, 101, 200],
    [90, 120, 201, 300],
    [120, 250, 301, 400],
    [250, 500, 401, 500]
  ];

  for (const [cLow, cHigh, iLow, iHigh] of breakpoints) {
    if (c <= cHigh) {
      return Math.round(((iHigh - iLow) / (cHigh - cLow)) * (c - cLow) + iLow);
    }
  }
  return 500;
}

/**
 * Estimates Berkeley Earth daily cigarette equivalence for passive PM2.5 exposure.
 * Rule of thumb: 22 µg/m³ of 24-hour PM2.5 ≈ 1 cigarette/day.
 * @param {number} pm25
 * @returns {number}
 */
export function calculateCigaretteEquivalent(pm25) {
  const safePm25 = clampNumber(pm25, 0, 1000, 0);
  return Number((safePm25 / 22).toFixed(1));
}

/**
 * Generates a 24-hour winter smog thermal-inversion curve (6 key time windows)
 * so families can schedule errands and ventilation during the cleanest afternoon dip.
 * @param {number} baseAqi
 * @param {number} [windKmh=8]
 * @returns {Array<{ window: string, label: string, projectedAqi: number, safeForVentilation: boolean, note: string }>}
 */
export function buildWinterInversionWindows(baseAqi, windKmh = 8) {
  const safeBase = clampNumber(baseAqi, 15, 500, 150);
  const windFactor = windKmh >= 12 ? 0.92 : windKmh <= 6 ? 1.08 : 1.0;

  const schedule = [
    { window: '05:30 – 08:30', label: 'Dawn Inversion Peak', mult: 1.24, note: 'Cold ground air traps overnight smog; avoid outdoor jogging.' },
    { window: '08:30 – 11:30', label: 'Morning Commute Surge', mult: 1.14, note: 'Peak vehicular NO₂ + PM2.5 along arterials.' },
    { window: '11:30 – 14:30', label: 'Midday Mixing Dip', mult: 0.78, note: 'Solar heating lifts inversion layer—safest window for errands.' },
    { window: '14:30 – 17:00', label: 'Afternoon Ventilation Window', mult: 0.72, note: 'Lowest daily particulate concentration; brief cross-ventilation window.' },
    { window: '17:00 – 21:00', label: 'Evening Rush & Cooling', mult: 1.16, note: 'Boundary layer drops rapidly as sunset cools surface air.' },
    { window: '21:00 – 05:30', label: 'Overnight Smog Trap', mult: 1.22, note: 'Keep bedroom doors/windows sealed; run silent HEPA sleep mode.' }
  ];

  return schedule.map((slot) => {
    const projectedAqi = Math.round(clampNumber(safeBase * slot.mult * windFactor, 15, 500, safeBase));
    return {
      window: slot.window,
      label: slot.label,
      projectedAqi,
      safeForVentilation: projectedAqi <= 165,
      note: slot.note
    };
  });
}