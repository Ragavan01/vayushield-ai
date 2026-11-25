/**
 * @fileoverview Pure atmospheric telemetry parsing, rolling-window computation,
 * forecast/history slicing, and normalized environmental record assembly.
 */

import { calculateCpcbAqi, coUgToMg, computeRollingAverage } from '../core/cpcbAqi.js';
import { createEnvironmentalReading, evaluateDataFreshness, sanitizeConcentration } from '../core/dataIntegrity.js';
import { analyzeDispersionForecast } from '../core/dispersionEngine.js';
import { sanitizeText } from '../core/security.js';

/**
 * Locates the index in an hourly timestamp array matching the current measurement hour.
 * @param {string[]} times
 * @param {string | undefined} currentIso
 * @returns {number}
 */
export function findCurrentHourIndex(times, currentIso) {
  if (!Array.isArray(times) || times.length === 0) return 0;
  if (currentIso) {
    const exactIdx = times.findIndex((t) => typeof t === 'string' && t.startsWith(currentIso.slice(0, 13)));
    if (exactIdx >= 0) return exactIdx;
  }
  return Math.max(0, Math.min(24, times.length - 1));
}

/**
 * Computes a directional pollutant trend relative to its rolling baseline.
 * @param {number | null} currentVal
 * @param {number | null} baselineVal
 * @returns {'rising' | 'falling' | 'steady'}
 */
export function computeSimpleTrend(currentVal, baselineVal) {
  if (typeof currentVal !== 'number' || typeof baselineVal !== 'number' || baselineVal <= 0) return 'steady';
  const pct = ((currentVal - baselineVal) / baselineVal) * 100;
  return pct >= 12 ? 'rising' : pct <= -12 ? 'falling' : 'steady';
}

function computeRollingMetrics(hourly, nowIdx) {
  const t24 = Math.max(0, nowIdx - 23);
  const t8 = Math.max(0, nowIdx - 7);
  const pm25 = computeRollingAverage(hourly.pm2_5?.slice(t24, nowIdx + 1), 24);
  const pm10 = computeRollingAverage(hourly.pm10?.slice(t24, nowIdx + 1), 24);
  const no2 = computeRollingAverage(hourly.nitrogen_dioxide?.slice(t24, nowIdx + 1), 24);
  const so2 = computeRollingAverage(hourly.sulphur_dioxide?.slice(t24, nowIdx + 1), 24);
  const o3 = computeRollingAverage(hourly.ozone?.slice(t8, nowIdx + 1), 8);
  const coRaw = computeRollingAverage(hourly.carbon_monoxide?.slice(t8, nowIdx + 1), 8);
  const coMg = coRaw.average !== null ? coUgToMg(coRaw.average) : null;
  const prevStart = Math.max(0, t24 - 24);
  const yesterdayPm25 = t24 - prevStart >= 16 ? computeRollingAverage(hourly.pm2_5?.slice(prevStart, t24), 24).average : null;
  return { pm25, pm10, no2, so2, o3, coRaw, coMg, yesterdayPm25 };
}

function buildCurrentSnapshot(aq, wx, times, nowIdx) {
  return {
    timestamp: aq.current?.time || times[nowIdx] || null,
    pm25: sanitizeConcentration(aq.current?.pm2_5, 1),
    pm10: sanitizeConcentration(aq.current?.pm10, 1),
    no2: sanitizeConcentration(aq.current?.nitrogen_dioxide, 1),
    so2: sanitizeConcentration(aq.current?.sulphur_dioxide, 1),
    o3: sanitizeConcentration(aq.current?.ozone, 1),
    coMg: aq.current?.carbon_monoxide != null ? coUgToMg(aq.current.carbon_monoxide) : null,
    usAqi: sanitizeConcentration(aq.current?.us_aqi, 0),
    tempC: typeof wx?.current?.temperature_2m === 'number' ? Number(wx.current.temperature_2m.toFixed(1)) : null,
    rhPct: typeof wx?.current?.relative_humidity_2m === 'number' ? Math.round(wx.current.relative_humidity_2m) : null,
    windKmh: typeof wx?.current?.wind_speed_10m === 'number' ? Number(wx.current.wind_speed_10m.toFixed(1)) : null,
    windDir: wx?.current?.wind_direction_10m ?? null
  };
}

