/**
 * @fileoverview Single-zone steady-state indoor PM2.5 mass-balance calculator
 * grounded in US EPA Residential Air Cleaners (3rd Ed.) & ANSI/AHAM AC-1.
 * - Certified CADR mode uses CADR directly (already includes single-pass filter efficiency)
 * - Raw Fan Airflow mode computes Effective CADR = Q * eta (for DIY fan + MERV-13 builds)
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

export const FILTER_EFFICIENCY_PROFILES = Object.freeze({
  h13: Object.freeze({ id: 'h13', label: 'True HEPA H13 (99.95% @ 0.3 µm)', efficiency: 0.9995, pct: 99.95 }),
  epa11: Object.freeze({ id: 'epa11', label: 'EPA E11 / HEPA-Type (95%)', efficiency: 0.95, pct: 95 }),
  merv13: Object.freeze({ id: 'merv13', label: 'MERV-13 DIY Box Filter (85% PM2.5)', efficiency: 0.85, pct: 85 })
});

const PM25_DEPOSITION_ACH = 0.39;

function solveSteadyStatePm25(inflowUgPerM3Hr, baseLossRate, volumeM3, effectiveCadrM3h) {
  const eAch = effectiveCadrM3h / volumeM3;
  const steadyPm25 = inflowUgPerM3Hr / (baseLossRate + eAch);
  return {
    effectiveCadrM3h: Math.round(effectiveCadrM3h),
    effectiveAch: Number(eAch.toFixed(2)),
    steadyPm25: Number(steadyPm25.toFixed(1))
  };
}

export function evaluateIndoorFiltration(params = {}) {
  const floorAreaSqFt = Math.round(clampNumber(params.floorAreaSqFt, 60, 2000, 220));
  const ceilingHeightFt = Number(clampNumber(params.ceilingHeightFt, 7, 16, 9).toFixed(1));
  const outdoorPm25 = Number(clampNumber(params.outdoorPm25, 2, 600, 120).toFixed(1));

  const leakageKey = validateEnum(params.leakageId, Object.keys(LEAKAGE_PROFILES), 'average');
  const sourceKey = validateEnum(params.indoorSourceId, Object.keys(INDOOR_SOURCE_PROFILES), 'cooking');
  const filterKey = validateEnum(params.filterGradeId, Object.keys(FILTER_EFFICIENCY_PROFILES), 'h13');
  const inputMode = validateEnum(params.inputMode, ['cadr', 'airflow'], 'cadr');

  const leakage = LEAKAGE_PROFILES[leakageKey];
  const indoorSource = INDOOR_SOURCE_PROFILES[sourceKey];
  const filterGrade = FILTER_EFFICIENCY_PROFILES[filterKey];

  const floorAreaM2 = Number((floorAreaSqFt * 0.092903).toFixed(1));
  const ceilingHeightM = Number((ceilingHeightFt * 0.3048).toFixed(2));
  const volumeM3 = Number((floorAreaM2 * ceilingHeightM).toFixed(1));

  const recommendedAch = Number(clampNumber(
    params.targetAch ?? (outdoorPm25 > 120 ? 5 : outdoorPm25 > 60 ? 4 : 3),
    2,
    8,
    4.5
  ).toFixed(1));

  const recommendedCadrM3h = Math.max(100, Math.round(volumeM3 * recommendedAch));
  const requiredFanAirflowM3h = Math.round(recommendedCadrM3h / filterGrade.efficiency);

  const activeInputM3h = Math.round(clampNumber(params.deviceCadrM3h ?? recommendedCadrM3h, 0, 1500, recommendedCadrM3h));
  const effectiveCadrM3h = inputMode === 'airflow'
    ? activeInputM3h * filterGrade.efficiency
    : activeInputM3h;

  const inflowUgPerM3Hr = leakage.penetration * leakage.ach * outdoorPm25 + (indoorSource.emissionUgPerHr / volumeM3);
  const unfilteredLossRate = leakage.ach + PM25_DEPOSITION_ACH;
  const unfilteredIndoorPm25 = Number((inflowUgPerM3Hr / unfilteredLossRate).toFixed(1));

  const activeOutcome = solveSteadyStatePm25(inflowUgPerM3Hr, unfilteredLossRate, volumeM3, effectiveCadrM3h);
  const filteredIndoorPm25 = activeOutcome.steadyPm25;

  const reductionPct = unfilteredIndoorPm25 > 0
    ? Math.max(0, Math.round(((unfilteredIndoorPm25 - filteredIndoorPm25) / unfilteredIndoorPm25) * 100))
    : 0;

  const filteredLow = Math.max(2, Number((filteredIndoorPm25 * 0.85).toFixed(1)));
  const filteredHigh = Number((filteredIndoorPm25 * 1.15).toFixed(1));

  const maxCurveCadr = Math.max(600, Math.ceil((Math.max(effectiveCadrM3h, recommendedCadrM3h) + 120) / 100) * 100);
  const curveSteps = 8;
  const cadrCurve = [];
  for (let i = 0; i <= curveSteps; i++) {
    const cadr = Math.round((maxCurveCadr / curveSteps) * i);
    const solved = solveSteadyStatePm25(inflowUgPerM3Hr, unfilteredLossRate, volumeM3, cadr);
    cadrCurve.push({ cadrM3h: cadr, effectiveAch: solved.effectiveAch, indoorPm25: solved.steadyPm25 });
  }

  const tiers = [
    {
      id: 'zero-cost',
      name: 'Zero-Cost Sealing & Source Control',
      estimatedCostInr: '₹0–₹300',
      cadrM3h: 0,
      note: 'Weather-stripping door gaps reduces infiltration toward ~0.3 ACH, and removing indoor combustion eliminates internal spikes. Does not actively filter already-infiltrated PM2.5.'
    },
    {
      id: 'diy-budget',
      name: `DIY Corsi-Rosenthal / Exhaust-Fan + MERV-13/HEPA Box (${Math.max(1, Math.ceil(recommendedCadrM3h / 300))} unit${recommendedCadrM3h > 300 ? 's' : ''})`,
      estimatedCostInr: `~₹${(2400 * Math.max(1, Math.ceil(recommendedCadrM3h / 300))).toLocaleString('en-IN')}`,
      cadrM3h: Math.min(recommendedCadrM3h, 300 * Math.max(1, Math.ceil(recommendedCadrM3h / 300))),
      note: 'Independent aerosol-chamber tests show sealed DIY fan + MERV-13/HEPA boxes deliver ~250–350 m³/h effective CADR per unit at a fraction of commercial cost.'
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
      inputMode,
      leakageLabel: leakage.label,
      infiltrationAch: leakage.ach,
      penetrationFactor: leakage.penetration,
      depositionAch: PM25_DEPOSITION_ACH,
      indoorSourceLabel: indoorSource.label,
      indoorEmissionUgPerHr: indoorSource.emissionUgPerHr,
      filterGradeId: filterGrade.id,
      filterGradeLabel: filterGrade.label,
      filterEfficiencyPct: filterGrade.pct,
      outdoorPm25
    },
    sizing: {
      recommendedAch,
      recommendedCadrM3h,
      requiredFanAirflowM3h,
      activeCadrM3h: activeInputM3h,
      effectiveCadrM3h: activeOutcome.effectiveCadrM3h,
      effectiveFiltrationAch: activeOutcome.effectiveAch
    },
    outcomes: {
      unfilteredIndoorPm25,
      filteredIndoorPm25,
      filteredRange: [filteredLow, filteredHigh],
      reductionPct
    },
    cadrCurve,
    tiers,
    safetyNotes: [
      inputMode === 'cadr'
        ? 'Certified CADR mode (ANSI/AHAM AC-1): CADR already incorporates filter efficiency (CADR = Q · η) and is not penalized twice. Steady-state C_in = (P·λ_inf·C_out + E/V) / (λ_inf + k_dep + CADR/V), ±15% mixing uncertainty.'
        : `Raw Fan Airflow mode: Effective CADR = Airflow (${activeInputM3h} m³/h) × ${filterGrade.pct}% (${filterGrade.label}) = ${activeOutcome.effectiveCadrM3h} m³/h.`,
      'True HEPA filters capture fine particles (PM2.5/PM10) but do not remove gaseous NO₂, CO, or VOCs; use ducted kitchen exhaust and pelleted activated carbon for gases.',
      'Avoid ozone-generating air cleaners or uncertified ionizers, as indoor ozone irritates airways and forms secondary ultrafine particles.'
    ]
  };
}