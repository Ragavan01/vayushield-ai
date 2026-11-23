/**
 * @fileoverview Privacy-preserving moderation and validation engine for the
 * Community Clean-Air Network. Prevents publishing precise residential addresses,
 * phone numbers, email addresses, external spam links, or abusive content.
 */

import { sanitizeText, validateEnum } from './security.js';

export const ACTION_CATEGORIES = Object.freeze([
  Object.freeze({ id: 'mobility', label: 'Shared Mobility & Carpool' }),
  Object.freeze({ id: 'zero-burning', label: 'Zero Waste / Leaf Burning' }),
  Object.freeze({ id: 'indoor-care', label: 'Community Clean-Air Spaces' }),
  Object.freeze({ id: 'dust-control', label: 'Dust Suppression & Wet Sweeping' }),
  Object.freeze({ id: 'clean-energy', label: 'Clean Cooking & Energy' })
]);

const URL_RE = /(https?:\/\/|www\.|\.[a-z]{2,}\/)/i;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_RE = /(?:\+?\d[\d\s-]{8,14}\d)/;
const PINCODE_RE = /\b[1-9][0-9]{5}\b/;
const PRECISE_ADDRESS_RE = /\b(flat|apt|apartment|door|house|plot|villa|floor)\s*(no\.?|number|#)?\s*[-:]?\s*\d+[a-z]?\b/i;
const BLOCKED_ABUSE_RE = /\b(scam|spam|crypto|casino|betting|idiot|stupid|hate|kill)\b/i;

/**
 * Validates and moderates a community clean-air pledge before display or storage.
 * @param {{ area: unknown, category: unknown, action: unknown, consentAccepted: boolean }} input
 */
export function moderateCommunitySubmission(input) {
  if (!input || input.consentAccepted !== true) {
    return {
      approved: false,
      reason: 'Please confirm public visibility consent before posting.'
    };
  }

  const area = sanitizeText(input.area, 48);
  const action = sanitizeText(input.action, 160);
  const categoryIds = ACTION_CATEGORIES.map((c) => c.id);
  const category = validateEnum(input.category, categoryIds, 'mobility');

  if (area.length < 3) {
    return { approved: false, reason: 'Enter a general district, ward, or city area (at least 3 characters).' };
  }
  if (action.length < 12) {
    return { approved: false, reason: 'Describe a concrete clean-air action (at least 12 characters).' };
  }

  const combined = `${area} ${action}`;
  if (PRECISE_ADDRESS_RE.test(combined) || PINCODE_RE.test(combined)) {
    return {
      approved: false,
      reason: 'For your privacy, remove exact flat/house numbers or 6-digit PIN codes. Share only a general ward or locality name.'
    };
  }
  if (PHONE_RE.test(combined) || EMAIL_RE.test(combined)) {
    return {
      approved: false,
      reason: 'Personal contact details (phone numbers or email addresses) cannot be published on the community board.'
    };
  }
  if (URL_RE.test(combined)) {
    return {
      approved: false,
      reason: 'External links are blocked to prevent spam on the community board.'
    };
  }
  if (BLOCKED_ABUSE_RE.test(combined)) {
    return {
      approved: false,
      reason: 'Submission flagged by community safety filter. Please keep entries constructive and focused on clean air.'
    };
  }

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
 */
export function computeCommunityStats(pledges) {
  const list = Array.isArray(pledges) ? pledges : [];
  const totalPledges = list.length;
  const totalSupporters = list.reduce((sum, p) => sum + (Number(p.supporters) || 0), 0);
  const byCategory = {};
  for (const cat of ACTION_CATEGORIES) {
    byCategory[cat.id] = 0;
  }
  for (const p of list) {
    if (p.category in byCategory) {
      byCategory[p.category] += 1;
    }
  }
  return { totalPledges, totalSupporters, byCategory };
}