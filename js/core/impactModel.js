/**
 * @fileoverview Parameterized personal exposure and emissions impact simulator.
 * Internally consistent with indoorPhysics.js (18h unfiltered indoor + 6h outdoor baseline)
 * and prevents pathway double-counting across transport, sleep, daytime kitchen, and commute.
 */

import { clampNumber, validateEnum } from './security.js';
import { evaluateIndoorFiltration } from './indoorPhysics.js';

export const COMMUTE_MODES = Object.freeze(['car', 'two-wheeler', 'public-transit', 'wfh-walk']);
export const HOUSEHOLD_PROFILES = Object.freeze(['general', 'kids', 'seniors-asthma', 'multi-gen']);
export const BUDGET_TIERS = Object.freeze(['zero-cost', 'diy-budget', 'hepa-smart']);
export const COOKING_FUELS = Object.freeze(['lpg-exhaust', 'lpg-no-chimney', 'induction', 'biomass-mixed']);

const TRANSPORT_FACTORS = Object.freeze({
  car: Object.freeze({ co2KgPerKm: 0.171, fuelInrPerKm: 7.5, label: 'Petrol/Diesel Car' }),
  'two-wheeler': Object.freeze({ co2KgPerKm: 0.049, fuelInrPerKm: 2.3, label: 'Two-Wheeler' }),
  'public-transit': Object.freeze({ co2KgPerKm: 0.035, fuelInrPerKm: 1.4, label: 'Metro / Bus Transit' }),
  'wfh-walk': Object.freeze({ co2KgPerKm: 0, fuelInrPerKm: 0, label: 'Walk / Work From Home' })
});

export function normalizeProfile(raw = {}) {
  return {
    commuteMode: validateEnum(raw.commuteMode, COMMUTE_MODES, 'two-wheeler'),
    householdProfile: validateEnum(raw.householdProfile, HOUSEHOLD_PROFILES, 'multi-gen'),
    budgetTier: validateEnum(raw.budgetTier, BUDGET_TIERS, 'diy-budget'),
    cookingFuel: validateEnum(raw.cookingFuel, COOKING_FUELS, 'lpg-no-chimney'),
    roomSqFt: Math.round(clampNumber(raw.roomSqFt, 60, 2000, 220)),
    ceilingHeightFt: Number(clampNumber(raw.ceilingHeightFt, 7, 16, 9).toFixed(1)),
    dailyCommuteKm: Math.round(clampNumber(raw.dailyCommuteKm, 0, 120, 18)),
    leakageId: validateEnum(raw.leakageId, ['tight', 'average', 'leaky'], 'average')
  };
}

export function calculateMortalityRiskHeuristic(pm25_24h) {
  if (typeof pm25_24h !== 'number' || !Number.isFinite(pm25_24h) || pm25_24h < 0) return null;
  return {
    cigaretteEquivalentPerDay: Number((pm25_24h / 22).toFixed(1)),
    source: 'Berkeley Earth (Muller & Muller, 2015)',
    caveat: 'Illustrative long-term mortality-risk heuristic based on 24-hr PM2.5 (~22 µg/m³ ≈ 1 cig/day); not chemically identical to tobacco smoke or an individual clinical prediction.'
  };
}

function getIndoorSourceId(cookingFuel) {
  if (cookingFuel === 'induction') return 'minimal';
  if (cookingFuel === 'biomass-mixed') return 'heavy';
  return 'cooking';
}

