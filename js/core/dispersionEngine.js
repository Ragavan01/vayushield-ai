/**
 * @fileoverview Atmospheric dispersion and ventilation-window intelligence using actual
 * hourly modeled Boundary Layer Height (BLH), 10m wind speed, and hourly PM2.5 forecasts.
 *
 * Scientific discipline:
 * - Never claims a confirmed temperature inversion without vertical temperature-profile data.
 * - Uses the Holzworth/IMD Ventilation Coefficient: VC = BLH (m) * windSpeed (m/s).
 * - Calculates location-specific cleaner outdoor and ventilation windows directly from hourly data.
 */

import { calculatePollutantSubIndex } from './cpcbAqi.js';
import { clampNumber } from './security.js';

/**
 * Converts wind speed from km/h to m/s.
 * @param {number} kmh
 * @returns {number}
 */
export function kmhToMs(kmh) {
  return Number((clampNumber(kmh, 0, 250, 0) / 3.6).toFixed(2));
}

/**
 * Computes atmospheric Ventilation Coefficient (m²/s) = BLH (m) * windSpeed (m/s).
 * Standard IMD/Holzworth thresholds:
 * - < 2,000 m²/s: High Stagnation Risk (severe pollutant trapping)
 * - 2,000–6,000 m²/s: Limited Dispersion (moderate accumulation)
 * - >= 6,000 m²/s: Favorable Dispersion (active vertical/horizontal mixing)
 * @param {number | null} blhMeters
 * @param {number | null} windKmh
 */
export function computeVentilationCoefficient(blhMeters, windKmh) {
  if (typeof blhMeters !== 'number' || !Number.isFinite(blhMeters) || typeof windKmh !== 'number' || !Number.isFinite(windKmh)) {
    return { vc: null, windMs: null, category: 'Unavailable', riskLevel: 'unknown' };
  }
  const safeBlh = clampNumber(blhMeters, 20, 6000, 300);
  const windMs = kmhToMs(windKmh);
  const vc = Math.round(safeBlh * windMs);

  if (vc < 2000 || (safeBlh < 280 && windMs < 2.0)) {
    return { vc, windMs, category: 'High Stagnation Risk', riskLevel: 'high' };
  }
  if (vc < 6000) {
    return { vc, windMs, category: 'Limited Dispersion', riskLevel: 'moderate' };
  }
  return { vc, windMs, category: 'Favorable Dispersion', riskLevel: 'low' };
}

/**
 * Converts wind direction degrees (0-360) into compass cardinal label.
 * @param {number | null} deg
 */
