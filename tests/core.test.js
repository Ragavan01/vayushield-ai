import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AQI_BANDS,
  CITY_PRESETS,
  buildWinterInversionWindows,
  calculateCigaretteEquivalent,
  classifyAqi,
  pm25ToCpcbAqi
} from '../js/core/aqiEngine.js';

import {
  SUSTAINABLE_SWAPS,
  calculateChoiceImpact,
  calculateFiltrationSizing,
  generateDailyRoutine,
  generateIndoorHacks,
  normalizeProfile
} from '../js/core/recommendationEngine.js';

test('AQI Engine: classifies all 6 CPCB severity bands accurately', () => {
  assert.equal(classifyAqi(25).id, 'good');
  assert.equal(classifyAqi(85).id, 'satisfactory');
  assert.equal(classifyAqi(160).id, 'moderate');
  assert.equal(classifyAqi(255).id, 'poor');
  assert.equal(classifyAqi(342).id, 'very-poor');
  assert.equal(classifyAqi(460).id, 'severe');
  assert.equal(classifyAqi(-50).id, 'good');
  assert.equal(classifyAqi(999).id, 'severe');
  assert.equal(AQI_BANDS.length, 6);
});

test('AQI Engine: converts PM2.5 to CPCB AQI across breakpoints', () => {
  assert.equal(pm25ToCpcbAqi(0), 0);
  assert.equal(pm25ToCpcbAqi(30), 50);
  assert.equal(pm25ToCpcbAqi(60), 100);
  assert.equal(pm25ToCpcbAqi(120), 300);
  assert.equal(pm25ToCpcbAqi(250), 400);
  assert.equal(pm25ToCpcbAqi(500), 500);
});

test('AQI Engine: calculates daily passive cigarette equivalence', () => {
  assert.equal(calculateCigaretteEquivalent(0), 0);
  assert.equal(calculateCigaretteEquivalent(22), 1);
  assert.equal(calculateCigaretteEquivalent(196), 8.9);
});

test('AQI Engine: winter inversion forecast shows cleaner afternoon dip than dawn peak', () => {
  const windows = buildWinterInversionWindows(300, 5);
  assert.equal(windows.length, 6);
  const dawn = windows[0].projectedAqi;
  const afternoon = windows[3].projectedAqi;
  assert.ok(afternoon < dawn, `Expected afternoon (${afternoon}) < dawn (${dawn})`);
  assert.ok(CITY_PRESETS.length >= 6);
});

test('Recommendation Engine: normalizes invalid profile fields safely', () => {
  const safe = normalizeProfile({
    commuteMode: 'jetpack',
    householdProfile: 'invalid',
    budgetTier: 'unknown',
    cookingFuel: 'wood-invalid',
    roomSqFt: 99999,
    dailyCommuteKm: -40
  });
  assert.equal(safe.commuteMode, 'two-wheeler');
  assert.equal(safe.householdProfile, 'multi-gen');
  assert.equal(safe.budgetTier, 'diy-budget');
  assert.equal(safe.cookingFuel, 'lpg-no-chimney');
  assert.equal(safe.roomSqFt, 1500);
  assert.equal(safe.dailyCommuteKm, 0);
});

test('Recommendation Engine: scales CADR filtration requirements with room area and AQI', () => {
  const smallModerate = calculateFiltrationSizing(120, 150);
  const largeSevere = calculateFiltrationSizing(450, 380);
  assert.ok(largeSevere.minCadrM3h > smallModerate.minCadrM3h);
  assert.equal(largeSevere.achTarget, 5);
  assert.ok(largeSevere.diyFansNeeded >= 2);
});

test('Recommendation Engine: builds 5-phase routine tailored to severe smog and commute mode', () => {
  const routine = generateDailyRoutine(
    { name: 'Delhi NCR', aqi: 342, pm25: 196 },
    { commuteMode: 'car', householdProfile: 'kids', cookingFuel: 'lpg-no-chimney', dailyCommuteKm: 24 }
  );
  assert.equal(routine.length, 5);
  assert.match(routine[0].action, /indoor/i);
  assert.match(routine[1].action, /Recirculate/i);
  assert.match(routine[3].action, /school/i);
});

test('Recommendation Engine: ranks indoor IAQ hacks matching selected budget tier first', () => {
  const zeroCostHacks = generateIndoorHacks({ aqi: 310, pm25: 170 }, { budgetTier: 'zero-cost', roomSqFt: 200 });
  const hepaHacks = generateIndoorHacks({ aqi: 310, pm25: 170 }, { budgetTier: 'hepa-smart', roomSqFt: 200 });
  assert.equal(zeroCostHacks[0].tier, 'zero-cost');
  assert.equal(hepaHacks[0].tier, 'hepa-smart');
});

test('Impact Simulator: never projects PM2.5 higher than baseline on ultra-clean air cities', () => {
  const cleanNone = calculateChoiceImpact([], 6);
  assert.equal(cleanNone.projectedPm25, 6);

  const cleanActive = calculateChoiceImpact(['hepa-sealed-sleep', 'transit-carpool'], 6);
  assert.ok(cleanActive.projectedPm25 <= 6);
});