import test from 'node:test';
import assert from 'node:assert/strict';

import {
  calculateCpcbAqi,
  calculateOzoneSubIndex,
  calculatePollutantSubIndex,
  computeRollingAverage
} from '../js/core/cpcbAqi.js';
import {
  FRESHNESS_STATES,
  evaluateDataFreshness,
  parseLocationTimestampUtc
} from '../js/core/dataIntegrity.js';
import { evaluateIndoorFiltration } from '../js/core/indoorPhysics.js';
import { evaluateSelectedScenarios } from '../js/core/impactModel.js';
import { buildImmediateAction, buildIntelligentRoutine } from '../js/core/routineEngine.js';
import { buildScientificPrompt, parseNullableMetric } from '../api/gemini.js';

test('SCI-03 & SCI-04: matches official CPCB CUPS/82/2014-15 worked examples, 16-hr completeness & O3 1-hr/8-hr split', () => {
  assert.equal(calculatePollutantSubIndex('pm25', 45).subIndex, 75);
  assert.equal(calculatePollutantSubIndex('pm25', 150).subIndex, 323);
  assert.equal(calculatePollutantSubIndex('pm25', 75).subIndex, 150);

  assert.equal(computeRollingAverage(Array(16).fill(80), 24).average, 80);
  assert.equal(computeRollingAverage(Array(15).fill(80), 24).average, null);

  const o3EightOnly = calculateOzoneSubIndex({ o3_8h: 168, o3_1h: 180 });
  assert.equal(o3EightOnly.subIndex, 200);
  assert.equal(o3EightOnly.averaging, '8-hr');

  const o3Spike1h = calculateOzoneSubIndex({ o3_8h: 160, o3_1h: 478 });
  assert.equal(o3Spike1h.averaging, '1-hr');
  assert.equal(o3Spike1h.subIndex, 350);

  const overall = calculateCpcbAqi({ pm25: 45, pm10: 90, o3: 160, o3_1h: 478 }, { sourceType: 'station' });
  assert.equal(overall.aqi, 350);
  assert.equal(overall.primaryPollutant.pollutant, 'o3');
});

test('SCI-02: ANSI/AHAM AC-1 certified CADR does NOT double-count filter efficiency; raw airflow mode applies eta', () => {
  const certified = evaluateIndoorFiltration({
    floorAreaSqFt: 220,
    ceilingHeightFt: 9,
    outdoorPm25: 150,
    leakageId: 'average',
    indoorSourceId: 'minimal',
    filterGradeId: 'merv13',
    inputMode: 'cadr',
    deviceCadrM3h: 300
  });
  const diyAirflow = evaluateIndoorFiltration({
    floorAreaSqFt: 220,
    ceilingHeightFt: 9,
    outdoorPm25: 150,
    leakageId: 'average',
    indoorSourceId: 'minimal',
    filterGradeId: 'merv13',
    inputMode: 'airflow',
    deviceCadrM3h: 300
  });

  assert.equal(certified.sizing.effectiveCadrM3h, 300);
  assert.equal(diyAirflow.sizing.effectiveCadrM3h, 255);
  assert.ok(certified.outcomes.filteredIndoorPm25 < diyAirflow.outcomes.filteredIndoorPm25);

  assert.equal(certified.cadrCurve.length, 9);
  for (let i = 1; i < certified.cadrCurve.length; i++) {
    assert.ok(certified.cadrCurve[i].indoorPm25 < certified.cadrCurve[i - 1].indoorPm25);
  }
});

test('SCI-01 & AI Null-Safety: missing environmental data NEVER becomes zero in Routine or Gemini proxy', () => {
  const missingIntel = {
    cpcb: { aqi: null, band: null, primaryPollutant: null },
    rollingAverages: { pm25_24h: null },
    current: { tempC: null, windKmh: null },
    dispersion: { available: false }
  };
  const indoor = evaluateIndoorFiltration({ floorAreaSqFt: 220, outdoorPm25: 120 });
  const immediate = buildImmediateAction(missingIntel, {});
  const routine = buildIntelligentRoutine(missingIntel, {}, indoor);

  assert.equal(immediate.level, 'neutral');
  assert.match(routine[0].action, /unavailable/i);
  assert.equal(/favorable for outdoor/i.test(routine[0].action), false);
  assert.equal(/optional today/i.test(routine[4].action), false);

  assert.equal(parseNullableMetric(null, 0, 500), null);
  assert.equal(parseNullableMetric(-10, 0, 500), null);
  assert.equal(parseNullableMetric(0, 0, 500), 0);

  const prompt = buildScientificPrompt({
    city: 'London',
    lat: 51.507,
    lon: -0.128,
    measurementTime: '2026-11-23T12:00',
    sourceType: 'Modeled',
    aqi: null,
    aqiBand: 'Unavailable',
    primaryPollutant: 'Unavailable',
    pm25: null,
    yesterdayPm25: 14.2
  });
  assert.match(prompt, /Unavailable \(missing — do not assume zero\)/);
  assert.match(prompt, /14\.2 ug\/m3/);
});

test('Global Timezone Freshness: London (UTC+0), New York (UTC-5), India (UTC+5:30) & Tokyo (UTC+9) parse accurately', () => {
  const nowUtc = Date.parse('2026-11-23T12:30:00Z');

  assert.equal(parseLocationTimestampUtc('2026-11-23T12:00', 0), Date.parse('2026-11-23T12:00:00Z'));
  assert.equal(evaluateDataFreshness('2026-11-23T12:00', nowUtc, { utcOffsetSeconds: 0 }).state, FRESHNESS_STATES.FRESH);
  assert.equal(evaluateDataFreshness('2026-11-23T07:00', nowUtc, { utcOffsetSeconds: -18000 }).state, FRESHNESS_STATES.FRESH);
  assert.equal(evaluateDataFreshness('2026-11-23T17:30', nowUtc, { utcOffsetSeconds: 19800 }).state, FRESHNESS_STATES.FRESH);
  assert.equal(evaluateDataFreshness('2026-11-23T21:00', nowUtc, { utcOffsetSeconds: 32400 }).state, FRESHNESS_STATES.FRESH);
});

test('SCI-05: Impact Model baseline exposure reflects actual indoor cooking/leakage mass balance', () => {
  const electricTight = evaluateSelectedScenarios([], { cookingFuel: 'induction', leakageId: 'tight' }, 100);
  const biomassLeaky = evaluateSelectedScenarios([], { cookingFuel: 'biomass-mixed', leakageId: 'leaky' }, 100);
  assert.ok(biomassLeaky.baselinePersonalPm25 > electricTight.baselinePersonalPm25);
});