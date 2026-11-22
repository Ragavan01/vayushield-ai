/**
 * @fileoverview Tailored low-emission daily routine generator, budget-tiered indoor air quality
 * hacks, sustainable lifestyle swaps, and direct personal + community impact calculator.
 */

import { calculateCigaretteEquivalent, classifyAqi } from './aqiEngine.js';
import { clampNumber, validateEnum } from './security.js';

export const COMMUTE_MODES = Object.freeze(['car', 'two-wheeler', 'public-transit', 'wfh-walk']);
export const HOUSEHOLD_PROFILES = Object.freeze(['general', 'kids', 'seniors-asthma', 'multi-gen']);
export const BUDGET_TIERS = Object.freeze(['zero-cost', 'diy-budget', 'hepa-smart']);
export const COOKING_FUELS = Object.freeze(['lpg-exhaust', 'lpg-no-chimney', 'induction', 'biomass-mixed']);

/**
 * @typedef {Object} LifestyleProfile
 * @property {string} commuteMode
 * @property {string} householdProfile
 * @property {string} budgetTier
 * @property {string} cookingFuel
 * @property {number} roomSqFt
 * @property {number} dailyCommuteKm
 */

/**
 * Normalizes and validates user lifestyle preferences.
 * @param {Partial<LifestyleProfile>} raw
 * @returns {LifestyleProfile}
 */
export function normalizeProfile(raw = {}) {
  return {
    commuteMode: validateEnum(raw.commuteMode, COMMUTE_MODES, 'two-wheeler'),
    householdProfile: validateEnum(raw.householdProfile, HOUSEHOLD_PROFILES, 'multi-gen'),
    budgetTier: validateEnum(raw.budgetTier, BUDGET_TIERS, 'diy-budget'),
    cookingFuel: validateEnum(raw.cookingFuel, COOKING_FUELS, 'lpg-no-chimney'),
    roomSqFt: Math.round(clampNumber(raw.roomSqFt, 80, 1500, 220)),
    dailyCommuteKm: Math.round(clampNumber(raw.dailyCommuteKm, 0, 120, 18))
  };
}

/**
 * Calculates required Clean Air Delivery Rate (CADR) for a room using the 2/3 rule
 * scaled for severe winter smog (4–5 air changes per hour).
 * @param {number} roomSqFt
 * @param {number} aqi
 * @returns {{ minCadrM3h: number, diyFansNeeded: number, achTarget: number }}
 */
export function calculateFiltrationSizing(roomSqFt, aqi) {
  const area = clampNumber(roomSqFt, 80, 1500, 220);
  const achTarget = aqi > 300 ? 5 : aqi > 200 ? 4 : 3;
  // Assume 9 ft ceiling (~2.74 m); area in m² = sqFt * 0.0929
  const volumeM3 = area * 0.0929 * 2.74;
  const minCadrM3h = Math.max(120, Math.round(volumeM3 * achTarget));
  const diyFansNeeded = Math.max(1, Math.ceil(minCadrM3h / 340));
  return { minCadrM3h, diyFansNeeded, achTarget };
}

/**
 * Builds a tailored, time-blocked low-emission daily routine adapted to current AQI and lifestyle.
 * @param {{ aqi: number, pm25: number, name: string }} airData
 * @param {LifestyleProfile} rawProfile
 */
