/**
 * @fileoverview Single-zone steady-state indoor PM2.5 mass-balance calculator
 * grounded in US EPA / ASHRAE indoor particulate physics.
 *
 * Formula:
 *   C_in = (P * lambda_inf * C_out + E / V) / (lambda_inf + k_dep + CADR / V)
 *
 * Explicitly separates particulate removal (True HEPA) from gas/VOC removal (activated carbon + exhaust)
 * and never recommends ozone-generating ionizers.
 */

import { clampNumber, validateEnum } from './security.js';

export const LEAKAGE_PROFILES = Object.freeze({
  tight: Object.freeze({ id: 'tight', label: 'Well-Sealed (Weather-Stripped)', ach: 0.3, penetration: 0.72 }),
  average: Object.freeze({ id: 'average', label: 'Typical Urban Apartment', ach: 0.6, penetration: 0.80 }),
  leaky: Object.freeze({ id: 'leaky', label: 'Drafty / Older Windows', ach: 1.2, penetration: 0.88 })
});

export const INDOOR_SOURCE_PROFILES = Object.freeze({
  minimal: Object.freeze({ id: 'minimal', label: 'No Indoor Combustion / Electric Kitchen', emissionUgPerHr: 400 }),
  cooking: Object.freeze({ id: 'cooking', label: 'Daily LPG Cooking (No Ducted Chimney)', emissionUgPerHr: 4500 }),
  heavy: Object.freeze({ id: 'heavy', label: 'Frequent Frying / Incense / Mosquito Coils', emissionUgPerHr: 12000 })
});

const PM25_DEPOSITION_ACH = 0.39; // Typical indoor PM2.5 surface deposition loss rate (h^-1)

/**
 * Calculates room volume, required CADR for target ACH, and steady-state indoor PM2.5
 * before vs. after mechanical HEPA filtration.
 *
 * @param {{
 *   floorAreaSqFt?: number,
 *   ceilingHeightFt?: number,
 *   outdoorPm25?: number,
 *   leakageId?: 'tight' | 'average' | 'leaky',
 *   indoorSourceId?: 'minimal' | 'cooking' | 'heavy',
 *   targetAch?: number,
 *   deviceCadrM3h?: number
 * }} params
 */