function computeRoomAndScenarios(profile, outdoorPm25) {
  const safeProfile = normalizeProfile(profile);
  const currentMode = TRANSPORT_FACTORS[safeProfile.commuteMode];
  const transitMode = TRANSPORT_FACTORS['public-transit'];

  const monthlyShiftedKm = safeProfile.dailyCommuteKm * 12;
  const commuteCo2Delta = Math.max(0, Number(((currentMode.co2KgPerKm - transitMode.co2KgPerKm) * monthlyShiftedKm).toFixed(1)));
  const commuteInrDelta = Math.max(0, Math.round((currentMode.fuelInrPerKm - transitMode.fuelInrPerKm) * monthlyShiftedKm));

  const canShiftCooking = safeProfile.cookingFuel !== 'induction';
  const cookingNetCo2Kg = canShiftCooking ? 4.5 : 0;
  const cookingInrSaved = canShiftCooking ? 240 : 0;

  const baselineRoom = evaluateIndoorFiltration({
    floorAreaSqFt: safeProfile.roomSqFt,
    ceilingHeightFt: safeProfile.ceilingHeightFt,
    outdoorPm25,
    leakageId: safeProfile.leakageId,
    indoorSourceId: getIndoorSourceId(safeProfile.cookingFuel)
  });

  const cleanKitchenRoom = canShiftCooking
    ? evaluateIndoorFiltration({
        floorAreaSqFt: safeProfile.roomSqFt,
        ceilingHeightFt: safeProfile.ceilingHeightFt,
        outdoorPm25,
        leakageId: safeProfile.leakageId,
        indoorSourceId: 'minimal'
      })
    : baselineRoom;

  const sleepWeightedPm25Reduction = Number(
    (((baselineRoom.outcomes.unfilteredIndoorPm25 - baselineRoom.outcomes.filteredIndoorPm25) * 8) / 24).toFixed(1)
  );
  const kitchenWeightedPm25Reduction = canShiftCooking
    ? Math.max(0, Number((((baselineRoom.outcomes.unfilteredIndoorPm25 - cleanKitchenRoom.outcomes.unfilteredIndoorPm25) * 10) / 24).toFixed(1)))
    : 0;

  const commuteHours = safeProfile.dailyCommuteKm > 0 ? Math.min(2.5, Math.max(0.5, safeProfile.dailyCommuteKm / 18)) : 0.5;
  const maskWeightedPm25Reduction = Number(((outdoorPm25 * 0.78 * commuteHours) / 24).toFixed(1));

  const errandKmPerMonth = safeProfile.commuteMode === 'wfh-walk' ? 0 : 24;
  const errandCo2Kg = Number((currentMode.co2KgPerKm * errandKmPerMonth * 1.15).toFixed(1));
  const errandInr = Math.round(currentMode.fuelInrPerKm * errandKmPerMonth);

  const scenarios = [
    {
      id: 'transit-shift',
      pathway: 'transport-commute',
      title: safeProfile.commuteMode === 'public-transit' || safeProfile.commuteMode === 'wfh-walk'
        ? 'Maintain Low-Emission Transit / Walk Commute'
        : `Shift 3 Commute Days/Week (${monthlyShiftedKm} km/mo) to Metro/Bus/Carpool`,
      pm25DoseCutUg: 0,
      co2SavedKgPerMonth: commuteCo2Delta,
      monthlySavingsInr: commuteInrDelta,
      assumption: `Calculated from ${safeProfile.dailyCommuteKm} km/day × 12 days/mo using ${currentMode.co2KgPerKm} vs ${transitMode.co2KgPerKm} kg CO₂/km.`
    },
    {
      id: 'sleep-filtration',
      pathway: 'indoor-sleep-8h',
      title: `8-Hour Filtered Sleep Room (CADR ${baselineRoom.sizing.recommendedCadrM3h} m³/h)`,
      pm25DoseCutUg: Math.max(0, sleepWeightedPm25Reduction),
      co2SavedKgPerMonth: 0,
      monthlySavingsInr: 0,
      assumption: `Mass-balance model for ${safeProfile.roomSqFt} sq.ft (${safeProfile.leakageId} envelope): drops bedroom PM2.5 from ${baselineRoom.outcomes.unfilteredIndoorPm25} to ${baselineRoom.outcomes.filteredIndoorPm25} µg/m³ for 8h/day.`
    },
    {
      id: 'fitted-n95',
      pathway: 'outdoor-commute',
      title: `Well-Sealed N95 Mask During Outdoor Commute (~${commuteHours.toFixed(1)} hr/day)`,
      pm25DoseCutUg: Math.max(0, maskWeightedPm25Reduction),
      co2SavedKgPerMonth: 0,
      monthlySavingsInr: 0,
      assumption: `Assumes realistic 78% real-world seal efficiency (accounting for fit leakage below 95% lab rating) across ${commuteHours.toFixed(1)} outdoor hrs/day.`
    },
    {
      id: 'clean-kitchen',
      pathway: 'indoor-daytime-10h',
      title: canShiftCooking
        ? 'Shift Boiling & Simmering to Induction + Continuous Exhaust'
        : 'Continue Electric/Induction Cooking with Lid Control',
      pm25DoseCutUg: kitchenWeightedPm25Reduction,
      co2SavedKgPerMonth: cookingNetCo2Kg,
      monthlySavingsInr: cookingInrSaved,
      assumption: 'Modeled across 10 daytime indoor hours (distinct from 8h sleep filtration); net CO₂ accounts for India grid intensity (~0.71 kg CO₂/kWh) vs. LPG (~2.98 kg CO₂/kg).'
    },
    {
      id: 'errand-batching',
      pathway: 'local-trips',
      title: 'Eliminate Short Cold-Start Local Trips (~24 km/mo on Foot/Cycle)',
      pm25DoseCutUg: 0,
      co2SavedKgPerMonth: errandCo2Kg,
      monthlySavingsInr: errandInr,
      assumption: 'Replaces ~6 km/week of short vehicle errands including a 15% cold-start emission penalty.'
    }
  ];

  return { baselineRoom, scenarios };
}

