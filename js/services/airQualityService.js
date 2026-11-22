/**
 * @fileoverview Live urban air quality & city geocoding service using free Open-Meteo APIs,
 * paired with TTL caching, AbortController timeouts, and resilient preset fallbacks.
 */

import { CITY_PRESETS, pm25ToCpcbAqi } from '../core/aqiEngine.js';
import { clampNumber, sanitizeText } from '../core/security.js';

const CACHE_TTL_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 6_000;

/** @type {Map<string, { expiresAt: number, data: any }>} */
const airCache = new Map();

/**
 * Clears in-memory air quality cache.
 */
export function clearAirQualityCache() {
  airCache.clear();
}

/**
 * Performs a timeout-bounded JSON fetch.
 * @param {string} url
 * @param {typeof fetch} fetchImpl
 */
async function fetchJsonWithTimeout(url, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Searches for a global city by name using Open-Meteo Geocoding API.
 * @param {string} query
 * @param {{ fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<{ name: string, region: string, lat: number, lon: number } | null>}
 */
export async function geocodeCity(query, options = {}) {
  const cleanQuery = sanitizeText(query, 80);
  if (cleanQuery.length < 2) {
    return null;
  }

  const presetMatch = CITY_PRESETS.find((c) => c.name.toLowerCase() === cleanQuery.toLowerCase());
  if (presetMatch) {
    return {
      name: presetMatch.name,
      region: presetMatch.region,
      lat: presetMatch.lat,
      lon: presetMatch.lon
    };
  }

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cleanQuery)}&count=1&language=en&format=json`;

  try {
    const json = await fetchJsonWithTimeout(url, fetchImpl);
    const match = json?.results?.[0];
    if (!match) {
      return null;
    }
    return {
      name: sanitizeText(match.name, 60) || cleanQuery,
      region: sanitizeText(match.country || match.admin1 || 'Urban Area', 60),
      lat: clampNumber(match.latitude, -90, 90, 28.6139),
      lon: clampNumber(match.longitude, -180, 180, 77.209)
    };
  } catch {
    return null;
  }
}

/**
 * Fetches live PM2.5, PM10, NO2, and CPCB-calibrated AQI for coordinates with caching and fallback.
 * @param {{ name: string, region?: string, lat: number, lon: number, fallbackPreset?: any }} location
 * @param {{ fetchImpl?: typeof fetch, now?: () => number }} [options]
 */
export async function fetchLiveAirQuality(location, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const now = options.now || (() => Date.now());
  const lat = Number(clampNumber(location.lat, -90, 90, 28.6139).toFixed(4));
  const lon = Number(clampNumber(location.lon, -180, 180, 77.209).toFixed(4));
  const cacheKey = `${lat},${lon}`;

  const cached = airCache.get(cacheKey);
  if (cached && cached.expiresAt > now()) {
    return { ...cached.data, fromCache: true };
  }

  const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=pm2_5,pm10,nitrogen_dioxide,us_aqi&timezone=auto`;

  try {
    const json = await fetchJsonWithTimeout(url, fetchImpl);
    const current = json?.current;
    if (!current || typeof current.pm2_5 !== 'number') {
      throw new Error('Incomplete telemetry');
    }

    const pm25 = Math.round(clampNumber(current.pm2_5, 1, 600, 50));
    const pm10 = Math.round(clampNumber(current.pm10 ?? pm25 * 1.6, 1, 800, 80));
    const no2 = Math.round(clampNumber(current.nitrogen_dioxide ?? 28, 0, 400, 28));
    const cpcbAqi = pm25ToCpcbAqi(pm25);
    const usAqi = Math.round(clampNumber(current.us_aqi ?? cpcbAqi, 0, 500, cpcbAqi));
    // Use the higher protective reading so winter PM2.5 smog is never understated
    const aqi = Math.max(cpcbAqi, usAqi);

    const record = {
      name: sanitizeText(location.name, 60) || 'Selected Location',
      region: sanitizeText(location.region, 60) || 'Live Telemetry',
      lat,
      lon,
      aqi,
      pm25,
      pm10,
      no2,
      windKmh: location.fallbackPreset?.windKmh ?? 8.5,
      dominantSource: location.fallbackPreset?.dominantSource || 'Urban vehicular exhaust, suspended dust & seasonal boundary-layer trapping',
      sourceLabel: 'Live Open-Meteo Telemetry',
      updatedAt: new Date(now()).toISOString(),
      fromCache: false
    };

    airCache.set(cacheKey, { expiresAt: now() + CACHE_TTL_MS, data: record });
    return record;
  } catch {
    const fallback = location.fallbackPreset || CITY_PRESETS[0];
    return {
      name: sanitizeText(location.name, 60) || fallback.name,
      region: sanitizeText(location.region, 60) || fallback.region,
      lat,
      lon,
      aqi: fallback.aqi,
      pm25: fallback.pm25,
      pm10: fallback.pm10,
      no2: fallback.no2,
      windKmh: fallback.windKmh,
      dominantSource: fallback.dominantSource,
      sourceLabel: 'Winter Smog Baseline Model (Offline Fallback)',
      updatedAt: new Date(now()).toISOString(),
      fromCache: false
    };
  }
}