export function evaluateIndoorFiltration(params = {}) {
  const floorAreaSqFt = Math.round(clampNumber(params.floorAreaSqFt, 60, 2000, 220));
  const ceilingHeightFt = Number(clampNumber(params.ceilingHeightFt, 7, 16, 9).toFixed(1));
  const outdoorPm25 = Number(clampNumber(params.outdoorPm25, 2, 600, 120).toFixed(1));

  const leakageKey = validateEnum(params.leakageId, Object.keys(LEAKAGE_PROFILES), 'average');
  const sourceKey = validateEnum(params.indoorSourceId, Object.keys(INDOOR_SOURCE_PROFILES), 'cooking');

  const leakage = LEAKAGE_PROFILES[leakageKey];
  const indoorSource = INDOOR_SOURCE_PROFILES[sourceKey];

  // Volume conversions: 1 sq.ft = 0.092903 m², 1 ft = 0.3048 m
  const floorAreaM2 = Number((floorAreaSqFt * 0.092903).toFixed(1));
  const ceilingHeightM = Number((ceilingHeightFt * 0.3048).toFixed(2));
  const volumeM3 = Number((floorAreaM2 * ceilingHeightM).toFixed(1));

  // Target effective Air Changes per Hour (ASHRAE/AHAM baseline: 4.8 ACH for heavy smog, 3–4 for moderate)
  const recommendedAch = Number(clampNumber(
    params.targetAch ?? (outdoorPm25 > 120 ? 5 : outdoorPm25 > 60 ? 4 : 3),
    2,
    8,
    4.5
  ).toFixed(1));

  const recommendedCadrM3h = Math.max(100, Math.round(volumeM3 * recommendedAch));
  const activeCadrM3h = Math.round(clampNumber(params.deviceCadrM3h ?? recommendedCadrM3h, 0, 1500, recommendedCadrM3h));
  const effectiveFiltrationAch = Number((activeCadrM3h / volumeM3).toFixed(2));

  // Unfiltered steady-state indoor PM2.5 (CADR = 0)
  const inflowUgPerM3Hr = leakage.penetration * leakage.ach * outdoorPm25 + (indoorSource.emissionUgPerHr / volumeM3);
  const unfilteredLossRate = leakage.ach + PM25_DEPOSITION_ACH;
  const unfilteredIndoorPm25 = Number((inflowUgPerM3Hr / unfilteredLossRate).toFixed(1));

  // Filtered steady-state indoor PM2.5
  const filteredLossRate = unfilteredLossRate + effectiveFiltrationAch;
  const filteredIndoorPm25 = Number((inflowUgPerM3Hr / filteredLossRate).toFixed(1));

  const reductionPct = unfilteredIndoorPm25 > 0
    ? Math.max(0, Math.round(((unfilteredIndoorPm25 - filteredIndoorPm25) / unfilteredIndoorPm25) * 100))
    : 0;

  // Uncertainty band (+/- 15% reflecting door openings, variable filter loading, and real-world mixing)
  const filteredLow = Math.max(2, Number((filteredIndoorPm25 * 0.85).toFixed(1)));
  const filteredHigh = Number((filteredIndoorPm25 * 1.15).toFixed(1));

  // Comparison across 3 budget tiers (no ozone/ionizer devices)
  const tiers = [
    {
      id: 'zero-cost',
      name: 'Zero-Cost Sealing & Source Control',
      estimatedCostInr: '₹0–₹300',
      cadrM3h: 0,
      note: 'Weather-stripping door gaps reduces infiltration from leaky to tight (~0.3 ACH), and eliminating indoor combustion removes internal spikes. Does not actively filter already-infiltrated PM2.5.'
    },
    {
      id: 'diy-budget',
      name: `DIY Corsi-Rosenthal / Exhaust-Fan + H13 HEPA Box (${Math.max(1, Math.ceil(recommendedCadrM3h / 300))} unit${recommendedCadrM3h > 300 ? 's' : ''})`,
      estimatedCostInr: `~₹${(2400 * Math.max(1, Math.ceil(recommendedCadrM3h / 300))).toLocaleString('en-IN')}`,
      cadrM3h: Math.min(recommendedCadrM3h, 300 * Math.max(1, Math.ceil(recommendedCadrM3h / 300))),
      note: 'Independent lab tests show properly sealed DIY fan + MERV-13/HEPA boxes deliver ~250–350 m³/h CADR per unit at a fraction of commercial cost.'
    },
    {
      id: 'hepa-smart',
      name: `Certified True H13 HEPA Purifier (CADR ≥ ${recommendedCadrM3h} m³/h)`,
      estimatedCostInr: recommendedCadrM3h > 350 ? '₹12,000–₹22,000' : '₹7,500–₹13,000',
      cadrM3h: recommendedCadrM3h,
      note: 'Select mechanical True HEPA (H13) with ionizer/ozone functions disabled or absent. Verify CADR at sleep/medium fan speed, not only maximum turbo noise.'
    }
  ];

  return {
    dimensions: { floorAreaSqFt, floorAreaM2, ceilingHeightFt, ceilingHeightM, volumeM3 },
    assumptions: {
      leakageLabel: leakage.label,
      infiltrationAch: leakage.ach,
      penetrationFactor: leakage.penetration,
      depositionAch: PM25_DEPOSITION_ACH,
      indoorSourceLabel: indoorSource.label,
      indoorEmissionUgPerHr: indoorSource.emissionUgPerHr,
      outdoorPm25
    },
    sizing: {
      recommendedAch,
      recommendedCadrM3h,
      activeCadrM3h,
      effectiveFiltrationAch
    },
    outcomes: {
      unfilteredIndoorPm25,
      filteredIndoorPm25,
      filteredRange: [filteredLow, filteredHigh],
      reductionPct
    },
    tiers,
    safetyNotes: [
      'True HEPA filters capture fine particles (PM2.5/PM10) but do not remove gaseous NO₂, CO, or VOCs; use ducted kitchen exhaust and pelleted activated carbon for gases.',
      'Avoid ozone-generating air cleaners or uncertified ionizers, as indoor ozone irritates airways and reacts with indoor compounds to create secondary ultrafine particles.'
    ]
  };
}