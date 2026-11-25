/**
 * @fileoverview Resilient Dual-API Atmospheric Data Service.
 * Manages Open-Meteo Air Quality & Weather fetches, in-flight deduplication,
 * TTL caching, same-location stale-while-error fallback, geocoding, and CSV export.
 */

import { evaluateDataFreshness } from '../core/dataIntegrity.js';
import { clampNumber, sanitizeText } from '../core/security.js';
import { assembleAirIntelligenceRecord } from './airQualityParser.js';

const CACHE_TTL_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8_500;
const MAX_RETRIES = 1;

const responseCache = new Map();
const inflightRequests = new Map();

/** @type {ReadonlyArray<Readonly<{ id: string, name: string, region: string, lat: number, lon: number }>>} */
export const CURATED_CITIES = Object.freeze([
  Object.freeze({ id: 'delhi-ncr', name: 'Delhi NCR', region: 'India', lat: 28.6139, lon: 77.209 }),
  Object.freeze({ id: 'lucknow', name: 'Lucknow', region: 'India', lat: 26.8467, lon: 80.9462 }),
  Object.freeze({ id: 'mumbai', name: 'Mumbai', region: 'India', lat: 19.076, lon: 72.8777 }),
  Object.freeze({ id: 'kolkata', name: 'Kolkata', region: 'India', lat: 22.5726, lon: 88.3639 }),
  Object.freeze({ id: 'bengaluru', name: 'Bengaluru', region: 'India', lat: 12.9716, lon: 77.5946 }),
  Object.freeze({ id: 'coimbatore', name: 'Coimbatore', region: 'India', lat: 11.0168, lon: 76.9558 })
]);

/**
 * Clears cached responses and in-flight request deduplication maps.
 * @returns {void}
 */
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
      if (attempt < retries) await new Promise((r) => setTimeout(r, 350 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error('Upstream request failed');
}

function normalizeGeocodeHit(hit, fallbackName) {
  return {
    name: sanitizeText(hit.name, 60) || fallbackName,
    region: sanitizeText([hit.admin1, hit.country].filter(Boolean).join(', '), 80) || 'Unknown Region',
    lat: Number(clampNumber(hit.latitude, -90, 90, 0).toFixed(4)),
    lon: Number(clampNumber(hit.longitude, -180, 180, 0).toFixed(4))
  };
}

/**
 * Resolves a city name via curated presets or Open-Meteo geocoding.
 * @param {string} query
 * @param {{ fetchImpl?: (...args: any[]) => Promise<any> }} [options={}]
 * @returns {Promise<{ name: string, region: string, lat: number, lon: number } | null>}
 */
export async function geocodeCity(query, options = {}) {
  const clean = sanitizeText(query, 80);
  if (clean.length < 2) return null;

  const preset = CURATED_CITIES.find((c) => c.name.toLowerCase() === clean.toLowerCase());
  if (preset) return { ...preset };

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(clean)}&count=1&language=en&format=json`;
  const json = await fetchJsonWithRetry(url, fetchImpl);
  const hit = json?.results?.[0];
  return hit ? normalizeGeocodeHit(hit, clean) : null;
}

/**
 * Returns up to 5 sanitized global city autocomplete suggestions.
 * @param {string} query
 * @param {{ fetchImpl?: (...args: any[]) => Promise<any> }} [options={}]
 * @returns {Promise<Array<{ name: string, region: string, lat: number, lon: number }>>}
 */
export async function searchCitySuggestions(query, options = {}) {
  const clean = sanitizeText(query, 80);
  if (clean.length < 2) return [];

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(clean)}&count=5&language=en&format=json`;
  const json = await fetchJsonWithRetry(url, fetchImpl, 0);
  const rows = Array.isArray(json?.results) ? json.results : [];
  return rows.map((hit) => normalizeGeocodeHit(hit, clean));
}

/**
 * Exports historical hourly PM2.5/PM10 points to CSV with spreadsheet formula-injection neutralization.
 * @param {Record<string, any> | null} intel
 * @returns {string}
 */
