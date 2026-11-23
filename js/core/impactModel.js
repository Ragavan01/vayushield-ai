/**
 * @fileoverview Evidence-based, parameterized personal exposure and emissions impact calculator.
 * Prevents double counting, scales transport math directly to the user's actual commute profile,
 * and exposes formulas, emission factors, and uncertainty bounds transparently.
 */

import { clampNumber, validateEnum } from './security.js';
import { evaluateIndoorFiltration } from './indoorPhysics.js';

export const COMMUTE_MODES = Object.freeze(['car', 'two-wheeler', 'public-transit', 'wfh-walk']);
export const HOUSEHOLD_PROFILES = Object.freeze(['general', 'kids', 'seniors-asthma', 'multi-gen']);
export const BUDGET_TIERS = Object.freeze(['zero-cost', 'diy-budget', 'hepa-smart']);
export const COOKING_FUELS = Object.freeze(['lpg-exhaust', 'lpg-no-chimney', 'induction', 'biomass-mixed']);

/**
 * India GHG Program / DEFRA-aligned transport tailpipe CO2 factors (kg CO2e per passenger-km)
 * and approximate direct fuel expenditure (INR per km at ~₹100/L petrol).
 */
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

/**
 * Illustrative Berkeley Earth (Muller & Muller, 2015) long-term mortality risk heuristic:
 * ~22 µg/m³ of 24-hour PM2.5 exposure corresponds statistically to ~1 cigarette/day in mortality studies.
 * Strictly labeled as an epidemiological heuristic, not chemical equivalence.
 * @param {number | null} pm25_24h
 */
export function calculateMortalityRiskHeuristic(pm25_24h) {
  if (typeof pm25_24h !== 'number' || !Number.isFinite(pm25_24h) || pm25_24h < 0) {
    return null;
  }
  return {
    cigaretteEquivalentPerDay: Number((pm25_24h / 22).toFixed(1)),
    source: 'Berkeley Earth (Muller & Muller, 2015)',
    caveat: 'Illustrative long-term mortality-risk heuristic based on 24-hr PM2.5 (~22 µg/m³ ≈ 1 cig/day); not chemically identical to tobacco smoke.'
  };
}

/**
 * Generates sustainable choice scenarios dynamically scaled to the user's actual commute, fuel, and room.
 * Each scenario affects a distinct emission/exposure pathway to prevent double-counting.
 * @param {ReturnType<typeof normalizeProfile>} profile
 * @param {number} outdoorPm25
 */
