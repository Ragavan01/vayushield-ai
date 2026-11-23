import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CPCB_BANDS,
  calculateCpcbAqi,
  calculatePollutantSubIndex,
  classifyCpcbBand,
  coUgToMg,
  compareToWhoGuideline,
  computeRollingAverage
} from '../js/core/cpcbAqi.js';

import {
  analyzeDispersionForecast,
  computeVentilationCoefficient,
  degreesToCompass,
  kmhToMs
} from '../js/core/dispersionEngine.js';

import { evaluateIndoorFiltration } from '../js/core/indoorPhysics.js';

import {
  calculateMortalityRiskHeuristic,
  evaluateSelectedScenarios,
  normalizeProfile
} from '../js/core/impactModel.js';

import { buildImmediateAction, buildIntelligentRoutine } from '../js/core/routineEngine.js';

import {
  computeCommunityStats,
  moderateCommunitySubmission
} from '../js/core/communityModeration.js';

test('CPCB NAQI: exact official breakpoints & linear interpolation for PM2.5, PM10, NO2, SO2, O3, CO, NH3, Pb', () => {
  assert.equal(CPCB_BANDS.length, 6);
  assert.equal(classifyCpcbBand(218).id, 'poor');
  assert.equal(calculatePollutantSubIndex('pm25', 0).subIndex, 0);
  assert.equal(calculatePollutantSubIndex('pm25', 30).subIndex, 50);
  assert.equal(calculatePollutantSubIndex('pm25', 60).subIndex, 100);
  assert.equal(calculatePollutantSubIndex('pm25', 75).subIndex, 151); // midpoint 101..200
  assert.equal(calculatePollutantSubIndex('pm25', 120).subIndex, 300);
  assert.equal(calculatePollutantSubIndex('pm25', 250).subIndex, 400);
  assert.equal(calculatePollutantSubIndex('pm25', 450).exceededScale, true);

  assert.equal(calculatePollutantSubIndex('pm10', 250).subIndex, 200);
  assert.equal(calculatePollutantSubIndex('no2', 80).subIndex, 100);
  assert.equal(calculatePollutantSubIndex('so2', 380).subIndex, 200);
  assert.equal(calculatePollutantSubIndex('o3', 168).subIndex, 200);
  assert.equal(calculatePollutantSubIndex('co', 10.0).subIndex, 200);
  assert.equal(calculatePollutantSubIndex('nh3', 400).subIndex, 100);
  assert.equal(calculatePollutantSubIndex('pb', 1.0).subIndex, 100);

  assert.equal(calculatePollutantSubIndex('pm25', -5), null);
  assert.equal(calculatePollutantSubIndex('pm25', null), null);
  assert.equal(coUgToMg(2500), 2.5);
});

test('CPCB NAQI: enforces 75% rolling-average completeness & minimum 3-pollutant + PM rule', () => {
  const complete24 = Array(20).fill(90);
  assert.equal(computeRollingAverage(complete24, 24).average, 90);

  const sparse24 = Array(10).fill(90);
  assert.equal(computeRollingAverage(sparse24, 24).average, null);

  // Modeled data must never claim isOfficialCpcb === true
  const modeled = calculateCpcbAqi(
    { pm25: 95, pm10: 140, no2: 45, so2: 18 },
    { sourceType: 'modeled', averagingValidated: true }
  );
  assert.equal(modeled.aqi, 218);
  assert.equal(modeled.primaryPollutant.pollutant, 'pm25');
  assert.equal(modeled.meetsCompletenessRule, true);
  assert.equal(modeled.isOfficialCpcb, false);

  // Station data with >=3 pollutants including PM2.5 meets official criteria
  const station = calculateCpcbAqi(
    { pm25: 95, pm10: 140, no2: 45 },
    { sourceType: 'station', averagingValidated: true }
  );
  assert.equal(station.isOfficialCpcb, true);

  // Missing PM2.5 and PM10 fails completeness rule
  const gasOnly = calculateCpcbAqi(
    { no2: 60, so2: 40, o3: 90 },
    { sourceType: 'station', averagingValidated: true }
  );
  assert.equal(gasOnly.meetsCompletenessRule, false);
  assert.equal(gasOnly.isOfficialCpcb, false);

  const who = compareToWhoGuideline('pm25', 90);
  assert.equal(who.ratio, 6);
  assert.equal(who.exceeds, true);
});

test('Dispersion Engine: computes Ventilation Coefficient & dynamic cleanest/peak windows from hourly data', () => {
  assert.equal(kmhToMs(18), 5);
  assert.equal(degreesToCompass(90), 'E');

  const stagnant = computeVentilationCoefficient(200, 3.6);
  assert.equal(stagnant.vc, 200);
  assert.equal(stagnant.riskLevel, 'high');

  const favorable = computeVentilationCoefficient(1500, 18);
  assert.equal(favorable.vc, 7500);
  assert.equal(favorable.riskLevel, 'low');

  // Construct hourly series where cleanest window is at 08:00–10:00 (proving zero hardcoded afternoon bias)
  const synthetic = Array.from({ length: 12 }, (_, h) => ({
    time: `2026-11-23T${String(h).padStart(2, '0')}:00`,
    pm25: h >= 8 && h <= 10 ? 35 : h <= 2 ? 210 : 140,
    blh: h >= 8 && h <= 10 ? 1100 : 250,
    windKmh: h >= 8 && h <= 10 ? 16 : 4,
    windDir: 315,
    tempC: 18,
    rhPct: 62
  }));

  const forecast = analyzeDispersionForecast(synthetic);
  assert.equal(forecast.available, true);
  assert.equal(forecast.bestOutdoorWindow.label, '08:00–10:00');
  assert.equal(forecast.peakAccumulationWindow.label, '00:00–02:00');
  assert.equal(forecast.trend, 'improving');
  assert.match(forecast.classification, /Stagnation Risk|Dispersion Conditions/i);

  const tooShort = analyzeDispersionForecast(synthetic.slice(0, 3));
  assert.equal(tooShort.available, false);
});

