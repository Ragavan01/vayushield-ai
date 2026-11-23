/**
 * @fileoverview Standardized environmental data integrity layer.
 * Enforces non-negative pollutant concentrations, canonical EnvironmentalReading objects,
 * and timezone-exact freshness via provider utc_offset_seconds (IST, GMT, EST, JST).
 */

export const FRESHNESS_STATES = Object.freeze({
  FRESH: 'Fresh',
  RECENT: 'Recently updated',
  DELAYED: 'Delayed',
  STALE: 'Stale',
  UNAVAILABLE: 'Unavailable'
});

export function sanitizeConcentration(raw, decimals = 1) {
  if (raw === null || raw === undefined || raw === '') return null;
  const num = Number(raw);
  if (!Number.isFinite(num) || num < 0) return null;
  return Number(num.toFixed(decimals));
}

export function parseLocationTimestampUtc(isoString, utcOffsetSeconds = null) {
  if (!isoString || typeof isoString !== 'string') return null;
  const trimmed = isoString.trim();

  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed)) {
    const ms = Date.parse(trimmed);
    return Number.isFinite(ms) ? ms : null;
  }

  const match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (match && typeof utcOffsetSeconds === 'number' && Number.isFinite(utcOffsetSeconds)) {
    const [, y, m, d, hh, mm, ss] = match;
    const wallUtcMs = Date.UTC(
      Number(y),
      Number(m) - 1,
      Number(d),
      Number(hh),
      Number(mm),
      Number(ss || 0)
    );
    return wallUtcMs - utcOffsetSeconds * 1000;
  }

  const fallbackMs = Date.parse(trimmed);
  return Number.isFinite(fallbackMs) ? fallbackMs : null;
}

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

export function evaluateDataFreshness(measurementIso, nowMs = Date.now(), options = {}) {
  if (options.isStaleFallback) {
    return {
      state: FRESHNESS_STATES.STALE,
      ageMinutes: null,
      badgeTone: 'alert',
      label: 'Stale (Last Valid Cache)'
    };
  }

  const parsedMs = parseLocationTimestampUtc(measurementIso, options.utcOffsetSeconds);
  if (parsedMs === null) {
    return {
      state: FRESHNESS_STATES.UNAVAILABLE,
      ageMinutes: null,
      badgeTone: 'neutral',
      label: 'Timestamp unavailable'
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

export function createEnvironmentalReading(input) {
  const safeValue = sanitizeConcentration(input.value, input.unit === 'mg/m³' ? 3 : 1);
  const qualityStatus = safeValue === null
    ? 'unavailable'
    : typeof input.completenessPct === 'number' && input.completenessPct < 67
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