export function buildParameterizedScenarios(profile, outdoorPm25) {
  const safeProfile = normalizeProfile(profile);
  const currentMode = TRANSPORT_FACTORS[safeProfile.commuteMode];
  const transitMode = TRANSPORT_FACTORS['public-transit'];

  // Shift 3 commute days/week (~12 days/month) from private vehicle to public transit
  const monthlyShiftedKm = safeProfile.dailyCommuteKm * 12;
  const commuteCo2Delta = Math.max(0, Number(((currentMode.co2KgPerKm - transitMode.co2KgPerKm) * monthlyShiftedKm).toFixed(1)));
  const commuteInrDelta = Math.max(0, Math.round((currentMode.fuelInrPerKm - transitMode.fuelInrPerKm) * monthlyShiftedKm));

  // Kitchen: shifting ~30% of LPG boiling/simmering to electric induction (est. ~3.5 kg LPG/month saved -> ~10.4 kg CO2 gross, ~4.5 kg net on India grid ~0.71 kg CO2/kWh)
  const canShiftCooking = safeProfile.cookingFuel !== 'induction';
  const cookingNetCo2Kg = canShiftCooking ? 4.5 : 0;
  const cookingInrSaved = canShiftCooking ? 240 : 0;

  // Sleep envelope: compute real 8-hour indoor PM2.5 drop via mass-balance physics
  const roomModel = evaluateIndoorFiltration({
    floorAreaSqFt: safeProfile.roomSqFt,
    ceilingHeightFt: safeProfile.ceilingHeightFt,
    outdoorPm25,
    leakageId: safeProfile.leakageId,
    indoorSourceId: safeProfile.cookingFuel === 'induction' ? 'minimal' : 'cooking'
  });

  // 8 hours out of 24 hours in filtered bedroom -> weighted 24-hr exposure drop
  const sleepWeightedPm25Reduction = Number(
    (((roomModel.outcomes.unfilteredIndoorPm25 - roomModel.outcomes.filteredIndoorPm25) * 8) / 24).toFixed(1)
  );

  // N95 mask during 1.5h outdoor/commute (realistic fit-factor ~75–85% rather than theoretical 95%)
  const commuteHours = safeProfile.dailyCommuteKm > 0 ? Math.min(2.5, Math.max(0.5, safeProfile.dailyCommuteKm / 18)) : 0.5;
  const maskWeightedPm25Reduction = Number(((outdoorPm25 * 0.78 * commuteHours) / 24).toFixed(1));

  // Errand batching: 4 short cold-start trips/week (~24 km/mo) replaced by walking/cycling
  const errandKmPerMonth = safeProfile.commuteMode === 'wfh-walk' ? 0 : 24;
  const errandCo2Kg = Number((currentMode.co2KgPerKm * errandKmPerMonth * 1.15).toFixed(1)); // +15% cold-start factor
  const errandInr = Math.round(currentMode.fuelInrPerKm * errandKmPerMonth);

  return [
    {
      id: 'transit-shift',
      pathway: 'transport-commute',
      title: safeProfile.commuteMode === 'public-transit' || safeProfile.commuteMode === 'wfh-walk'
        ? 'Maintain Low-Emission Transit / Walk Commute'
        : `Shift 3 Commute Days/Week (${monthlyShiftedKm} km/mo) to Metro/Bus/Carpool`,
      pm25DoseCutUg: 0, // Transport shift cuts ambient emissions, not direct personal exposure unless enclosed
      co2SavedKgPerMonth: commuteCo2Delta,
      monthlySavingsInr: commuteInrDelta,
      assumption: `Calculated from ${safeProfile.dailyCommuteKm} km/day × 12 days/mo using ${currentMode.co2KgPerKm} vs ${transitMode.co2KgPerKm} kg CO₂/km.`
    },
    {
      id: 'sleep-filtration',
      pathway: 'indoor-sleep',
      title: `8-Hour Filtered Sleep Room (CADR ${roomModel.sizing.recommendedCadrM3h} m³/h)`,
      pm25DoseCutUg: Math.max(0, sleepWeightedPm25Reduction),
      co2SavedKgPerMonth: 0,
      monthlySavingsInr: 0,
      assumption: `Mass-balance model for ${safeProfile.roomSqFt} sq.ft (${safeProfile.leakageId} envelope): drops bedroom PM2.5 from ${roomModel.outcomes.unfilteredIndoorPm25} to ~${roomModel.outcomes.filteredIndoorPm25} µg/m³ for 8h/day.`
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
      pathway: 'kitchen-combustion',
      title: canShiftCooking
        ? 'Shift Boiling & Simmering to Induction + Continuous Exhaust'
        : 'Continue Electric/Induction Cooking with Lid Control',
      pm25DoseCutUg: canShiftCooking ? Number((outdoorPm25 > 80 ? 6.5 : 4.0).toFixed(1)) : 0,
      co2SavedKgPerMonth: cookingNetCo2Kg,
      monthlySavingsInr: cookingInrSaved,
      assumption: 'Net CO₂ accounts for India electricity grid carbon intensity (~0.71 kg CO₂/kWh) versus LPG (~2.98 kg CO₂/kg LPG).'
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
}

/**
 * Evaluates combined scenario impact without double-counting exposure pathways.
 * @param {string[]} selectedIds
 * @param {ReturnType<typeof normalizeProfile>} profile
 * @param {number} outdoorPm25
 */
export function evaluateSelectedScenarios(selectedIds, profile, outdoorPm25) {
  const safeOutdoor = clampNumber(outdoorPm25, 2, 600, 120);
  const scenarios = buildParameterizedScenarios(profile, safeOutdoor);
  const selectedSet = new Set(Array.isArray(selectedIds) ? selectedIds : []);
  const active = scenarios.filter((s) => selectedSet.has(s.id));

  // Estimate baseline 24-hr personal PM2.5 exposure (~78% of outdoor assuming ~18h indoors unfiltered + 6h outdoors)
  const baselinePersonalPm25 = Number((safeOutdoor * 0.78).toFixed(1));
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
      'Personal exposure reductions reflect 24-hr time-weighted inhalation math and do not lower outdoor citywide AQI on their own; CO₂ reductions require collective adoption to impact regional emissions.'
  };
}