export function generateDailyRoutine(airData, rawProfile) {
  const profile = normalizeProfile(rawProfile);
  const band = classifyAqi(airData.aqi);
  const severeSmog = airData.aqi > 200;

  const morningExercise = severeSmog
    ? 'Replace 6:00–8:30 AM outdoor walks/jogs with indoor mobility or bodyweight workouts; dawn thermal inversion traps peak PM2.5.'
    : 'Outdoor morning activity is acceptable; prefer tree-lined parks away from arterial roads.';

  const commuteAction = {
    car: `Switch 2+ days/week to metro/carpool and set cabin AC to Recirculate (never Fresh Air) on high-smog corridors; cuts cabin PM2.5 by ~65% and lowers tailpipe emissions across your ${profile.dailyCommuteKm} km commute.`,
    'two-wheeler': `Wear a tight-seal N95 valve-less mask on your ${profile.dailyCommuteKm} km ride and shift errands off 8:30–10:30 AM rush; consider electric shuttle/metro on AQI > 250 days.`,
    'public-transit': `Time metro/bus boarding outside peak congestion and use an N95 mask at open road-level stops; your transit habit already cuts ~72% CO₂ vs. solo driving.`,
    'wfh-walk': `Schedule outdoor grocery walks between 1:30 PM and 4:00 PM when solar mixing lowers ground smog by ~25%.`
  }[profile.commuteMode];

  const householdNote = {
    kids: 'Keep school/play bags in an entryway zone, do saline nasal rinses after school, and shift evening play indoors.',
    'seniors-asthma': 'Keep prescribed rescue inhalers accessible, monitor resting SpO₂ during AQI > 300 days, and maintain a dedicated clean-air bedroom.',
    'multi-gen': 'Prioritize one sealed "Clean Air Core Room" for children and elders during peak smog hours (7 PM–9 AM).',
    general: 'Track afternoon AQI dips before opening windows and hydrate regularly to support mucosal clearance.'
  }[profile.householdProfile];

  const cookingAction = profile.cookingFuel === 'induction'
    ? 'Keep induction cooking paired with lid-covered simmering to minimize indoor ultrafine aerosols.'
    : 'Run kitchen exhaust continuously while cooking, cover frying pans, and shift slow-simmer dishes to electric kettle/induction to cut indoor NO₂ spikes by up to 55%.';

  return [
    {
      slot: '06:00 – 09:00',
      phase: 'Morning Inversion Guard',
      action: morningExercise,
      directImpact: severeSmog
        ? `Avoids ~${Math.round(airData.pm25 * 0.35)} µg/m³ peak inhalation spike during elevated breathing rate.`
        : 'Preserves baseline lung health with minimal ambient exposure.'
    },
    {
      slot: '09:00 – 12:30',
      phase: 'Low-Emission Commute & Work',
      action: commuteAction,
      directImpact: 'Reduces both personal road-corridor exposure and neighborhood tailpipe PM2.5/NO₂.'
    },
    {
      slot: '13:30 – 16:00',
      phase: 'Smart Ventilation Window',
      action: band.ventilationWindow,
      directImpact: 'Flushes accumulated indoor CO₂ (>1,000 ppm) during the day’s lowest outdoor smog trough.'
    },
    {
      slot: '18:00 – 21:00',
      phase: 'Clean-Air Kitchen & Family Zone',
      action: `${cookingAction} ${householdNote}`,
      directImpact: 'Prevents indoor PM2.5 spikes (often 3× outdoor levels during unvented frying or incense burning).'
    },
    {
      slot: '21:30 – 06:00',
      phase: 'Sealed Sleep Recovery',
      action: 'Seal under-door gaps with draft stoppers, wet-mop instead of dry-sweeping, and run filtration on quiet night mode.',
      directImpact: 'Delivers 8 hours of clean pulmonary recovery, slashing total 24-hour PM2.5 dose by 40–65%.'
    }
  ];
}

/**
 * Generates practical indoor air quality (IAQ) hacks customized by room size, budget, and AQI.
 * @param {{ aqi: number, pm25: number }} airData
 * @param {LifestyleProfile} rawProfile
 */