function buildForecastPoints(aq, wx, nowIdx) {
  const times = aq.hourly.time;
  const wxIndexByTime = new Map();
  if (wx?.hourly?.time) wx.hourly.time.forEach((t, idx) => wxIndexByTime.set(t, idx));
  const points = [];
  for (let i = nowIdx; i < Math.min(times.length, nowIdx + 24); i++) {
    const wIdx = wxIndexByTime.get(times[i]);
    points.push({
      time: times[i],
      pm25: sanitizeConcentration(aq.hourly.pm2_5?.[i], 1),
      pm10: sanitizeConcentration(aq.hourly.pm10?.[i], 1),
      no2: sanitizeConcentration(aq.hourly.nitrogen_dioxide?.[i], 1),
      blh: wIdx !== undefined ? wx.hourly.boundary_layer_height?.[wIdx] ?? null : null,
      windKmh: wIdx !== undefined ? wx.hourly.wind_speed_10m?.[wIdx] ?? null : null,
      windDir: wIdx !== undefined ? wx.hourly.wind_direction_10m?.[wIdx] ?? null : null,
      tempC: wIdx !== undefined ? wx.hourly.temperature_2m?.[wIdx] ?? null : null,
      rhPct: wIdx !== undefined ? wx.hourly.relative_humidity_2m?.[wIdx] ?? null : null,
      precipMm: wIdx !== undefined ? wx.hourly.precipitation?.[wIdx] ?? null : null,
      solarWm2: wIdx !== undefined ? wx.hourly.shortwave_radiation?.[wIdx] ?? null : null
    });
  }
  return points;
}

function buildHistorySlice(aq, nowIdx, pastDays) {
  const expectedHours = pastDays * 24;
  const start = Math.max(0, nowIdx - (expectedHours - 1));
  const points = [];
  for (let i = start; i <= nowIdx; i++) {
    points.push({ time: aq.hourly.time[i], pm25: sanitizeConcentration(aq.hourly.pm2_5?.[i], 1), pm10: sanitizeConcentration(aq.hourly.pm10?.[i], 1) });
  }
  return { pastDays, expectedHours, points };
}

function buildNormalizedReadings(rolling, locMeta, measurementIso, retrievalIso, gridResolution) {
  const base = { source: 'Open-Meteo / CAMS', sourceType: 'modeled', location: locMeta, measurementTime: measurementIso, retrievalTime: retrievalIso, spatialResolution: gridResolution };
  const specs = [
    ['PM2.5', rolling.pm25.average, 'µg/m³', '24-hr rolling', rolling.pm25.completenessPct],
    ['PM10', rolling.pm10.average, 'µg/m³', '24-hr rolling', rolling.pm10.completenessPct],
    ['NO2', rolling.no2.average, 'µg/m³', '24-hr rolling', rolling.no2.completenessPct],
    ['SO2', rolling.so2.average, 'µg/m³', '24-hr rolling', rolling.so2.completenessPct],
    ['O3', rolling.o3.average, 'µg/m³', '8-hr rolling', rolling.o3.completenessPct],
    ['CO', rolling.coMg, 'mg/m³', '8-hr rolling', rolling.coRaw.completenessPct]
  ];
  return specs.map(([pollutant, value, unit, averagingPeriod, completenessPct]) =>
    createEnvironmentalReading({ ...base, pollutant, value, unit, averagingPeriod, completenessPct })
  );
}

