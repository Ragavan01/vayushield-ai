/**
 * @fileoverview Standardized environmental data integrity layer.
 * Enforces:
 * - Physical non-negativity on all pollutant concentrations (FIX 01 & FIX 07)
 * - Canonical EnvironmentalReading records with full provenance metadata
 * - Measurement-timestamp vs. retrieval-timestamp freshness classification
 * - Clean separation between projected concentrations and signed deltas
 */

export const FRESHNESS_STATES = Object.freeze({
  FRESH: 'Fresh',
  RECENT: 'Recently updated',
  DELAYED: 'Delayed',
  STALE: 'Stale',
  UNAVAILABLE: 'Unavailable'
});

/**
 * Sanitizes a pollutant concentration so physically invalid negative or non-finite values
 * can never enter calculations or UI rendering.
 * @param {unknown} raw
 * @param {number} [decimals=1]
 * @returns {number | null}
 */
export function sanitizeConcentration(raw, decimals = 1) {
  if (raw === null || raw === undefined || raw === '') return null;
  const num = Number(raw);
  if (!Number.isFinite(num) || num < 0) return null;
  return Number(num.toFixed(decimals));
}

/**
 * Formats a strictly non-negative projected concentration paired with a separate signed change
 * against a reference baseline (prevents visually ambiguous "~18.6" or invalid negatives).
 * @param {number | null} projected
 * @param {number | null} reference
 * @param {string} [unit='µg/m³']
 */
export function formatProjectedAndDelta(projected, reference, unit = 'µg/m³') {
  const safeProj = sanitizeConcentration(projected, 1);
  const safeRef = sanitizeConcentration(reference, 1);

  if (safeProj === null) {
    return {
      projected: null,
      delta: null,
      projectedText: 'Unavailable',
      deltaText: 'Baseline comparison unavailable'
    };
  }

  const projectedText = `Projected: ${safeProj} ${unit}`;
  if (safeRef === null) {
    return { projected: safeProj, delta: null, projectedText, deltaText: 'Current reference unavailable' };
  }

  const delta = Number((safeProj - safeRef).toFixed(1));
  const sign = delta > 0 ? '+' : '';
  const direction = delta < 0 ? 'lower' : delta > 0 ? 'higher' : 'unchanged';
  return {
    projected: safeProj,
    delta,
    projectedText,
    deltaText: delta === 0
      ? 'Unchanged vs. current estimate'
      : `Change vs. current: ${sign}${delta} ${unit} (${direction})`
  };
}

/**
 * Evaluates data freshness from actual provider measurement/valid timestamp vs. retrieval time.
 * Never assumes API retrieval time equals observation/model valid time.
 *
 * Expected cadences:
 * - modeled (hourly CAMS/ECMWF valid hour): <= 90m Fresh, <= 3h Recent, <= 6h Delayed, > 6h Stale
 * - station (hourly CAAQMS): <= 75m Fresh, <= 2h Recent, <= 4h Delayed, > 4h Stale
 *
 * @param {string | null | undefined} measurementIso
 * @param {number} [nowMs=Date.now()]
 * @param {{ sourceType?: 'station' | 'modeled', isStaleFallback?: boolean }} [options]
 */
export function evaluateDataFreshness(measurementIso, nowMs = Date.now(), options = {}) {
  if (options.isStaleFallback) {
    return {
      state: FRESHNESS_STATES.STALE,
      ageMinutes: null,
      badgeTone: 'alert',
      label: 'Stale (Last Valid Cache)'
    };
  }

  if (!measurementIso || typeof measurementIso !== 'string') {
    return {
      state: FRESHNESS_STATES.UNAVAILABLE,
      ageMinutes: null,
      badgeTone: 'neutral',
      label: 'Timestamp unavailable'
    };
  }

  // Parse ISO timestamp; local-timezone Open-Meteo strings without offset default to local wall time
  const parsedMs = Date.parse(measurementIso);
  if (!Number.isFinite(parsedMs)) {
    return {
      state: FRESHNESS_STATES.UNAVAILABLE,
      ageMinutes: null,
      badgeTone: 'neutral',
      label: 'Unverified timestamp'
    };
  }

  const ageMinutes = Math.max(0, Math.round((nowMs - parsedMs) / 60_000));
  const isStation = options.sourceType === 'station';
  const freshLimit = isStation ? 75 : 95;
  const recentLimit = isStation ? 150 : 210;
  const delayedLimit = isStation ? 270 : 420;

  if (ageMinutes <= freshLimit) {
    return { state: FRESHNESS_STATES.FRESH, ageMinutes, badgeTone: 'teal', label: 'Fresh' };
  }
  if (ageMinutes <= recentLimit) {
    return { state: FRESHNESS_STATES.RECENT, ageMinutes, badgeTone: 'teal', label: 'Recently updated' };
  }
  if (ageMinutes <= delayedLimit) {
    return { state: FRESHNESS_STATES.DELAYED, ageMinutes, badgeTone: 'warn', label: 'Delayed' };
  }
  return { state: FRESHNESS_STATES.STALE, ageMinutes, badgeTone: 'alert', label: 'Stale' };
}

/**
 * Constructs a standardized EnvironmentalReading object.
 * @param {{
 *   pollutant: string,
 *   value: unknown,
 *   unit: string,
 *   source: string,
 *   sourceType: 'station' | 'modeled',
 *   location: { name: string, lat: number, lon: number },
 *   measurementTime: string | null,
 *   retrievalTime: string,
 *   averagingPeriod: string,
 *   spatialResolution: string,
 *   completenessPct?: number
 * }} input
 */
export function createEnvironmentalReading(input) {
  const safeValue = sanitizeConcentration(input.value, input.unit === 'mg/m³' ? 3 : 1);
  const qualityStatus = safeValue === null
    ? 'unavailable'
    : typeof input.completenessPct === 'number' && input.completenessPct < 75
      ? 'incomplete'
      : 'valid';

  return Object.freeze({
    pollutant: input.pollutant,
    value: safeValue,
    unit: input.unit,
    source: input.source,
    source_type: input.sourceType,
    location: Object.freeze({
      name: input.location.name,
      lat: input.location.lat,
      lon: input.location.lon
    }),
    measurement_time: input.measurementTime,
    retrieval_time: input.retrievalTime,
    averaging_period: input.averagingPeriod,
    spatial_resolution: input.spatialResolution,
    quality_status: qualityStatus
  });
}