export function generateIndoorHacks(airData, rawProfile) {
  const profile = normalizeProfile(rawProfile);
  const sizing = calculateFiltrationSizing(profile.roomSqFt, airData.aqi);

  const hacks = [
    {
      id: 'wet-mopping',
      title: 'Damp Microfiber Mopping (Zero Dry-Sweeping)',
      tier: 'zero-cost',
      estimatedCostInr: 0,
      pm25ReductionPct: 12,
      howTo: 'Dry brooms resuspend settled PM10/PM2.5 dust for 2+ hours. Use a damp cloth/mop daily around entryways and windowsills.',
      impactExplanation: 'Prevents re-aerosolization of heavy traffic dust and soot tracked indoors on shoes.'
    },
    {
      id: 'door-sealing',
      title: 'Door Draft-Stopper & Window Gasket Seal',
      tier: 'zero-cost',
      estimatedCostInr: 150,
      pm25ReductionPct: 18,
      howTo: 'Tuck rolled damp towels or ₹150 silicone weather-stripping under balcony and front doors after 5:00 PM.',
      impactExplanation: 'Cuts outdoor smog infiltration rate by up to 30% during overnight thermal inversions.'
    },
    {
      id: 'source-ban',
      title: 'Zero Indoor Combustion Rule (Incense, Coils, Unvented Frying)',
      tier: 'zero-cost',
      estimatedCostInr: 0,
      pm25ReductionPct: 24,
      howTo: 'Replace mosquito coils with electric liquid vaporizers/nets and avoid incense sticks or candles indoors during smog days.',
      impactExplanation: 'One mosquito coil can emit PM2.5 equivalent to 75–100 cigarettes in a closed bedroom; eliminating it protects kids immediately.'
    },
    {
      id: 'corsi-rosenthal',
      title: `DIY Exhaust-Fan + True HEPA Filter Box (${sizing.diyFansNeeded} unit${sizing.diyFansNeeded > 1 ? 's' : ''})`,
      tier: 'diy-budget',
      estimatedCostInr: 2200 * sizing.diyFansNeeded,
      pm25ReductionPct: 58,
      howTo: `Tape a genuine H13 replacement HEPA filter (₹1,200) cleanly to the intake of a 12-inch box/exhaust fan (₹1,000) for your ${profile.roomSqFt} sq.ft room.`,
      impactExplanation: `Delivers ~${Math.min(sizing.minCadrM3h, 340 * sizing.diyFansNeeded)} m³/h clean air at 1/5th commercial purifier cost, achieving ${sizing.achTarget} air changes/hour.`
    },
    {
      id: 'hepa-sizing',
      title: `Right-Sized H13 HEPA Purifier (Min CADR ${sizing.minCadrM3h} m³/h)`,
      tier: 'hepa-smart',
      estimatedCostInr: 9500,
      pm25ReductionPct: 76,
      howTo: `Choose a mechanical True H13 HEPA purifier (ionizer OFF to avoid ozone) rated ≥${sizing.minCadrM3h} m³/h for ${profile.roomSqFt} sq.ft, placed 30 cm away from walls.`,
      impactExplanation: `Captures 99.97% of 0.3 µm particulates; lowers indoor PM2.5 from ~${Math.round(airData.pm25 * 0.7)} µg/m³ down to safe WHO zones (<25 µg/m³).`
    },
    {
      id: 'plant-reality',
      title: 'Science Reality Check: Indoor Plants vs. Mechanical Filtration',
      tier: 'zero-cost',
      estimatedCostInr: 0,
      pm25ReductionPct: 3,
      howTo: 'Keep snake/areca plants for humidity and mental well-being, but never rely on 2–3 potted plants to clear AQI 300+ winter smog.',
      impactExplanation: 'Peer-reviewed chamber studies show mechanical HEPA filtration cleans air 100×–1,000× faster than houseplants.'
    }
  ];

  // Prioritize hacks matching user's budget tier first
  return hacks.sort((a, b) => {
    const aMatch = a.tier === profile.budgetTier ? 0 : 1;
    const bMatch = b.tier === profile.budgetTier ? 0 : 1;
    return aMatch - bMatch;
  });
}

/**
 * Interactive sustainable lifestyle alternatives with transparent per-choice impact metrics.
 */
