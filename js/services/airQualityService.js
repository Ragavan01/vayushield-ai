/**
 * @fileoverview Resilient Dual-API Atmospheric Data Service (Project Chimera v2.5).
 * - Fetches Open-Meteo Air Quality (CAMS modeled pollutants) + Weather Forecast
 *   (BLH, wind, temperature, humidity, precipitation, solar radiation, daily sunrise/sunset).
 * - Slices exact 24h / 7d / 30d history horizons (fixes 32-point overrun).
 * - Evaluates true measurement freshness via dataIntegrity.js.
 * - Preserves last valid cache for the SAME location with an explicit Stale warning if an upstream retry fails,
 *   while NEVER substituting a different city's data.
 */

import { calculateCpcbAqi, coUgToMg, computeRollingAverage } from '../core/cpcbAqi.js';
import {
  createEnvironmentalReading,
  evaluateDataFreshness,
  sanitizeConcentration
} from '../core/dataIntegrity.js';
import { analyzeDispersionForecast } from '../core/dispersionEngine.js';
import { clampNumber, sanitizeText } from '../core/security.js';

const CACHE_TTL_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8_500;
const MAX_RETRIES = 1;

/** @type {Map<string, { expiresAt: number, data: any }>} */
const responseCache = new Map();
/** @type {Map<string, Promise<any>>} */
const inflightRequests = new Map();

export const CURATED_CITIES = Object.freeze([
  Object.freeze({ id: 'delhi-ncr', name: 'Delhi NCR', region: 'India', lat: 28.6139, lon: 77.209 }),
  Object.freeze({ id: 'lucknow', name: 'Lucknow', region: 'India', lat: 26.8467, lon: 80.9462 }),
  Object.freeze({ id: 'mumbai', name: 'Mumbai', region: 'India', lat: 19.076, lon: 72.8777 }),
  Object.freeze({ id: 'kolkata', name: 'Kolkata', region: 'India', lat: 22.5726, lon: 88.3639 }),
  Object.freeze({ id: 'bengaluru', name: 'Bengaluru', region: 'India', lat: 12.9716, lon: 77.5946 }),
  Object.freeze({ id: 'coimbatore', name: 'Coimbatore', region: 'India', lat: 11.0168, lon: 76.9558 })
]);

export function clearAirQualityCache() {
  responseCache.clear();
  inflightRequests.clear();
}

async function fetchJsonWithRetry(url, fetchImpl, retries = MAX_RETRIES) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetchImpl(url, { signal: controller.signal });
      if (!res.ok) {
        const err = new Error(`Upstream HTTP ${res.status}`);
        if (res.status >= 500 && attempt < retries) {
          lastError = err;
          await new Promise((r) => setTimeout(r, 350 * (attempt + 1)));
          continue;
        }
        throw err;
      }
      return await res.json();
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 350 * (attempt + 1)));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error('Upstream request failed');
}

