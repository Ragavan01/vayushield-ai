/**
 * @fileoverview Atmospheric dispersion & practical daylight activity window engine.
 * Separates overnight minimums from sunrise-to-sunset activity windows and never
 * mislabels surface stagnation as a confirmed radiosonde temperature inversion.
 */

import { calculatePollutantSubIndex } from './cpcbAqi.js';
import { formatProjectedAndDelta, sanitizeConcentration } from './dataIntegrity.js';
import { clampNumber } from './security.js';

/**
 * Converts wind speed from km/h to m/s within safe physical bounds.
 * @param {unknown} kmh
 * @returns {number}
 */
export function kmhToMs(kmh) {
  return Number((clampNumber(kmh, 0, 250, 0) / 3.6).toFixed(2));
}

/**
 * Computes atmospheric Ventilation Coefficient (VC = BLH × 10m wind speed) and stagnation risk.
 * @param {number | null | undefined} blhMeters
 * @param {number | null | undefined} windKmh
 * @returns {{ vc: number | null, windMs: number | null, category: string, riskLevel: string }}
 */
export function computeVentilationCoefficient(blhMeters, windKmh) {
  if (typeof blhMeters !== 'number' || !Number.isFinite(blhMeters) || typeof windKmh !== 'number' || !Number.isFinite(windKmh)) {
    return { vc: null, windMs: null, category: 'Unknown / Insufficient Evidence', riskLevel: 'unknown' };
  }
  const safeBlh = clampNumber(blhMeters, 20, 6000, 300);
  const windMs = kmhToMs(windKmh);
  const vc = Math.round(safeBlh * windMs);

  if (vc < 2000 || (safeBlh < 280 && windMs < 2.0)) {
    return { vc, windMs, category: 'Atmospheric Stagnation Risk', riskLevel: 'high' };
  }
  if (vc < 6000) return { vc, windMs, category: 'Limited Dispersion', riskLevel: 'moderate' };
  return { vc, windMs, category: 'Favorable Dispersion', riskLevel: 'low' };
}

/**
 * Converts meteorological wind degrees (0–360) into an 8-point compass direction.
 * @param {number | null | undefined} deg
 * @returns {string}
 */