export const SUSTAINABLE_SWAPS = Object.freeze([
  Object.freeze({
    id: 'transit-carpool',
    title: 'Shift 3 Commute Days/Week to Metro, Bus, or Carpool',
    category: 'Mobility',
    co2SavedKgPerMonth: 48,
    pm25ExposureCutPct: 14,
    monthlySavingsInr: 2100,
    communityBenefit: 'Removes peak-hour tailpipe NO₂ and brake-wear PM2.5 from neighborhood school zones.'
  }),
  Object.freeze({
    id: 'induction-cooking',
    title: 'Use Induction / Electric Kettle for Tea, Boiling & Simmering',
    category: 'Clean Kitchen',
    co2SavedKgPerMonth: 19,
    pm25ExposureCutPct: 16,
    monthlySavingsInr: 450,
    communityBenefit: 'Cuts indoor NO₂ & carbon monoxide spikes while lowering household LPG cylinder demand.'
  }),
  Object.freeze({
    id: 'zero-waste-burning',
    title: 'Compost Dry Winter Leaves (Zero Open Burning Pledge)',
    category: 'Community',
    co2SavedKgPerMonth: 26,
    pm25ExposureCutPct: 11,
    monthlySavingsInr: 200,
    communityBenefit: 'Open leaf/trash burning emits ultra-toxic black carbon right at breathing height during winter nights.'
  }),
  Object.freeze({
    id: 'hepa-sealed-sleep',
    title: '8-Hour Clean-Air Sleep Envelope (Draft Seal + DIY/HEPA Filter)',
    category: 'Indoor Health',
    co2SavedKgPerMonth: 4,
    pm25ExposureCutPct: 34,
    monthlySavingsInr: 600,
    communityBenefit: 'Cuts winter respiratory clinic visits and inhalers by giving lungs 8 clean recovery hours nightly.'
  }),
  Object.freeze({
    id: 'smart-errand-batching',
    title: 'Batch Local Errands on Foot/Cycle During 1:30–4:00 PM Dip',
    category: 'Low-Emission Routine',
    co2SavedKgPerMonth: 16,
    pm25ExposureCutPct: 9,
    monthlySavingsInr: 550,
    communityBenefit: 'Eliminates cold-start engine trips—the highest-emission phase of any petrol/diesel vehicle.'
  }),
  Object.freeze({
    id: 'cold-wash-energy',
    title: 'Off-Peak Appliances + Cold-Water Laundry & LED Upgrades',
    category: 'Energy',
    co2SavedKgPerMonth: 22,
    pm25ExposureCutPct: 4,
    monthlySavingsInr: 700,
    communityBenefit: 'Reduces coal-fired winter evening peak grid load—lowering regional thermal power SO₂ & PM2.5.'
  })
]);

/**
 * Calculates combined direct personal, household, and 1,000-family community impact
 * from the user's selected sustainable alternatives.
 * @param {string[]} selectedSwapIds
 * @param {number} baselinePm25
 */
export function calculateChoiceImpact(selectedSwapIds, baselinePm25) {
  const safePm25 = clampNumber(baselinePm25, 5, 600, 120);
  const selectedSet = new Set(Array.isArray(selectedSwapIds) ? selectedSwapIds : []);
  const activeSwaps = SUSTAINABLE_SWAPS.filter((swap) => selectedSet.has(swap.id));

  // Diminishing-returns multiplicative model so exposure reduction stays physically realistic (max 78%)
  let remainingExposureRatio = 1;
  let co2SavedKgPerMonth = 0;
  let monthlySavingsInr = 0;

  for (const swap of activeSwaps) {
    remainingExposureRatio *= (1 - swap.pm25ExposureCutPct / 100);
    co2SavedKgPerMonth += swap.co2SavedKgPerMonth;
    monthlySavingsInr += swap.monthlySavingsInr;
  }

  const totalExposureReductionPct = Math.min(78, Math.round((1 - remainingExposureRatio) * 100));
  const projectedPm25 = Math.min(
    Math.round(safePm25),
    Math.max(2, Math.round(safePm25 * (1 - totalExposureReductionPct / 100)))
  );
  const baselineCigarettes = calculateCigaretteEquivalent(safePm25);
  const projectedCigarettes = calculateCigaretteEquivalent(projectedPm25);
  const cigarettesAvoidedPerDay = Number(Math.max(0, baselineCigarettes - projectedCigarettes).toFixed(1));

  return {
    selectedCount: activeSwaps.length,
    baselinePm25: Math.round(safePm25),
    projectedPm25,
    pm25ReducedUg: Math.max(0, Math.round(safePm25) - projectedPm25),
    totalExposureReductionPct,
    baselineCigarettes,
    projectedCigarettes,
    cigarettesAvoidedPerDay,
    co2SavedKgPerMonth,
    co2SavedKgPerYear: co2SavedKgPerMonth * 12,
    monthlySavingsInr,
    treesEquivalentPerYear: Number(((co2SavedKgPerMonth * 12) / 21).toFixed(1)),
    community1000FamiliesCo2TonsPerYear: Number(((co2SavedKgPerMonth * 12 * 1000) / 1000).toFixed(1))
  };
}