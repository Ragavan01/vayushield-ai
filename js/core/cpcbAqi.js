/**
 * @fileoverview Official Indian CPCB National Air Quality Index (NAQI) calculation engine
 * based on CPCB Technical Document CUPS/82/2014-15, paired with WHO 2021 AQG reference values.
 *
 * Strictly enforces:
 * - Pollutant-specific official breakpoints (PM2.5, PM10, NO2, SO2, O3, CO, NH3, Pb)
 * - Explicit unit normalization (e.g., CO ug/m3 -> mg/m3)
 * - Minimum 3-pollutant completeness rule (with PM2.5 or PM10 mandatory)
 * - Clear provenance distinction between official station readings vs. modeled CPCB-derived estimates
 */

import { clampNumber } from './security.js';

export const CPCB_BANDS = Object.freeze([
  Object.freeze({
    id: 'good',
    label: 'Good',
    min: 0,
    max: 50,
    impact: 'Minimal impact on general population.'
  }),
  Object.freeze({
    id: 'satisfactory',
    label: 'Satisfactory',
    min: 51,
    max: 100,
    impact: 'Minor breathing discomfort possible for people with pre-existing respiratory conditions.'
  }),
  Object.freeze({
    id: 'moderate',
    label: 'Moderately Polluted',
    min: 101,
    max: 200,
    impact: 'Breathing discomfort possible for people with lung or heart disease, children, and older adults.'
  }),
  Object.freeze({
    id: 'poor',
    label: 'Poor',
    min: 201,
    max: 300,
    impact: 'Breathing discomfort for most people on prolonged exposure; stronger effect on sensitive groups.'
  }),
  Object.freeze({
    id: 'very-poor',
    label: 'Very Poor',
    min: 301,
    max: 400,
    impact: 'Respiratory illness risk on prolonged exposure; pronounced effect on people with lung or heart disease.'
  }),
  Object.freeze({
    id: 'severe',
    label: 'Severe',
    min: 401,
    max: 500,
    impact: 'Affects healthy individuals and seriously impacts those with existing respiratory or cardiovascular conditions.'
  })
]);

/**
 * WHO Global Air Quality Guidelines (2021) short-term reference values.
 */
export const WHO_2021_GUIDELINES = Object.freeze({
  pm25: Object.freeze({ value: 15, unit: 'µg/m³', averaging: '24-hr' }),
  pm10: Object.freeze({ value: 45, unit: 'µg/m³', averaging: '24-hr' }),
  no2: Object.freeze({ value: 25, unit: 'µg/m³', averaging: '24-hr' }),
  so2: Object.freeze({ value: 40, unit: 'µg/m³', averaging: '24-hr' }),
  o3: Object.freeze({ value: 100, unit: 'µg/m³', averaging: '8-hr' }),
  co: Object.freeze({ value: 4.0, unit: 'mg/m³', averaging: '24-hr' })
});

/**
 * Official CPCB NAQI Breakpoints (CUPS/82/2014-15).
 * Each row: [B_LO, B_HI, I_LO, I_HI].
 * Continuous lower bounds prevent gaps for decimal concentrations (e.g., 50.4).
 */