export function degreesToCompass(deg) {
  if (typeof deg !== 'number' || !Number.isFinite(deg)) return 'N/A';
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

/**
 * Formats an ISO local hour string (e.g., "2026-11-23T14:00") to clean 24h label "14:00".
 * @param {string} iso
 */
function formatHour(iso) {
  if (typeof iso !== 'string') return '--:--';
  const match = iso.match(/T(\d{2}:\d{2})/);
  return match ? match[1] : iso.slice(-5);
}

/**
 * Analyzes the next 24 hours of real hourly AQ + weather forecast points.
 * @param {Array<{ time: string, pm25: number | null, pm10?: number | null, no2?: number | null, blh?: number | null, windKmh?: number | null, windDir?: number | null, tempC?: number | null, rhPct?: number | null }>} hourlyForecast
 */
export function analyzeDispersionForecast(hourlyForecast) {
  const validPoints = (Array.isArray(hourlyForecast) ? hourlyForecast : [])
    .slice(0, 24)
    .filter((pt) => pt && typeof pt.pm25 === 'number' && Number.isFinite(pt.pm25));

  if (validPoints.length < 6) {
    return {
      available: false,
      classification: 'Insufficient hourly forecast data',
      hourly: [],
      bestOutdoorWindow: null,
      bestVentilationWindow: null,
      peakAccumulationWindow: null,
      trend: 'unavailable',
      confidence: { level: 'Low', reason: 'Fewer than 6 valid hourly forecast points returned by upstream model.' },
      methodologyNote: 'Requires hourly modeled PM2.5, boundary-layer height, and 10m wind speed.'
    };
  }

  let hasBlh = false;
  let hasWind = false;

  const enriched = validPoints.map((pt) => {
    const blh = typeof pt.blh === 'number' && Number.isFinite(pt.blh) ? Math.round(pt.blh) : null;
    const windKmh = typeof pt.windKmh === 'number' && Number.isFinite(pt.windKmh) ? Number(pt.windKmh.toFixed(1)) : null;
    if (blh !== null) hasBlh = true;
    if (windKmh !== null) hasWind = true;

    const disp = computeVentilationCoefficient(blh, windKmh);
    const sub = calculatePollutantSubIndex('pm25', pt.pm25);

    return {
      time: pt.time,
      hourLabel: formatHour(pt.time),
      pm25: Number(pt.pm25.toFixed(1)),
      pm10: typeof pt.pm10 === 'number' ? Number(pt.pm10.toFixed(1)) : null,
      no2: typeof pt.no2 === 'number' ? Number(pt.no2.toFixed(1)) : null,
      indicativePm25Index: sub ? sub.subIndex : null,
      blh,
      windKmh,
      windMs: disp.windMs,
      windCompass: degreesToCompass(pt.windDir),
      tempC: typeof pt.tempC === 'number' ? Number(pt.tempC.toFixed(1)) : null,
      rhPct: typeof pt.rhPct === 'number' ? Math.round(pt.rhPct) : null,
      vc: disp.vc,
      dispersionCategory: disp.category,
      riskLevel: disp.riskLevel
    };
  });

  // Identify best contiguous 3-hour cleaner window and worst 3-hour accumulation window
  const windowSize = 3;
  let bestWindow = null;
  let worstWindow = null;

  for (let i = 0; i <= enriched.length - windowSize; i++) {
    const slice = enriched.slice(i, i + windowSize);
    const avgPm25 = Number((slice.reduce((s, p) => s + p.pm25, 0) / windowSize).toFixed(1));
    const avgVcPoints = slice.filter((p) => typeof p.vc === 'number');
    const avgVc = avgVcPoints.length
      ? Math.round(avgVcPoints.reduce((s, p) => s + p.vc, 0) / avgVcPoints.length)
      : null;

    const candidate = {
      startHour: slice[0].hourLabel,
      endHour: slice[slice.length - 1].hourLabel,
      avgPm25,
      avgVc,
      label: `${slice[0].hourLabel}–${slice[slice.length - 1].hourLabel}`
    };

    if (!bestWindow || candidate.avgPm25 < bestWindow.avgPm25) {
      bestWindow = candidate;
    }
    if (!worstWindow || candidate.avgPm25 > worstWindow.avgPm25) {
      worstWindow = candidate;
    }
  }

  // Trend over next 6 hours vs current hour
  const currentPm25 = enriched[0].pm25;
  const futureSlice = enriched.slice(3, Math.min(9, enriched.length));
  const futureAvg = futureSlice.reduce((s, p) => s + p.pm25, 0) / futureSlice.length;
  const deltaPct = currentPm25 > 0 ? Math.round(((futureAvg - currentPm25) / currentPm25) * 100) : 0;

  let trend = 'steady';
  if (deltaPct <= -12) trend = 'improving';
  else if (deltaPct >= 12) trend = 'worsening';

  // Ventilation safety check: only recommend open-window flushing if lowest PM2.5 is meaningfully lower & not severe
  const ventilationSuitable = bestWindow && bestWindow.avgPm25 <= 90;
  const bestVentilationWindow = bestWindow
    ? {
        ...bestWindow,
        suitableForOpenFlush: ventilationSuitable,
        guidance: ventilationSuitable
          ? `Lowest modeled PM2.5 (${bestWindow.avgPm25} µg/m³) occurs ${bestWindow.label}; suitable for brief cross-ventilation.`
          : `Even the cleanest forecasted window (${bestWindow.label}) averages ${bestWindow.avgPm25} µg/m³ PM2.5; limit open-window flushing to 10–15 minutes to clear indoor CO₂ and rely on mechanical HEPA filtration.`
      }
    : null;

  const confidence = hasBlh && hasWind
    ? {
        level: 'Moderate (Model-Based)',
        reason: 'Combines hourly CAMS particulate forecasts (~40 km global grid) with modeled boundary-layer height and 10m wind speed. Local street-level spikes and unmodeled biomass burning can cause actual readings to differ.'
      }
    : {
        level: 'Low–Moderate (AQ-Only Model)',
        reason: 'Atmospheric boundary-layer height or wind telemetry was partially unavailable; windows reflect modeled PM2.5 trends only.'
      };

  return {
    available: true,
    classification: hasBlh
      ? 'Dispersion-Risk Estimate (Modeled BLH & Wind — Not Radiosonde Inversion)'
      : 'Hourly Modeled PM2.5 Forecast (No Vertical Profile)',
    hourly: enriched,
    bestOutdoorWindow: bestWindow,
    bestVentilationWindow,
    peakAccumulationWindow: worstWindow,
    trend,
    trendDeltaPct: deltaPct,
    confidence,
    methodologyNote:
      'Dispersion risk is derived from the Ventilation Coefficient (VC = Boundary Layer Height × 10m Wind Speed). Because vertical radiosonde temperature profiles are not measured here, trapping periods are classified as stagnation/dispersion risk rather than confirmed thermal inversions.'
  };
}