export function buildHistoricalCsv(intel) {
  const safeCell = (val) => {
    const str = val === null || val === undefined ? '' : String(val);
    const neutral = /^[=+\-@\t\r]/.test(str) ? `'${str}` : str;
    return `"${neutral.replace(/"/g, '""')}"`;
  };

  const loc = intel?.location?.name || 'Location';
  const source = intel?.metadata?.provider || 'Open-Meteo / CAMS';
  const points = Array.isArray(intel?.history?.points) ? intel.history.points : [];
  const header = ['timestamp_local', 'location', 'pm25_ug_m3', 'pm10_ug_m3', 'source_type', 'provider'].join(',');
  const lines = points.map((pt) => [
    safeCell(pt.time), safeCell(loc),
    pt.pm25 === null || pt.pm25 === undefined ? '' : pt.pm25,
    pt.pm10 === null || pt.pm10 === undefined ? '' : pt.pm10,
    safeCell('modeled_atmospheric_grid'), safeCell(source)
  ].join(','));

  return [header, ...lines].join('\n');
}

function buildCachedFallback(cached, nowMs, isStale) {
  const freshness = evaluateDataFreshness(cached.data.current.timestamp, nowMs, {
    sourceType: 'modeled',
    isStaleFallback: isStale,
    utcOffsetSeconds: cached.data.location.utcOffsetSeconds
  });
  return {
    ...cached.data,
    metadata: {
      ...cached.data.metadata,
      freshness: freshness.label,
      freshnessState: freshness,
      fromCache: !isStale,
      ...(isStale ? {
        isStaleFallback: true,
        staleWarning: 'Live refresh failed; displaying the last valid cached reading for this exact location.'
      } : {})
    }
  };
}

/**
 * Fetches and normalizes dual-API Open-Meteo Air Quality & Weather intelligence for a location.
 * @param {{ name?: string, region?: string, lat: number, lon: number }} location
 * @param {{ fetchImpl?: (...args: any[]) => Promise<any>, now?: () => number, pastDays?: number, forceRefresh?: boolean }} [options={}]
 * @returns {Promise<Record<string, any>>}
 */
export async function fetchAirIntelligence(location, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const now = options.now || (() => Date.now());
  const pastDays = [1, 7, 30].includes(options.pastDays) ? options.pastDays : 1;
  const fetchPastDays = Math.max(2, pastDays);
  const lat = Number(clampNumber(location.lat, -90, 90, 28.6139).toFixed(4));
  const lon = Number(clampNumber(location.lon, -180, 180, 77.209).toFixed(4));
  const cacheKey = `${lat},${lon}:${pastDays}`;

  const cached = responseCache.get(cacheKey);
  if (options.forceRefresh !== true && cached && cached.expiresAt > now()) {
    return buildCachedFallback(cached, now(), false);
  }
  if (inflightRequests.has(cacheKey)) {
    return inflightRequests.get(cacheKey);
  }

  const work = (async () => {
    const aqUrl = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&hourly=pm2_5,pm10,nitrogen_dioxide,sulphur_dioxide,carbon_monoxide,ozone,us_aqi&current=pm2_5,pm10,nitrogen_dioxide,sulphur_dioxide,carbon_monoxide,ozone,us_aqi&past_days=${fetchPastDays}&forecast_days=2&timezone=auto`;
    const wxUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,boundary_layer_height,precipitation,shortwave_radiation&daily=sunrise,sunset&current=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m&past_days=1&forecast_days=2&timezone=auto`;

    const [aqResult, wxResult] = await Promise.allSettled([
      fetchJsonWithRetry(aqUrl, fetchImpl),
      fetchJsonWithRetry(wxUrl, fetchImpl)
    ]);

    if (aqResult.status !== 'fulfilled' || !aqResult.value?.hourly?.time?.length) {
      if (cached) return buildCachedFallback(cached, now(), true);
      throw new Error('Open-Meteo Air Quality telemetry is currently unavailable for this location.');
    }

    const record = assembleAirIntelligenceRecord({
      aq: aqResult.value,
      wx: wxResult.status === 'fulfilled' ? wxResult.value : null,
      location, lat, lon, pastDays, nowMs: now()
    });
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