export const CPCB_BREAKPOINTS = Object.freeze({
  pm25: Object.freeze({
    name: 'PM2.5',
    unit: 'µg/m³',
    averaging: '24-hr',
    table: Object.freeze([
      [0, 30, 0, 50],
      [30, 60, 51, 100],
      [60, 90, 101, 200],
      [90, 120, 201, 300],
      [120, 250, 301, 400],
      [250, 380, 401, 500]
    ])
  }),
  pm10: Object.freeze({
    name: 'PM10',
    unit: 'µg/m³',
    averaging: '24-hr',
    table: Object.freeze([
      [0, 50, 0, 50],
      [50, 100, 51, 100],
      [100, 250, 101, 200],
      [250, 350, 201, 300],
      [350, 430, 301, 400],
      [430, 510, 401, 500]
    ])
  }),
  no2: Object.freeze({
    name: 'NO₂',
    unit: 'µg/m³',
    averaging: '24-hr',
    table: Object.freeze([
      [0, 40, 0, 50],
      [40, 80, 51, 100],
      [80, 180, 101, 200],
      [180, 280, 201, 300],
      [280, 400, 301, 400],
      [400, 520, 401, 500]
    ])
  }),
  so2: Object.freeze({
    name: 'SO₂',
    unit: 'µg/m³',
    averaging: '24-hr',
    table: Object.freeze([
      [0, 40, 0, 50],
      [40, 80, 51, 100],
      [80, 380, 101, 200],
      [380, 800, 201, 300],
      [800, 1600, 301, 400],
      [1600, 2400, 401, 500]
    ])
  }),
  o3: Object.freeze({
    name: 'O₃',
    unit: 'µg/m³',
    averaging: '8-hr (1-hr >208)',
    table: Object.freeze([
      [0, 50, 0, 50],
      [50, 100, 51, 100],
      [100, 168, 101, 200],
      [168, 208, 201, 300],
      [208, 748, 301, 400],
      [748, 1000, 401, 500]
    ])
  }),
  co: Object.freeze({
    name: 'CO',
    unit: 'mg/m³',
    averaging: '8-hr',
    table: Object.freeze([
      [0, 1.0, 0, 50],
      [1.0, 2.0, 51, 100],
      [2.0, 10.0, 101, 200],
      [10.0, 17.0, 201, 300],
      [17.0, 34.0, 301, 400],
      [34.0, 51.0, 401, 500]
    ])
  }),
  nh3: Object.freeze({
    name: 'NH₃',
    unit: 'µg/m³',
    averaging: '24-hr',
    table: Object.freeze([
      [0, 200, 0, 50],
      [200, 400, 51, 100],
      [400, 800, 101, 200],
      [800, 1200, 201, 300],
      [1200, 1800, 301, 400],
      [1800, 2400, 401, 500]
    ])
  }),
  pb: Object.freeze({
    name: 'Pb',
    unit: 'µg/m³',
    averaging: '24-hr',
    table: Object.freeze([
      [0, 0.5, 0, 50],
      [0.5, 1.0, 51, 100],
      [1.0, 2.0, 101, 200],
      [2.0, 3.0, 201, 300],
      [3.0, 3.5, 301, 400],
      [3.5, 4.5, 401, 500]
    ])
  })
});

/**
 * Converts CO from µg/m³ (Open-Meteo standard) to mg/m³ (CPCB standard).
 * @param {number} ugPerM3
 * @returns {number | null}
 */
export function coUgToMg(ugPerM3) {
  const num = Number(ugPerM3);
  if (!Number.isFinite(num) || num < 0) return null;
  return Number((num / 1000).toFixed(3));
}

/**
 * Classifies an AQI integer (0–500) into its official CPCB band.
 * @param {number} aqi
 */
export function classifyCpcbBand(aqi) {
  const safe = Math.round(clampNumber(aqi, 0, 500, 0));
  return CPCB_BANDS.find((b) => safe >= b.min && safe <= b.max) || CPCB_BANDS[CPCB_BANDS.length - 1];
}

/**
 * Calculates a single pollutant's CPCB sub-index using linear interpolation.
 * Returns null for missing, negative, or non-finite inputs.
 * @param {keyof typeof CPCB_BREAKPOINTS} pollutant
 * @param {unknown} rawValue
 * @returns {{ pollutant: string, name: string, concentration: number, unit: string, averaging: string, subIndex: number, exceededScale: boolean } | null}
 */
export function calculatePollutantSubIndex(pollutant, rawValue) {
  const spec = CPCB_BREAKPOINTS[pollutant];
  if (!spec || rawValue === null || rawValue === undefined || rawValue === '') {
    return null;
  }

  const c = Number(rawValue);
  if (!Number.isFinite(c) || c < 0) {
    return null;
  }

  for (const [bLo, bHi, iLo, iHi] of spec.table) {
    if (c <= bHi) {
      const subIndex = Math.round(((iHi - iLo) / (bHi - bLo)) * (c - bLo) + iLo);
      return {
        pollutant,
        name: spec.name,
        concentration: Number(c.toFixed(pollutant === 'co' || pollutant === 'pb' ? 2 : 1)),
        unit: spec.unit,
        averaging: spec.averaging,
        subIndex: Math.min(500, Math.max(0, subIndex)),
        exceededScale: false
      };
    }
  }

  // Above top breakpoint: CPCB Severe (>400, capped at 500 on standard scale, flagged explicitly)
  return {
    pollutant,
    name: spec.name,
    concentration: Number(c.toFixed(pollutant === 'co' || pollutant === 'pb' ? 2 : 1)),
    unit: spec.unit,
    averaging: spec.averaging,
    subIndex: 500,
    exceededScale: true
  };
}

