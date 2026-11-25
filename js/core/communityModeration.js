/**
 * @fileoverview Privacy-preserving moderation and validation engine for the
 * Community Clean-Air Network. Blocks residential addresses, PII, spam URLs, and abuse.
 */

import { sanitizeText, validateEnum } from './security.js';

/** @type {ReadonlyArray<Readonly<{ id: string, label: string }>>} */
export const ACTION_CATEGORIES = Object.freeze([
  Object.freeze({ id: 'mobility', label: 'Shared Mobility & Carpool' }),
  Object.freeze({ id: 'zero-burning', label: 'Zero Waste / Leaf Burning' }),
  Object.freeze({ id: 'indoor-care', label: 'Community Clean-Air Spaces' }),
  Object.freeze({ id: 'dust-control', label: 'Dust Suppression & Wet Sweeping' }),
  Object.freeze({ id: 'clean-energy', label: 'Clean Cooking & Energy' })
]);

const MODERATION_RULES = Object.freeze([
  {
    test: (text) => /\b(flat|apt|apartment|door|house|plot|villa|floor)\s*(no\.?|number|#)?\s*[-:]?\s*\d+[a-z]?\b/i.test(text) || /\b[1-9][0-9]{5}\b/.test(text),
    reason: 'For your privacy, remove exact flat/house numbers or 6-digit PIN codes. Share only a general ward or locality name.'
  },
  {
    test: (text) => /(?:\+?\d[\d\s-]{8,14}\d)/.test(text) || /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text),
    reason: 'Personal contact details (phone numbers or email addresses) cannot be published on the community board.'
  },
  {
    test: (text) => /(https?:\/\/|www\.|\.[a-z]{2,}\/)/i.test(text),
    reason: 'External links are blocked to prevent spam on the community board.'
  },
  {
    test: (text) => /\b(scam|spam|crypto|casino|betting|idiot|stupid|hate|kill)\b/i.test(text),
    reason: 'Submission flagged by community safety filter. Please keep entries constructive and focused on clean air.'
  }
]);

function findModerationViolation(combinedText) {
  const hit = MODERATION_RULES.find((rule) => rule.test(combinedText));
  return hit ? hit.reason : null;
}

/**
 * Validates and moderates a community clean-air pledge before display or storage.
 * @param {{ area: unknown, category: unknown, action: unknown, consentAccepted: boolean }} input
 * @returns {{ approved: boolean, reason?: string, entry?: Record<string, any> }}
 */
export function moderateCommunitySubmission(input) {
  if (!input || input.consentAccepted !== true) {
    return { approved: false, reason: 'Please confirm public visibility consent before posting.' };
  }

  const area = sanitizeText(input.area, 48);
  const action = sanitizeText(input.action, 160);
  const category = validateEnum(input.category, ACTION_CATEGORIES.map((c) => c.id), 'mobility');

  if (area.length < 3) {
    return { approved: false, reason: 'Enter a general district, ward, or city area (at least 3 characters).' };
  }
  if (action.length < 12) {
    return { approved: false, reason: 'Describe a concrete clean-air action (at least 12 characters).' };
  }

  const violation = findModerationViolation(`${area} ${action}`);
  if (violation) return { approved: false, reason: violation };

  return {
    approved: true,
    entry: {
      id: `pl-${Date.now()}`,
      area,
      category,
      action,
      supporters: 1,
      status: 'active',
      createdAt: new Date().toISOString()
    }
  };
}

/**
 * Computes transparent community participation summary metrics.
 * @param {Array<{ category: string, supporters: number }>} pledges
 * @returns {{ totalPledges: number, totalSupporters: number, byCategory: Record<string, number> }}
 */
export function computeCommunityStats(pledges) {
  const list = Array.isArray(pledges) ? pledges : [];
  const totalSupporters = list.reduce((sum, p) => sum + (Number(p.supporters) || 0), 0);
  const byCategory = Object.fromEntries(ACTION_CATEGORIES.map((cat) => [cat.id, 0]));
  for (const p of list) {
    if (p.category in byCategory) byCategory[p.category] += 1;
  }
  return { totalPledges: list.length, totalSupporters, byCategory };
}