function buildRecordMetadata(wx, gridResolution, retrievalIso, freshnessState) {
  return {
    provider: 'Open-Meteo / Copernicus CAMS (CC-BY 4.0)',
    weatherProvider: wx ? 'Open-Meteo Weather Forecast (ECMWF/GFS)' : 'Unavailable',
    sourceType: 'Modeled Atmospheric Grid (Not Ground Station)',
    gridResolution,
    temporalResolution: 'Hourly model valid steps (12-hr CAMS cycle)',
    averagingNote: 'CPCB-derived index uses 24-hr rolling means (PM2.5/PM10/NO₂/SO₂) and 8-hr rolling means (O₃/CO; 1-hr O₃ above 208 µg/m³).',
    fetchedAt: retrievalIso,
    freshness: freshnessState.label,
    freshnessState,
    isStaleFallback: false,
    fromCache: false
  };
}

/**
 * Assembles raw Open-Meteo Air Quality & Weather payloads into a unified VayuShield record.
 * @param {{ aq: any, wx: any, location: any, lat: number, lon: number, pastDays: number, nowMs: number }} params
 * @returns {Record<string, any>}
 */
export function assembleAirIntelligenceRecord({ aq, wx, location, lat, lon, pastDays, nowMs }) {
  const times = aq.hourly.time;
  const nowIdx = findCurrentHourIndex(times, aq.current?.time);
  const utcOffsetSeconds = typeof aq.utc_offset_seconds === 'number'
    ? aq.utc_offset_seconds : typeof wx?.utc_offset_seconds === 'number' ? wx.utc_offset_seconds : null;
  const rolling = computeRollingMetrics(aq.hourly, nowIdx);
  const current = buildCurrentSnapshot(aq, wx, times, nowIdx);
  const gridResolution = lat >= 30 && lat <= 72 && lon >= -25 && lon <= 45 ? '~11 km (CAMS Europe domain)' : '~40 km (CAMS Global 0.4° domain)';
  const todayPrefix = (current.timestamp || '').slice(0, 10);
  const retrievalIso = new Date(nowMs).toISOString();
  const freshnessState = evaluateDataFreshness(current.timestamp, nowMs, { sourceType: 'modeled', utcOffsetSeconds });
  const locMeta = { name: sanitizeText(location.name, 60) || 'Selected Location', region: sanitizeText(location.region, 80) || `${lat}°, ${lon}°`, lat, lon, timezone: aq.timezone || 'UTC', utcOffsetSeconds };

  return {
    location: locMeta,
    readings: buildNormalizedReadings(rolling, locMeta, current.timestamp, retrievalIso, gridResolution),
    current,
    rollingAverages: {
      pm25_24h: rolling.pm25.average, pm10_24h: rolling.pm10.average, no2_24h: rolling.no2.average,
      so2_24h: rolling.so2.average, o3_8h: rolling.o3.average, coMg_8h: rolling.coMg, yesterdayPm25_24h: rolling.yesterdayPm25
    },
    pollutantTrends: {
      pm25: computeSimpleTrend(current.pm25, rolling.pm25.average), pm10: computeSimpleTrend(current.pm10, rolling.pm10.average),
      no2: computeSimpleTrend(current.no2, rolling.no2.average), so2: computeSimpleTrend(current.so2, rolling.so2.average),
      o3: computeSimpleTrend(current.o3, rolling.o3.average), co: computeSimpleTrend(current.coMg, rolling.coMg)
    },
    cpcb: calculateCpcbAqi({ pm25: rolling.pm25.average, pm10: rolling.pm10.average, no2: rolling.no2.average, so2: rolling.so2.average, o3: rolling.o3.average, o3_1h: current.o3, co: rolling.coMg }, { sourceType: 'modeled', averagingValidated: rolling.pm25.average !== null }),
    dispersion: analyzeDispersionForecast(buildForecastPoints(aq, wx, nowIdx), {
      sunriseIso: wx?.daily?.sunrise?.find((s) => s.startsWith(todayPrefix)) || wx?.daily?.sunrise?.[0] || null,
      sunsetIso: wx?.daily?.sunset?.find((s) => s.startsWith(todayPrefix)) || wx?.daily?.sunset?.[0] || null,
      referencePm25: current.pm25 ?? rolling.pm25.average, gridResolution
    }),
    history: buildHistorySlice(aq, nowIdx, pastDays),
    metadata: buildRecordMetadata(wx, gridResolution, retrievalIso, freshnessState)
  };
}