import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FRESHNESS_STATES,
  createEnvironmentalReading,
  evaluateDataFreshness,
  formatProjectedAndDelta,
  sanitizeConcentration
} from '../js/core/dataIntegrity.js';

import { analyzeDispersionForecast } from '../js/core/dispersionEngine.js';
import { buildImmediateAction, buildIntelligentRoutine } from '../js/core/routineEngine.js';
import { evaluateIndoorFiltration } from '../js/core/indoorPhysics.js';
import { clearAirQualityCache, fetchAirIntelligence } from '../js/services/airQualityService.js';

test('FIX 01 & FIX 07: rejects negative pollutant concentrations and separates projected vs delta cleanly', () => {
  assert.equal(sanitizeConcentration(-18.6), null);
  assert.equal(sanitizeConcentration(NaN), null);
  assert.equal(sanitizeConcentration(0), 0);
  assert.equal(sanitizeConcentration(18.64, 1), 18.6);

  const fmt = formatProjectedAndDelta(18.6, 71.7, 'µg/m³');
  assert.equal(fmt.projected, 18.6);
  assert.equal(fmt.delta, -53.1);
  assert.equal(fmt.projectedText, 'Projected: 18.6 µg/m³');
  assert.equal(fmt.projectedText.includes('~'), false);
  assert.match(fmt.deltaText, /-53\.1 µg\/m³/);

  const bad = formatProjectedAndDelta(-5, 50);
  assert.equal(bad.projected, null);
  assert.equal(bad.projectedText, 'Unavailable');
});

test('FIX 02: overnight minimum (01:00–03:00) is NEVER recommended as practical daytime outdoor exercise', () => {
  const hours = Array.from({ length: 24 }, (_, h) => ({
    time: `2026-11-23T${String(h).padStart(2, '0')}:00`,
    pm25: h >= 1 && h <= 3 ? 18.6 : h >= 14 && h <= 16 ? 26.0 : h >= 7 && h <= 9 ? 71.7 : 48.0,
    blh: h >= 14 && h <= 16 ? 1295 : 220,
    windKmh: h >= 14 && h <= 16 ? 11 : 2,
    precipMm: 0,
    solarWm2: h >= 7 && h <= 17 ? 450 : 0,
    tempC: 25.2,
    rhPct: 76
  }));

  const disp = analyzeDispersionForecast(hours, {
    sunriseIso: '2026-11-23T06:24',
    sunsetIso: '2026-11-23T17:52',
    referencePm25: 71.7
  });

  assert.equal(disp.lowestPollutionWindow.label, '01:00–03:00');
  assert.equal(disp.lowestPollutionWindow.isDaytime, false);
  assert.equal(disp.bestDaytimeWindow.label, '14:00–16:00');
  assert.equal(disp.bestDaytimeWindow.isDaytime, true);
  assert.equal(disp.bestOutdoorWindow.label, '14:00–16:00');

  const intel = {
    cpcb: { aqi: 126, band: { label: 'Moderately Polluted' }, primaryPollutant: { name: 'PM2.5' } },
    rollingAverages: { pm25_24h: 67.5 },
    current: { tempC: 25.2, windKmh: 1.8 },
    dispersion: disp
  };
  const indoor = evaluateIndoorFiltration({ floorAreaSqFt: 220, outdoorPm25: 67.5 });
  const immediate = buildImmediateAction(intel, { householdProfile: 'multi-gen' });
  const routine = buildIntelligentRoutine(intel, { householdProfile: 'multi-gen', commuteMode: 'two-wheeler', dailyCommuteKm: 18 }, indoor);

  assert.match(immediate.detail, /14:00–16:00/);
  assert.match(routine[0].window, /14:00–16:00/);
  assert.equal(routine[0].window.includes('01:00–03:00'), false);
  assert.match(routine[2].window, /14:00–16:00/);
});