export async function geocodeCity(query, options = {}) {
  const clean = sanitizeText(query, 80);
  if (clean.length < 2) return null;

  const preset = CURATED_CITIES.find((c) => c.name.toLowerCase() === clean.toLowerCase());
  if (preset) return { ...preset };

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(clean)}&count=1&language=en&format=json`;
  const json = await fetchJsonWithRetry(url, fetchImpl);
  const hit = json?.results?.[0];
  if (!hit) return null;

  return {
    name: sanitizeText(hit.name, 60) || clean,
    region: sanitizeText([hit.admin1, hit.country].filter(Boolean).join(', '), 80) || 'Unknown Region',
    lat: Number(clampNumber(hit.latitude, -90, 90, 0).toFixed(4)),
    lon: Number(clampNumber(hit.longitude, -180, 180, 0).toFixed(4))
  };
}

function findCurrentHourIndex(times, currentIso) {
  if (!Array.isArray(times) || times.length === 0) return 0;
  if (currentIso) {
    const prefix = currentIso.slice(0, 13);
    const exactIdx = times.findIndex((t) => typeof t === 'string' && t.startsWith(prefix));
    if (exactIdx >= 0) return exactIdx;
  }
  return Math.max(0, Math.min(24, times.length - 1));
}

export async function fetchAirIntelligence(location, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const now = options.now || (() => Date.now());
  const pastDays = [1, 7, 30].includes(options.pastDays) ? options.pastDays : 1;
  const forceRefresh = options.forceRefresh === true;

  const lat = Number(clampNumber(location.lat, -90, 90, 28.6139).toFixed(4));
  const lon = Number(clampNumber(location.lon, -180, 180, 77.209).toFixed(4));
  const cacheKey = `${lat},${lon}:${pastDays}`;

  const cached = responseCache.get(cacheKey);
  if (!forceRefresh && cached && cached.expiresAt > now()) {
    const freshness = evaluateDataFreshness(cached.data.current.timestamp, now(), { sourceType: 'modeled' });
    return {
      ...cached.data,
      metadata: { ...cached.data.metadata, freshness: freshness.label, freshnessState: freshness, fromCache: true }
    };
  }

  if (inflightRequests.has(cacheKey)) {
    return inflightRequests.get(cacheKey);
  }

  const work = (async () => {
    const aqUrl = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&hourly=pm2_5,pm10,nitrogen_dioxide,sulphur_dioxide,carbon_monoxide,ozone,us_aqi&current=pm2_5,pm10,nitrogen_dioxide,sulphur_dioxide,carbon_monoxide,ozone,us_aqi&past_days=${pastDays}&forecast_days=2&timezone=auto`;
    const wxUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,boundary_layer_height,precipitation,shortwave_radiation&daily=sunrise,sunset&current=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m&past_days=1&forecast_days=2&timezone=auto`;

    const [aqResult, wxResult] = await Promise.allSettled([
      fetchJsonWithRetry(aqUrl, fetchImpl),
      fetchJsonWithRetry(wxUrl, fetchImpl)
    ]);

    if (aqResult.status !== 'fulfilled' || !aqResult.value?.hourly?.time?.length) {
      // Stale-while-error ONLY for the exact same coordinates/key — never another city
      if (cached) {
        const staleFreshness = evaluateDataFreshness(cached.data.current.timestamp, now(), {
          sourceType: 'modeled',
          isStaleFallback: true
        });
        return {
          ...cached.data,
          metadata: {
            ...cached.data.metadata,
            freshness: staleFreshness.label,
            freshnessState: staleFreshness,
            isStaleFallback: true,
            staleWarning: 'Live refresh failed; displaying the last valid cached reading for this exact location.'
          }
        };
      }
      throw new Error('Open-Meteo Air Quality telemetry is currently unavailable for this location.');
    }

    const aq = aqResult.value;
    const wx = wxResult.status === 'fulfilled' ? wxResult.value : null;

    const times = aq.hourly.time;
    const nowIdx = findCurrentHourIndex(times, aq.current?.time);

    // Trailing 24h / 8h rolling averages for CPCB compliance
    const trailing24Start = Math.max(0, nowIdx - 23);
    const trailing8Start = Math.max(0, nowIdx - 7);

    const pm25_24h = computeRollingAverage(aq.hourly.pm2_5?.slice(trailing24Start, nowIdx + 1), 24);
    const pm10_24h = computeRollingAverage(aq.hourly.pm10?.slice(trailing24Start, nowIdx + 1), 24);
    const no2_24h = computeRollingAverage(aq.hourly.nitrogen_dioxide?.slice(trailing24Start, nowIdx + 1), 24);
    const so2_24h = computeRollingAverage(aq.hourly.sulphur_dioxide?.slice(trailing24Start, nowIdx + 1), 24);
    const o3_8h = computeRollingAverage(aq.hourly.ozone?.slice(trailing8Start, nowIdx + 1), 8);
    const coRaw_8h = computeRollingAverage(aq.hourly.carbon_monoxide?.slice(trailing8Start, nowIdx + 1), 8);
    const coMg_8h = coRaw_8h.average !== null ? coUgToMg(coRaw_8h.average) : null;

    const cpcbEvaluation = calculateCpcbAqi(
      {
        pm25: pm25_24h.average,
        pm10: pm10_24h.average,
        no2: no2_24h.average,
        so2: so2_24h.average,
        o3: o3_8h.average,
        co: coMg_8h
      },
      { sourceType: 'modeled', averagingValidated: pm25_24h.average !== null }
    );

    const wxIndexByTime = new Map();
    if (wx?.hourly?.time) {
      wx.hourly.time.forEach((t, i) => wxIndexByTime.set(t, i));
    }

    const isEuropeDomain = lat >= 30 && lat <= 72 && lon >= -25 && lon <= 45;
    const gridResolution = isEuropeDomain ? '~11 km (CAMS Europe domain)' : '~40 km (CAMS Global 0.4° domain)';

    // Next 24-hour forecast points
    const forecastPoints = [];
    for (let i = nowIdx; i < Math.min(times.length, nowIdx + 24); i++) {
      const t = times[i];
      const wIdx = wxIndexByTime.get(t);
      forecastPoints.push({
        time: t,
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

    // Match today's sunrise/sunset from daily weather array
    const todayDatePrefix = (aq.current?.time || times[nowIdx] || '').slice(0, 10);
    const sunriseIso = wx?.daily?.sunrise?.find((s) => s.startsWith(todayDatePrefix)) || wx?.daily?.sunrise?.[0] || null;
    const sunsetIso = wx?.daily?.sunset?.find((s) => s.startsWith(todayDatePrefix)) || wx?.daily?.sunset?.[0] || null;

    const currentPm25 = sanitizeConcentration(aq.current?.pm2_5, 1);
    const dispersion = analyzeDispersionForecast(forecastPoints, {
      sunriseIso,
      sunsetIso,
      referencePm25: currentPm25 ?? pm25_24h.average,
      gridResolution
    });

    // Exact historical slice: pastDays * 24 hours ending at nowIdx (fixes 32-point 24h overrun)
    // Preserves null slots explicitly so charts render visible missing-data gaps
    const targetHistoryHours = pastDays * 24;
    const histStart = Math.max(0, nowIdx - (targetHistoryHours - 1));
    const historyPoints = [];
    for (let i = histStart; i <= nowIdx; i++) {
      historyPoints.push({
        time: times[i],
        pm25: sanitizeConcentration(aq.hourly.pm2_5?.[i], 1),
        pm10: sanitizeConcentration(aq.hourly.pm10?.[i], 1)
      });
    }

    const retrievalIso = new Date(now()).toISOString();
    const measurementIso = aq.current?.time || times[nowIdx] || null;
    const freshnessState = evaluateDataFreshness(measurementIso, now(), { sourceType: 'modeled' });

    const locMeta = {
      name: sanitizeText(location.name, 60) || 'Selected Location',
      region: sanitizeText(location.region, 80) || `${lat}°, ${lon}°`,
      lat,
      lon,
      timezone: aq.timezone || 'UTC'
    };

    const readings = [
      createEnvironmentalReading({ pollutant: 'PM2.5', value: pm25_24h.average, unit: 'µg/m³', source: 'Open-Meteo / CAMS', sourceType: 'modeled', location: locMeta, measurementTime: measurementIso, retrievalTime: retrievalIso, averagingPeriod: '24-hr rolling', spatialResolution: gridResolution, completenessPct: pm25_24h.completenessPct }),
      createEnvironmentalReading({ pollutant: 'PM10', value: pm10_24h.average, unit: 'µg/m³', source: 'Open-Meteo / CAMS', sourceType: 'modeled', location: locMeta, measurementTime: measurementIso, retrievalTime: retrievalIso, averagingPeriod: '24-hr rolling', spatialResolution: gridResolution, completenessPct: pm10_24h.completenessPct }),
      createEnvironmentalReading({ pollutant: 'NO2', value: no2_24h.average, unit: 'µg/m³', source: 'Open-Meteo / CAMS', sourceType: 'modeled', location: locMeta, measurementTime: measurementIso, retrievalTime: retrievalIso, averagingPeriod: '24-hr rolling', spatialResolution: gridResolution, completenessPct: no2_24h.completenessPct }),
      createEnvironmentalReading({ pollutant: 'SO2', value: so2_24h.average, unit: 'µg/m³', source: 'Open-Meteo / CAMS', sourceType: 'modeled', location: locMeta, measurementTime: measurementIso, retrievalTime: retrievalIso, averagingPeriod: '24-hr rolling', spatialResolution: gridResolution, completenessPct: so2_24h.completenessPct }),
      createEnvironmentalReading({ pollutant: 'O3', value: o3_8h.average, unit: 'µg/m³', source: 'Open-Meteo / CAMS', sourceType: 'modeled', location: locMeta, measurementTime: measurementIso, retrievalTime: retrievalIso, averagingPeriod: '8-hr rolling', spatialResolution: gridResolution, completenessPct: o3_8h.completenessPct }),
      createEnvironmentalReading({ pollutant: 'CO', value: coMg_8h, unit: 'mg/m³', source: 'Open-Meteo / CAMS', sourceType: 'modeled', location: locMeta, measurementTime: measurementIso, retrievalTime: retrievalIso, averagingPeriod: '8-hr rolling', spatialResolution: gridResolution, completenessPct: coRaw_8h.completenessPct })
    ];

    const record = {
      location: locMeta,
      readings,
      current: {
        timestamp: measurementIso,
        pm25: currentPm25,
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
      },
      rollingAverages: {
        pm25_24h: pm25_24h.average,
        pm10_24h: pm10_24h.average,
        no2_24h: no2_24h.average,
        so2_24h: so2_24h.average,
        o3_8h: o3_8h.average,
        coMg_8h
      },
      cpcb: cpcbEvaluation,
      dispersion,
      history: {
        pastDays,
        expectedHours: targetHistoryHours,
        points: historyPoints
      },
      metadata: {
        provider: 'Open-Meteo / Copernicus CAMS (CC-BY 4.0)',
        weatherProvider: wx ? 'Open-Meteo Weather Forecast (ECMWF/GFS)' : 'Unavailable',
        sourceType: 'Modeled Atmospheric Grid (Not Ground Station)',
        gridResolution,
        temporalResolution: 'Hourly model valid steps (12-hr CAMS cycle)',
        averagingNote: 'CPCB-derived index uses 24-hr rolling means (PM2.5/PM10/NO₂/SO₂) and 8-hr rolling means (O₃/CO).',
        fetchedAt: retrievalIso,
        freshness: freshnessState.label,
        freshnessState,
        isStaleFallback: false,
        fromCache: false
      }
    };

    responseCache.set(cacheKey, { expiresAt: now() + CACHE_TTL_MS, data: record });
    return record;
  })();

  inflightRequests.set(cacheKey, work);
  try {
    return await work;
  } finally {
    inflightRequests.delete(cacheKey);
  }
}