export function buildParameterizedScenarios(profile, outdoorPm25) {
  return computeRoomAndScenarios(profile, outdoorPm25).scenarios;
}

export function evaluateSelectedScenarios(selectedIds, profile, outdoorPm25) {
  const safeOutdoor = clampNumber(outdoorPm25, 2, 600, 120);
  const { baselineRoom, scenarios } = computeRoomAndScenarios(profile, safeOutdoor);
  const selectedSet = new Set(Array.isArray(selectedIds) ? selectedIds : []);
  const active = scenarios.filter((s) => selectedSet.has(s.id));

  const baselinePersonalPm25 = Number(
    (((baselineRoom.outcomes.unfilteredIndoorPm25 * 18) + (safeOutdoor * 6)) / 24).toFixed(1)
  );
  const rawDoseCut = active.reduce((sum, s) => sum + s.pm25DoseCutUg, 0);
  const boundedDoseCut = Number(Math.min(baselinePersonalPm25 * 0.75, rawDoseCut).toFixed(1));
  const projectedPersonalPm25 = Number(Math.max(2, baselinePersonalPm25 - boundedDoseCut).toFixed(1));
  const exposureReductionPct = baselinePersonalPm25 > 0
    ? Math.round((boundedDoseCut / baselinePersonalPm25) * 100)
    : 0;

  const co2SavedKgPerMonth = Number(active.reduce((sum, s) => sum + s.co2SavedKgPerMonth, 0).toFixed(1));
  const monthlySavingsInr = Math.round(active.reduce((sum, s) => sum + s.monthlySavingsInr, 0));

  return {
    scenarios,
    selectedCount: active.length,
    baselinePersonalPm25,
    projectedPersonalPm25,
    pm25DoseCutUg: boundedDoseCut,
    exposureReductionPct,
    co2SavedKgPerMonth,
    co2SavedKgPerYear: Number((co2SavedKgPerMonth * 12).toFixed(1)),
    monthlySavingsInr,
    community1000HouseholdsCo2TonsYr: Number(((co2SavedKgPerMonth * 12 * 1000) / 1000).toFixed(1)),
    methodologyDisclaimer:
      'Hypothetical scenario estimates only (not measured personal exposure): baseline uses 18h modeled unfiltered indoor PM2.5 + 6h outdoor PM2.5 with ±20% behavioral/ventilation uncertainty. Personal reductions do not lower citywide ambient AQI.'
  };
}