export function degreesToCompass(deg) {
  if (typeof deg !== 'number' || !Number.isFinite(deg)) return 'N/A';
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

function extractHourNumber(iso) {
  if (typeof iso !== 'string') return null;
  const m = iso.match(/T(\d{2}):(\d{2})/);
  return m ? Number(m[1]) + Number(m[2]) / 60 : null;
}

function formatHour(iso) {
  if (typeof iso !== 'string') return '--:--';
  const m = iso.match(/T(\d{2}:\d{2})/);
  return m ? m[1] : iso.slice(-5);
}

function isDaytimeHour(iso, daylight) {
  const hr = extractHourNumber(iso);
  if (hr === null) return false;
  return hr >= Math.max(6, daylight.sunriseHour ?? 6.5) && hr <= Math.min(20, daylight.sunsetHour ?? 18.5);
}

function summarizeWindow(slice, referencePm25) {
  const avgPm25 = sanitizeConcentration(slice.reduce((s, p) => s + p.pm25, 0) / slice.length, 1);
  const vcPoints = slice.filter((p) => typeof p.vc === 'number');
  const avgVc = vcPoints.length ? Math.round(vcPoints.reduce((s, p) => s + p.vc, 0) / vcPoints.length) : null;
  const maxPrecipMm = Math.max(0, ...slice.map((p) => (typeof p.precipMm === 'number' ? p.precipMm : 0)));
  const comparison = formatProjectedAndDelta(avgPm25, referencePm25, 'µg/m³');

  return {
    startHour: slice[0].hourLabel,
    endHour: slice[slice.length - 1].hourLabel,
    label: `${slice[0].hourLabel}–${slice[slice.length - 1].hourLabel}`,
    avgPm25,
    avgVc,
    maxPrecipMm: Number(maxPrecipMm.toFixed(1)),
    isDaytime: slice.every((p) => p.isDaytime),
    projectedText: comparison.projectedText,
    deltaText: comparison.deltaText,
    delta: comparison.delta
  };
}

function enrichSinglePoint(pt, daylight) {
  if (!pt || typeof pt.time !== 'string') return null;
  const pm25 = sanitizeConcentration(pt.pm25, 1);
  if (pm25 === null) return null;

  const blh = typeof pt.blh === 'number' && Number.isFinite(pt.blh) ? Math.round(Math.max(20, pt.blh)) : null;
  const windKmh = typeof pt.windKmh === 'number' && Number.isFinite(pt.windKmh) ? Number(Math.max(0, pt.windKmh).toFixed(1)) : null;
  const precipMm = typeof pt.precipMm === 'number' && Number.isFinite(pt.precipMm) ? Number(Math.max(0, pt.precipMm).toFixed(1)) : null;
  const solarWm2 = typeof pt.solarWm2 === 'number' && Number.isFinite(pt.solarWm2) ? Math.round(Math.max(0, pt.solarWm2)) : null;
  const disp = computeVentilationCoefficient(blh, windKmh);
  const sub = calculatePollutantSubIndex('pm25', pm25);

  return {
    time: pt.time,
    hourLabel: formatHour(pt.time),
    isDaytime: isDaytimeHour(pt.time, daylight),
    pm25,
    pm10: sanitizeConcentration(pt.pm10, 1),
    no2: sanitizeConcentration(pt.no2, 1),
    indicativePm25Index: sub ? sub.subIndex : null,
    blh,
    windKmh,
    windMs: disp.windMs,
    windCompass: degreesToCompass(pt.windDir),
    tempC: typeof pt.tempC === 'number' && Number.isFinite(pt.tempC) ? Number(pt.tempC.toFixed(1)) : null,
    rhPct: typeof pt.rhPct === 'number' && Number.isFinite(pt.rhPct) ? Math.round(clampNumber(pt.rhPct, 0, 100, 50)) : null,
    precipMm,
    solarWm2,
    vc: disp.vc,
    dispersionCategory: disp.category,
    riskLevel: disp.riskLevel
  };
}

function buildUnavailableForecast(context) {
  return {
    available: false,
    classification: 'Unknown — Insufficient Atmospheric Forecast Evidence',
    hourly: [],
    lowestPollutionWindow: null,
    bestDaytimeWindow: null,
    bestOutdoorWindow: null,
    bestVentilationWindow: null,
    peakAccumulationWindow: null,
    eveningWatchWindow: null,
    daylight: { sunriseLabel: formatHour(context.sunriseIso), sunsetLabel: formatHour(context.sunsetIso) },
    trend: 'unavailable',
    trendDeltaPct: 0,
    confidence: {
      level: 'Low',
      factors: ['Fewer than 6 valid hourly forecast points returned by upstream provider.'],
      reason: 'Insufficient hourly data to compute reliable dispersion or activity windows.'
    },
    methodologyNote: 'Requires hourly modeled PM2.5, boundary-layer height, and 10m wind speed.'
  };
}

function findForecastWindows(enriched, refPm25) {
  let lowestPollutionWindow = null;
  let bestDaytimeWindow = null;
  let peakAccumulationWindow = null;
  let eveningWatchWindow = null;

  for (let i = 0; i <= enriched.length - 3; i++) {
    const slice = enriched.slice(i, i + 3);
    const candidate = summarizeWindow(slice, refPm25);

    if (!lowestPollutionWindow || candidate.avgPm25 < lowestPollutionWindow.avgPm25) lowestPollutionWindow = candidate;
    if (!peakAccumulationWindow || candidate.avgPm25 > peakAccumulationWindow.avgPm25) peakAccumulationWindow = candidate;

    if (candidate.isDaytime) {
      const candDry = candidate.maxPrecipMm < 1.5;
      const bestDry = bestDaytimeWindow ? bestDaytimeWindow.maxPrecipMm < 1.5 : false;
      if (!bestDaytimeWindow || (candDry && !bestDry) || (candDry === bestDry && candidate.avgPm25 < bestDaytimeWindow.avgPm25)) {
        bestDaytimeWindow = candidate;
      }
    }

    const startHr = extractHourNumber(slice[0].time);
    if (startHr !== null && (startHr >= 18 || startHr <= 5)) {
      if (!eveningWatchWindow || candidate.avgPm25 > eveningWatchWindow.avgPm25) eveningWatchWindow = candidate;
    }
  }

  return { lowestPollutionWindow, bestDaytimeWindow, peakAccumulationWindow, eveningWatchWindow };
}

function buildVentilationWindow(ventTarget) {
  if (!ventTarget) return null;
  const suitableForOpenFlush = ventTarget.avgPm25 <= 60;
  return {
    ...ventTarget,
    suitableForOpenFlush,
    guidance: suitableForOpenFlush
      ? `Best practical daytime window is ${ventTarget.label} (Projected PM2.5: ${ventTarget.avgPm25} µg/m³). Suitable for brief cross-ventilation${ventTarget.maxPrecipMm >= 1.5 ? ' once rain clears' : ''}.`
      : `Best daytime window (${ventTarget.label}) still averages ${ventTarget.avgPm25} µg/m³ PM2.5. Keep open-window flushing to 10–15 minutes to control indoor CO₂ and rely on mechanical True HEPA filtration.`
  };
}

function buildConfidenceAndClass(enriched, gridResolution) {
  const hasBlh = enriched.some((h) => h.blh !== null);
  const hasWind = enriched.some((h) => h.windKmh !== null);
  const hasPrecip = enriched.some((h) => h.precipMm !== null);
  const hasSolar = enriched.some((h) => h.solarWm2 !== null);

  const missingVars = [
    !hasBlh && 'boundary-layer height',
    !hasWind && '10m wind speed',
    !hasPrecip && 'precipitation',
    !hasSolar && 'solar radiation'
  ].filter(Boolean);

  const factors = [
    `Variable coverage: ${hasBlh && hasWind ? 'PM2.5, BLH, and 10m wind present' : `Missing ${missingVars.join(', ')}`}.`,
    `Spatial resolution: ${gridResolution || 'Regional/Global CAMS model grid'} (averages over wide grid cells; cannot resolve street-canyon spikes).`,
    'Forecast horizon: Reliability is highest in hours 1–6 and decreases toward hours 18–24.',
    'Vertical profile: No local radiosonde temperature profile; stagnation risk is inferred from surface BLH × wind speed.'
  ];

  const hasSevereStagnation = enriched.some((h) => h.riskLevel === 'high');
  const classification = !hasBlh || !hasWind
    ? 'Limited Atmospheric Evidence (Pollutant Model Only)'
    : hasSevereStagnation
      ? 'General Atmospheric Stagnation Risk (Modeled BLH & Wind — Not Confirmed Radiosonde Inversion)'
      : 'Dispersion Conditions Estimate (Modeled BLH & Wind)';

  return {
    classification,
    confidence: {
      level: hasBlh && hasWind ? 'Moderate (Model-Indicated)' : 'Low–Moderate (Partial Variables)',
      factors,
      reason: factors.join(' ')
    }
  };
}

/**
 * Analyzes 24 hours of real hourly AQ + meteorological forecast points into dispersion windows and trends.
 * @param {Array<Record<string, any>>} hourlyForecast
 * @param {{ sunriseIso?: string | null, sunsetIso?: string | null, referencePm25?: number | null, gridResolution?: string }} [context={}]
 * @returns {Record<string, any>}
 */
export function analyzeDispersionForecast(hourlyForecast, context = {}) {
  const daylight = {
    sunriseHour: extractHourNumber(context.sunriseIso) ?? 6.5,
    sunsetHour: extractHourNumber(context.sunsetIso) ?? 18.5
  };
  const rawPoints = (Array.isArray(hourlyForecast) ? hourlyForecast : []).slice(0, 24);
  const enriched = rawPoints.map((pt) => enrichSinglePoint(pt, daylight)).filter(Boolean);

  if (enriched.length < 6) return buildUnavailableForecast(context);

  const refPm25 = sanitizeConcentration(context.referencePm25, 1) ?? enriched[0].pm25;
  const windows = findForecastWindows(enriched, refPm25);
  const futureSlice = enriched.slice(3, Math.min(9, enriched.length));
  const futureAvg = futureSlice.reduce((s, p) => s + p.pm25, 0) / futureSlice.length;
  const deltaPct = enriched[0].pm25 > 0 ? Math.round(((futureAvg - enriched[0].pm25) / enriched[0].pm25) * 100) : 0;
  const trend = deltaPct <= -12 ? 'improving' : deltaPct >= 12 ? 'worsening' : 'steady';
  const { classification, confidence } = buildConfidenceAndClass(enriched, context.gridResolution);

  return {
    available: true,
    classification,
    hourly: enriched,
    lowestPollutionWindow: windows.lowestPollutionWindow,
    bestDaytimeWindow: windows.bestDaytimeWindow,
    bestOutdoorWindow: windows.bestDaytimeWindow,
    bestVentilationWindow: buildVentilationWindow(windows.bestDaytimeWindow || windows.lowestPollutionWindow),
    peakAccumulationWindow: windows.peakAccumulationWindow,
    eveningWatchWindow: windows.eveningWatchWindow || windows.peakAccumulationWindow,
    daylight: { sunriseLabel: formatHour(context.sunriseIso), sunsetLabel: formatHour(context.sunsetIso) },
    trend,
    trendDeltaPct: deltaPct,
    confidence,
    methodologyNote:
      'Dispersion conditions use the Ventilation Coefficient (VC = Boundary Layer Height × 10m Wind Speed) alongside local sunrise/sunset and precipitation. Lowest overnight pollution periods are separated from practical daytime activity windows.'
  };
}