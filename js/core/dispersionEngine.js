/**
 * @fileoverview Atmospheric dispersion & practical activity window engine (Project Chimera v2.5).
 *
 * Upgrades:
 * - Separates Lowest Modeled Pollution Period (may occur overnight) from Best Practical Daytime Window
 *   constrained by actual location sunrise/sunset and precipitation checks (FIX 02).
 * - Never labels surface stagnation as a confirmed radiosonde temperature inversion.
 * - Computes multi-factor qualitative confidence from variable coverage, resolution, and horizon.
 * - Rejects negative pollutant concentrations at ingestion (FIX 01 & FIX 07).
 */

import { calculatePollutantSubIndex } from './cpcbAqi.js';
import { formatProjectedAndDelta, sanitizeConcentration } from './dataIntegrity.js';
import { clampNumber } from './security.js';

export function kmhToMs(kmh) {
  return Number((clampNumber(kmh, 0, 250, 0) / 3.6).toFixed(2));
}

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
  if (vc < 6000) {
    return { vc, windMs, category: 'Limited Dispersion', riskLevel: 'moderate' };
  }
  return { vc, windMs, category: 'Favorable Dispersion', riskLevel: 'low' };
}

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

/**
 * Determines whether an ISO hour falls within practical local daylight hours
 * using actual sunrise/sunset from Open-Meteo (defaults safely to 06:30–18:30 if unavailable).
 * @param {string} iso
 * @param {{ sunriseHour?: number, sunsetHour?: number }} daylight
 */
function isDaytimeHour(iso, daylight) {
  const hr = extractHourNumber(iso);
  if (hr === null) return false;
  const start = Math.max(6, daylight.sunriseHour ?? 6.5);
  const end = Math.min(20, daylight.sunsetHour ?? 18.5);
  return hr >= start && hr <= end;
}

/**
 * Evaluates a contiguous 3-hour window from an array of enriched hourly points.
 */
function summarizeWindow(slice, referencePm25) {
  const avgPm25 = sanitizeConcentration(
    slice.reduce((s, p) => s + p.pm25, 0) / slice.length,
    1
  );
  const vcPoints = slice.filter((p) => typeof p.vc === 'number');
  const avgVc = vcPoints.length
    ? Math.round(vcPoints.reduce((s, p) => s + p.vc, 0) / vcPoints.length)
    : null;
  const maxPrecipMm = Math.max(0, ...slice.map((p) => (typeof p.precipMm === 'number' ? p.precipMm : 0)));
  const isDaytime = slice.every((p) => p.isDaytime);
  const comparison = formatProjectedAndDelta(avgPm25, referencePm25, 'µg/m³');

  return {
    startHour: slice[0].hourLabel,
    endHour: slice[slice.length - 1].hourLabel,
    label: `${slice[0].hourLabel}–${slice[slice.length - 1].hourLabel}`,
    avgPm25,
    avgVc,
    maxPrecipMm: Number(maxPrecipMm.toFixed(1)),
    isDaytime,
    projectedText: comparison.projectedText,
    deltaText: comparison.deltaText,
    delta: comparison.delta
  };
}

/**
 * Analyzes 24 hours of real hourly AQ + meteorological forecast points.
 * @param {Array<{ time: string, pm25: number | null, pm10?: number | null, no2?: number | null, blh?: number | null, windKmh?: number | null, windDir?: number | null, tempC?: number | null, rhPct?: number | null, precipMm?: number | null, solarWm2?: number | null }>} hourlyForecast
 * @param {{ sunriseIso?: string | null, sunsetIso?: string | null, referencePm25?: number | null, gridResolution?: string }} [context]
 */