test('FIX 03: Data Freshness Engine classifies Fresh, Recent, Delayed, Stale & Unavailable from measurement time', () => {
  const now = Date.parse('2026-11-23T08:00:00Z');
  assert.equal(evaluateDataFreshness('2026-11-23T07:30:00Z', now).state, FRESHNESS_STATES.FRESH);
  assert.equal(evaluateDataFreshness('2026-11-23T05:30:00Z', now).state, FRESHNESS_STATES.RECENT);
  assert.equal(evaluateDataFreshness('2026-11-23T03:00:00Z', now).state, FRESHNESS_STATES.DELAYED);
  assert.equal(evaluateDataFreshness('2026-11-22T20:00:00Z', now).state, FRESHNESS_STATES.STALE);
  assert.equal(evaluateDataFreshness(null, now).state, FRESHNESS_STATES.UNAVAILABLE);

  const reading = createEnvironmentalReading({
    pollutant: 'PM2.5',
    value: -10,
    unit: 'µg/m³',
    source: 'Open-Meteo',
    sourceType: 'modeled',
    location: { name: 'Test', lat: 11, lon: 77 },
    measurementTime: '2026-11-23T07:00',
    retrievalTime: '2026-11-23T08:00:00Z',
    averagingPeriod: '24-hr',
    spatialResolution: '~40 km'
  });
  assert.equal(reading.value, null);
  assert.equal(reading.quality_status, 'unavailable');
});

test('FIX 03 & FIX 06: exact 24h history slice (24 points, never 32) and same-location stale-while-error fallback', async () => {
  clearAirQualityCache();
  const times = Array.from({ length: 48 }, (_, i) => {
    const day = i < 24 ? '22' : '23';
    return `2026-11-${day}T${String(i % 24).padStart(2, '0')}:00`;
  });

  let shouldFail = false;
  const mockFetch = async (url) => {
    if (shouldFail) return { ok: false, status: 503 };
    if (url.includes('air-quality-api')) {
      return {
        ok: true,
        json: async () => ({
          timezone: 'Asia/Kolkata',
          current: { time: '2026-11-23T07:00', pm2_5: 71.7, pm10: 74, nitrogen_dioxide: 14, sulphur_dioxide: 21, carbon_monoxide: 340, ozone: 94 },
          hourly: {
            time: times,
            pm2_5: times.map((_, i) => (i === 15 ? null : 55)),
            pm10: times.map(() => 70),
            nitrogen_dioxide: times.map(() => 13),
            sulphur_dioxide: times.map(() => 21),
            carbon_monoxide: times.map(() => 320),
            ozone: times.map(() => 88)
          }
        })
      };
    }
    return {
      ok: true,
      json: async () => ({
        current: { temperature_2m: 25.2, relative_humidity_2m: 76, wind_speed_10m: 1.8, wind_direction_10m: 90 },
        daily: { sunrise: ['2026-11-22T06:24', '2026-11-23T06:24'], sunset: ['2026-11-22T17:52', '2026-11-23T17:52'] },
        hourly: {
          time: times,
          temperature_2m: times.map(() => 25),
          relative_humidity_2m: times.map(() => 70),
          wind_speed_10m: times.map(() => 6),
          wind_direction_10m: times.map(() => 90),
          boundary_layer_height: times.map(() => 600),
          precipitation: times.map(() => 0),
          shortwave_radiation: times.map(() => 300)
        }
      })
    };
  };

  const loc = { name: 'Coimbatore', region: 'India', lat: 11.0168, lon: 76.9558 };
  const live = await fetchAirIntelligence(loc, { pastDays: 1, fetchImpl: mockFetch, now: () => 10_000 });
  assert.equal(live.history.points.length, 24);
  assert.equal(live.history.points.some((p) => p.pm25 === null), true);

  shouldFail = true;
  const stale = await fetchAirIntelligence(loc, { pastDays: 1, forceRefresh: true, fetchImpl: mockFetch, now: () => 20_000 });
  assert.equal(stale.location.name, 'Coimbatore');
  assert.equal(stale.metadata.isStaleFallback, true);
  assert.equal(stale.metadata.freshnessState.state, FRESHNESS_STATES.STALE);
});