/**
 * Computes rolling mean from an array of hourly observations requiring at least 75% completeness
 * (matching CPCB minimum 16/24 hours or 6/8 hours validity requirement).
 * @param {Array<number | null | undefined>} values
 * @param {number} windowHours
 * @returns {{ average: number | null, validHours: number, requiredHours: number, completenessPct: number }}
 */
export function computeRollingAverage(values, windowHours) {
  const slice = Array.isArray(values) ? values.slice(-windowHours) : [];
  const valid = slice.filter((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0);
  const requiredHours = Math.ceil(windowHours * 0.75);
  const completenessPct = windowHours > 0 ? Math.round((valid.length / windowHours) * 100) : 0;

  if (valid.length < requiredHours) {
    return { average: null, validHours: valid.length, requiredHours, completenessPct };
  }

  const mean = valid.reduce((sum, v) => sum + v, 0) / valid.length;
  return {
    average: Number(mean.toFixed(2)),
    validHours: valid.length,
    requiredHours,
    completenessPct
  };
}

/**
 * Evaluates overall CPCB AQI across all available pollutants with strict provenance & completeness checks.
 *
 * @param {Partial<Record<keyof typeof CPCB_BREAKPOINTS, number | null>>} concentrations
 * @param {{ sourceType?: 'station' | 'modeled', averagingValidated?: boolean }} [options]
 */
export function calculateCpcbAqi(concentrations = {}, options = {}) {
  const sourceType = options.sourceType === 'station' ? 'station' : 'modeled';
  const averagingValidated = options.averagingValidated !== false;

  const subIndices = [];
  for (const key of Object.keys(CPCB_BREAKPOINTS)) {
    const result = calculatePollutantSubIndex(key, concentrations[key]);
    if (result) {
      subIndices.push(result);
    }
  }

  const hasParticulate = subIndices.some((s) => s.pollutant === 'pm25' || s.pollutant === 'pm10');
  const meetsMinimumThree = subIndices.length >= 3 && hasParticulate;
  const isOfficialCpcb = sourceType === 'station' && meetsMinimumThree && averagingValidated;

  if (subIndices.length === 0) {
    return {
      aqi: null,
      band: null,
      primaryPollutant: null,
      subIndices: [],
      validPollutantCount: 0,
      meetsCompletenessRule: false,
      isOfficialCpcb: false,
      methodologyLabel: 'Insufficient valid pollutant data to compute AQI',
      caveats: ['No valid pollutant concentrations were supplied.']
    };
  }

  subIndices.sort((a, b) => b.subIndex - a.subIndex);
  const primary = subIndices[0];
  const band = classifyCpcbBand(primary.subIndex);

  const caveats = [];
  if (sourceType === 'modeled') {
    caveats.push('Computed from modeled atmospheric grid data (CAMS/Open-Meteo), not a direct CPCB CAAQMS ground monitor.');
  }
  if (!meetsMinimumThree) {
    caveats.push('Fewer than 3 valid pollutants (with PM2.5 or PM10 required) were available; formal CPCB reporting threshold not met.');
  }
  if (!averagingValidated) {
    caveats.push('Input uses shorter-than-standard averaging periods rather than full 24-hr/8-hr rolling windows.');
  }
  if (primary.exceededScale) {
    caveats.push(`${primary.name} exceeds the standard CPCB 500 upper breakpoint (${primary.concentration} ${primary.unit}).`);
  }

  const methodologyLabel = isOfficialCpcb
    ? 'Official CPCB National AQI (Station Observed)'
    : meetsMinimumThree && averagingValidated
      ? 'CPCB-Derived Modeled Estimate (24h/8h Rolling)'
      : 'Indicative CPCB-Scale Estimate (Incomplete Inputs)';

  return {
    aqi: primary.subIndex,
    band,
    primaryPollutant: primary,
    subIndices,
    validPollutantCount: subIndices.length,
    meetsCompletenessRule: meetsMinimumThree,
    isOfficialCpcb,
    methodologyLabel,
    caveats
  };
}

/**
 * Evaluates WHO 2021 short-term guideline ratio (e.g., 6.3x WHO 24-hr PM2.5 guideline).
 * @param {'pm25'|'pm10'|'no2'|'so2'|'o3'|'co'} pollutant
 * @param {number | null} value
 */
export function compareToWhoGuideline(pollutant, value) {
  const ref = WHO_2021_GUIDELINES[pollutant];
  if (!ref || typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null;
  }
  const ratio = Number((value / ref.value).toFixed(1));
  return {
    guidelineValue: ref.value,
    unit: ref.unit,
    averaging: ref.averaging,
    ratio,
    exceeds: value > ref.value
  };
}