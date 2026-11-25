/**
 * @fileoverview Per-instance sliding-window IP rate limiter for serverless endpoints.
 */

import { sanitizeText } from '../js/core/security.js';
import { GEMINI_LIMITS } from './geminiSchema.js';

/** @type {Map<string, number[]>} */
const ipRequestLog = new Map();

/**
 * Checks whether an IP address is within the sliding-window request budget.
 * @param {string} ip
 * @param {number} [now=Date.now()]
 * @returns {boolean}
 */
export function checkRateLimit(ip, now = Date.now()) {
  const key = sanitizeText(ip || 'unknown', 64) || 'unknown';
  const windowStart = now - GEMINI_LIMITS.RATE_LIMIT_WINDOW_MS;

  if (ipRequestLog.size >= GEMINI_LIMITS.MAX_TRACKED_IPS && !ipRequestLog.has(key)) {
    const oldestKey = ipRequestLog.keys().next().value;
    if (oldestKey) ipRequestLog.delete(oldestKey);
  }

  const recent = (ipRequestLog.get(key) || []).filter((ts) => ts > windowStart);
  if (recent.length >= GEMINI_LIMITS.RATE_LIMIT_MAX_REQUESTS) {
    ipRequestLog.set(key, recent);
    return false;
  }

  recent.push(now);
  ipRequestLog.set(key, recent);
  return true;
}

/**
 * Clears tracked IP rate-limit buckets (primarily for deterministic test isolation).
 * @returns {void}
 */
export function resetRateLimiter() {
  ipRequestLog.clear();
}