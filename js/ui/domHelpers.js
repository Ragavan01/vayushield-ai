/**
 * @fileoverview Shared storage persistence, CSP-safe SVG creation, formatting,
 * toast notifications, and loading/error state helpers for VayuShield UI modules.
 */

import { createSafeElement, sanitizeText } from '../core/security.js';

/** @type {Readonly<Record<string, string>>} */
export const STORAGE_KEYS = Object.freeze({
  LOCATION: 'vayushield_location_v3',
  PROFILE: 'vayushield_profile_v2',
  SCENARIOS: 'vayushield_scenarios_v2',
  PLEDGES: 'vayushield_pledges_v2'
});

/** @type {number} */
export const REFERENCE_DESIGN_PM25 = 120;

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Safely parses JSON from localStorage with graceful fallback.
 * @template T
 * @param {string} key
 * @param {T} fallback
 * @returns {T}
 */
export function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (_storageErr) {
    return fallback;
  }
}

/**
 * Persists a JSON-serializable value to localStorage, ignoring restricted-storage errors.
 * @param {string} key
 * @param {unknown} value
 * @returns {void}
 */
export function saveJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (_storageErr) {
    // Gracefully ignore restricted storage contexts
  }
}

/**
 * Creates a CSP-safe SVG element, stripping inline event handlers and style attributes.
 * @param {string} tag
 * @param {Record<string, string | number>} [attrs={}]
 * @returns {SVGElement}
 */
export function createSvg(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    const lower = k.toLowerCase();
    if (lower.startsWith('on') || lower === 'style') continue;
    el.setAttribute(k, String(v));
  }
  return el;
}

/**
 * Displays a transient polite-region toast message.
 * @param {string} message
 * @returns {void}
 */
export function showToast(message) {
  const region = document.getElementById('toast-region');
  if (!region) return;
  const toast = createSafeElement(document, 'div', {
    className: 'toast',
    text: sanitizeText(message, 160)
  });
  region.appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
}

/**
 * Formats a latitude or longitude coordinate with directional suffix.
 * @param {number} val
 * @param {string} pos
 * @param {string} neg
 * @returns {string}
 */
export function formatCoord(val, pos, neg) {
  const num = Number(val);
  if (!Number.isFinite(num)) return '—';
  return `${Math.abs(num).toFixed(4)}° ${num >= 0 ? pos : neg}`;
}

/**
 * Formats an ISO-like local timestamp for UI badges.
 * @param {string | null | undefined} iso
 * @returns {string}
 */
export function formatLocalTimestamp(iso) {
  if (!iso || typeof iso !== 'string') return 'Unknown time';
  return iso.replace('T', ' ');
}

/**
 * Toggles loading styling on primary telemetry cards.
 * @param {boolean} isLoading
 * @returns {void}
 */
export function setLoadingState(isLoading) {
  document.getElementById('telemetry-card')?.classList.toggle('is-loading', isLoading);
  document.getElementById('dispersion-module')?.classList.toggle('is-loading', isLoading);
  const freshness = document.getElementById('freshness-badge');
  if (isLoading && freshness) {
    freshness.textContent = 'Updating…';
    freshness.className = 'badge badge-neutral';
  }
}

/**
 * Reveals the accessible alert banner with sanitized error messaging.
 * @param {string} title
 * @param {string} detail
 * @returns {void}
 */
export function showErrorBanner(title, detail) {
  const banner = document.getElementById('error-banner');
  document.getElementById('error-title').textContent = sanitizeText(title, 120);
  document.getElementById('error-detail').textContent = sanitizeText(detail, 260);
  banner.hidden = false;
}

/**
 * Hides the accessible alert banner.
 * @returns {void}
 */
export function hideErrorBanner() {
  document.getElementById('error-banner').hidden = true;
}

/**
 * Resolves live outdoor PM2.5 or flags a standard design reference scenario when telemetry is missing.
 * @param {Record<string, any> | null} intel
 * @returns {{ value: number, isReferenceFallback: boolean }}
 */
export function getOutdoorPm25WithProvenance(intel) {
  const live = intel?.rollingAverages?.pm25_24h ?? intel?.current?.pm25 ?? null;
  if (typeof live === 'number' && Number.isFinite(live) && live >= 0) {
    return { value: live, isReferenceFallback: false };
  }
  return { value: REFERENCE_DESIGN_PM25, isReferenceFallback: true };
}

/**
 * Returns a typed input/select/textarea element by ID for checkJs type safety.
 * @param {string} id
 * @returns {HTMLInputElement}
 */
export function getField(id) {
  return /** @type {HTMLInputElement} */ (document.getElementById(id));
}

/**
 * Returns a typed button element by ID for checkJs type safety.
 * @param {string} id
 * @returns {HTMLButtonElement}
 */
export function getButton(id) {
  return /** @type {HTMLButtonElement} */ (document.getElementById(id));
}

/**
 * Returns a typed form element by ID for checkJs type safety.
 * @param {string} id
 * @returns {HTMLFormElement}
 */
export function getForm(id) {
  return /** @type {HTMLFormElement} */ (document.getElementById(id));
}