test('Indoor Physics Lab: steady-state mass-balance responds to room volume, leakage & CADR without ozone advice', () => {
  const tight = evaluateIndoorFiltration({
    floorAreaSqFt: 220,
    ceilingHeightFt: 9,
    outdoorPm25: 150,
    leakageId: 'tight',
    indoorSourceId: 'minimal',
    deviceCadrM3h: 280
  });
  const leaky = evaluateIndoorFiltration({
    floorAreaSqFt: 220,
    ceilingHeightFt: 9,
    outdoorPm25: 150,
    leakageId: 'leaky',
    indoorSourceId: 'minimal',
    deviceCadrM3h: 280
  });

  assert.ok(tight.dimensions.volumeM3 > 50 && tight.dimensions.volumeM3 < 65);
  assert.ok(tight.outcomes.filteredIndoorPm25 < tight.outcomes.unfilteredIndoorPm25);
  assert.ok(leaky.outcomes.unfilteredIndoorPm25 > tight.outcomes.unfilteredIndoorPm25);
  assert.ok(tight.safetyNotes.some((n) => /ozone/i.test(n)));
  assert.ok(tight.safetyNotes.some((n) => /NO₂|VOC/i.test(n)));
});

test('Impact Model: scales CO2 & savings to actual commute mode/distance and prevents double-counting', () => {
  const carProfile = normalizeProfile({ commuteMode: 'car', dailyCommuteKm: 24, cookingFuel: 'lpg-no-chimney' });
  const walkProfile = normalizeProfile({ commuteMode: 'wfh-walk', dailyCommuteKm: 0, cookingFuel: 'induction' });

  const carRes = evaluateSelectedScenarios(['transit-shift', 'sleep-filtration', 'fitted-n95'], carProfile, 160);
  const walkRes = evaluateSelectedScenarios(['transit-shift'], walkProfile, 160);

  assert.ok(carRes.co2SavedKgPerMonth > 30);
  assert.ok(carRes.exposureReductionPct > 0 && carRes.exposureReductionPct <= 75);
  assert.equal(walkRes.co2SavedKgPerMonth, 0);

  const none = evaluateSelectedScenarios([], carProfile, 160);
  assert.equal(none.exposureReductionPct, 0);

  const heur = calculateMortalityRiskHeuristic(22);
  assert.equal(heur.cigaretteEquivalentPerDay, 1);
  assert.match(heur.source, /Berkeley Earth/i);
});

test('Routine Engine: adapts guidance dynamically to severe vs favorable AQI', () => {
  const indoor = evaluateIndoorFiltration({ floorAreaSqFt: 220, outdoorPm25: 180 });
  const severeIntel = {
    cpcb: { aqi: 345, band: { label: 'Very Poor' }, primaryPollutant: { name: 'PM2.5' } },
    rollingAverages: { pm25_24h: 180 },
    current: { tempC: 14, windKmh: 4.2 },
    dispersion: {
      available: true,
      classification: 'Dispersion-Risk Estimate',
      trend: 'worsening',
      trendDeltaPct: 18,
      bestOutdoorWindow: { label: '14:00–16:00', avgPm25: 130 },
      peakAccumulationWindow: { label: '06:00–08:00', avgPm25: 220 },
      bestVentilationWindow: { label: '14:00–16:00', guidance: 'Brief 10–15 min flush only.' }
    }
  };

  const immediate = buildImmediateAction(severeIntel, { householdProfile: 'kids' });
  assert.equal(immediate.level, 'alert');
  assert.match(immediate.headline, /Very Poor/);

  const routine = buildIntelligentRoutine(severeIntel, { commuteMode: 'car', dailyCommuteKm: 20 }, indoor);
  assert.equal(routine.length, 6);
  assert.match(routine[1].action, /Recirculate/i);
});

test('Community Moderation: blocks PII addresses, PIN codes, phone numbers, links, abuse & missing consent', () => {
  assert.equal(moderateCommunitySubmission({
    area: 'Indiranagar',
    category: 'mobility',
    action: 'Starting a 4-family school carpool.',
    consentAccepted: false
  }).approved, false);

  assert.equal(moderateCommunitySubmission({
    area: 'Flat 402 Green Towers',
    category: 'mobility',
    action: 'Starting a 4-family school carpool.',
    consentAccepted: true
  }).approved, false);

  assert.equal(moderateCommunitySubmission({
    area: 'Coimbatore 641021',
    category: 'zero-burning',
    action: 'Composting all autumn leaves instead of burning.',
    consentAccepted: true
  }).approved, false);

  assert.equal(moderateCommunitySubmission({
    area: 'Sector 18 Noida',
    category: 'mobility',
    action: 'Call 9876543210 or visit https://spam.example.com for carpool',
    consentAccepted: true
  }).approved, false);

  const valid = moderateCommunitySubmission({
    area: 'Indiranagar East, Bengaluru',
    category: 'mobility',
    action: 'Coordinated a 4-family school carpool to reduce morning idling.',
    consentAccepted: true
  });
  assert.equal(valid.approved, true);

  const stats = computeCommunityStats([valid.entry, { category: 'zero-burning', supporters: 10 }]);
  assert.equal(stats.totalPledges, 2);
  assert.equal(stats.totalSupporters, 11);
});