export function analyzeDispersionForecast(hourlyForecast, context = {}) {
  const sunriseHour = extractHourNumber(context.sunriseIso) ?? 6.5;
  const sunsetHour = extractHourNumber(context.sunsetIso) ?? 18.5;
  const daylight = { sunriseHour, sunsetHour };

  const rawPoints = (Array.isArray(hourlyForecast) ? hourlyForecast : []).slice(0, 24);
  let hasBlh = false;
  let hasWind = false;
  let hasPrecip = false;
  let hasSolar = false;

  const enriched = rawPoints
    .map((pt) => {
      if (!pt || typeof pt.time !== 'string') return null;
      const pm25 = sanitizeConcentration(pt.pm25, 1);
      if (pm25 === null) return null;

      const blh = typeof pt.blh === 'number' && Number.isFinite(pt.blh) ? Math.round(Math.max(20, pt.blh)) : null;
      const windKmh = typeof pt.windKmh === 'number' && Number.isFinite(pt.windKmh) ? Number(Math.max(0, pt.windKmh).toFixed(1)) : null;
      const precipMm = typeof pt.precipMm === 'number' && Number.isFinite(pt.precipMm) ? Number(Math.max(0, pt.precipMm).toFixed(1)) : null;
      const solarWm2 = typeof pt.solarWm2 === 'number' && Number.isFinite(pt.solarWm2) ? Math.round(Math.max(0, pt.solarWm2)) : null;

      if (blh !== null) hasBlh = true;
      if (windKmh !== null) hasWind = true;
      if (precipMm !== null) hasPrecip = true;
      if (solarWm2 !== null) hasSolar = true;

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
    })
    .filter(Boolean);

  if (enriched.length < 6) {
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

  const refPm25 = sanitizeConcentration(context.referencePm25, 1) ?? enriched[0].pm25;
  const windowSize = 3;

  let lowestPollutionWindow = null;
  let bestDaytimeWindow = null;
  let peakAccumulationWindow = null;
  let eveningWatchWindow = null;

  for (let i = 0; i <= enriched.length - windowSize; i++) {
    const slice = enriched.slice(i, i + windowSize);
    const candidate = summarizeWindow(slice, refPm25);

    if (!lowestPollutionWindow || candidate.avgPm25 < lowestPollutionWindow.avgPm25) {
      lowestPollutionWindow = candidate;
    }
    if (!peakAccumulationWindow || candidate.avgPm25 > peakAccumulationWindow.avgPm25) {
      peakAccumulationWindow = candidate;
    }

    // Practical daytime window: strictly within local sunrise–sunset, preferring dry hours
    if (candidate.isDaytime) {
      const candidateDry = candidate.maxPrecipMm < 1.5;
      const bestDry = bestDaytimeWindow ? bestDaytimeWindow.maxPrecipMm < 1.5 : false;
      if (
        !bestDaytimeWindow ||
        (candidateDry && !bestDry) ||
        (candidateDry === bestDry && candidate.avgPm25 < bestDaytimeWindow.avgPm25)
      ) {
        bestDaytimeWindow = candidate;
      }
    }

    // Evening / Overnight watch window (starts 18:00–05:00) for accurate Evening Recovery guidance
    const startHr = extractHourNumber(slice[0].time);
    if (startHr !== null && (startHr >= 18 || startHr <= 5)) {
      if (!eveningWatchWindow || candidate.avgPm25 > eveningWatchWindow.avgPm25) {
        eveningWatchWindow = candidate;
      }
    }
  }

  // Next 6-hour trend vs current hour
  const currentPm25 = enriched[0].pm25;
  const futureSlice = enriched.slice(3, Math.min(9, enriched.length));
  const futureAvg = futureSlice.reduce((s, p) => s + p.pm25, 0) / futureSlice.length;
  const deltaPct = currentPm25 > 0 ? Math.round(((futureAvg - currentPm25) / currentPm25) * 100) : 0;

  let trend = 'steady';
  if (deltaPct <= -12) trend = 'improving';
  else if (deltaPct >= 12) trend = 'worsening';

  // Ventilation recommendation always prefers practical daytime window so users aren't told to open windows at 2 AM
  const ventTarget = bestDaytimeWindow || lowestPollutionWindow;
  const ventilationSuitable = ventTarget && ventTarget.avgPm25 <= 60;
  const bestVentilationWindow = ventTarget
    ? {
        ...ventTarget,
        suitableForOpenFlush: ventilationSuitable,
        guidance: ventilationSuitable
          ? `Best practical daytime window is ${ventTarget.label} (Projected PM2.5: ${ventTarget.avgPm25} µg/m³). Suitable for brief cross-ventilation${ventTarget.maxPrecipMm >= 1.5 ? ' once rain clears' : ''}.`
          : `Best daytime window (${ventTarget.label}) still averages ${ventTarget.avgPm25} µg/m³ PM2.5. Keep open-window flushing to 10–15 minutes to control indoor CO₂ and rely on mechanical True HEPA filtration.`
      }
    : null;

  // Multi-factor scientific confidence framework (no arbitrary fake percentages)
  const missingVars = [];
  if (!hasBlh) missingVars.push('boundary-layer height');
  if (!hasWind) missingVars.push('10m wind speed');
  if (!hasPrecip) missingVars.push('precipitation');
  if (!hasSolar) missingVars.push('solar radiation');

  const confidenceFactors = [
    `Variable coverage: ${hasBlh && hasWind ? 'PM2.5, BLH, and 10m wind present' : `Missing ${missingVars.join(', ')}`}.`,
    `Spatial resolution: ${context.gridResolution || 'Regional/Global CAMS model grid'} (averages over wide grid cells; cannot resolve street-canyon spikes).`,
    'Forecast horizon: Reliability is highest in hours 1–6 and decreases toward hours 18–24.',
    'Vertical profile: No local radiosonde temperature profile; stagnation risk is inferred from surface BLH × wind speed.'
  ];

  const confidenceLevel = hasBlh && hasWind ? 'Moderate (Model-Indicated)' : 'Low–Moderate (Partial Variables)';

  // Classification strictly follows vertical-evidence discipline
  const hasSevereStagnation = enriched.some((h) => h.riskLevel === 'high');
  const classification = !hasBlh || !hasWind
    ? 'Limited Atmospheric Evidence (Pollutant Model Only)'
    : hasSevereStagnation
      ? 'General Atmospheric Stagnation Risk (Modeled BLH & Wind — Not Confirmed Radiosonde Inversion)'
      : 'Dispersion Conditions Estimate (Modeled BLH & Wind)';

  return {
    available: true,
    classification,
    hourly: enriched,
    lowestPollutionWindow,
    bestDaytimeWindow,
    // Keep bestOutdoorWindow pointing strictly to practical daytime window (never 01:00–03:00)
    bestOutdoorWindow: bestDaytimeWindow,
    bestVentilationWindow,
    peakAccumulationWindow,
    eveningWatchWindow: eveningWatchWindow || peakAccumulationWindow,
    daylight: {
      sunriseLabel: formatHour(context.sunriseIso),
      sunsetLabel: formatHour(context.sunsetIso)
    },
    trend,
    trendDeltaPct: deltaPct,
    confidence: {
      level: confidenceLevel,
      factors: confidenceFactors,
      reason: confidenceFactors.join(' ')
    },
    methodologyNote:
      'Dispersion conditions use the Ventilation Coefficient (VC = Boundary Layer Height × 10m Wind Speed) alongside local sunrise/sunset and precipitation. Lowest overnight pollution periods are separated from practical daytime activity windows.'
  };
}