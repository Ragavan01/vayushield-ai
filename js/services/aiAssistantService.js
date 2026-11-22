/**
 * @fileoverview Frontend GenAI Smog Coach client coordinating `/api/gemini`
 * with a rich, context-grounded deterministic fallback engine.
 */

import { classifyAqi } from '../core/aqiEngine.js';
import {
  calculateChoiceImpact,
  generateDailyRoutine,
  generateIndoorHacks,
  normalizeProfile
} from '../core/recommendationEngine.js';
import { isPlausibleApiKey, sanitizeText } from '../core/security.js';

const CLIENT_TIMEOUT_MS = 13_000;

export const COACH_PROMPT_TEMPLATES = Object.freeze([
  Object.freeze({
    id: 'morning-school',
    label: 'School Run & Kids Safety',
    prompt: 'How do I protect my kids during the 7:30 AM winter smog school commute and evening play?'
  }),
  Object.freeze({
    id: 'budget-bedroom',
    label: 'Clean Bedroom Under ₹2,500',
    prompt: 'We cannot buy an expensive purifier—what is the highest-impact indoor air setup under ₹2,500?'
  }),
  Object.freeze({
    id: 'commute-swap',
    label: 'Low-Emission Commute Plan',
    prompt: 'How much PM2.5 exposure and CO2 do I actually save by changing my daily commute and errand timing?'
  }),
  Object.freeze({
    id: 'community-rwa',
    label: 'Apartment / RWA Smog Action',
    prompt: 'What 3 actions can our residential apartment community take together this winter to cut local smog?'
  })
]);

/**
 * Generates a deeply tailored, science-grounded fallback coaching plan when no live API key is configured.
 * @param {string} question
 * @param {{ name: string, aqi: number, pm25: number }} airData
 * @param {any} rawProfile
 * @param {string[]} selectedSwapIds
 */
export function buildFallbackCoachingResponse(question, airData, rawProfile, selectedSwapIds = []) {
  const cleanQuestion = sanitizeText(question, 300);
  const profile = normalizeProfile(rawProfile);
  const band = classifyAqi(airData.aqi);
  const routine = generateDailyRoutine(airData, profile);
  const hacks = generateIndoorHacks(airData, profile);
  const impact = calculateChoiceImpact(
    selectedSwapIds.length ? selectedSwapIds : ['transit-carpool', 'hepa-sealed-sleep', 'induction-cooking'],
    airData.pm25
  );

  const qLower = cleanQuestion.toLowerCase();
  const topHack = hacks[0];

  let headline = `${airData.name} (${band.label}, AQI ${airData.aqi}): Personalized Family Smog Plan`;
  if (qLower.includes('kid') || qLower.includes('school')) {
    headline = `Child-Safe Smog Protocol for ${airData.name} (AQI ${airData.aqi})`;
  } else if (qLower.includes('2,500') || qLower.includes('budget') || qLower.includes('diy')) {
    headline = `High-Impact Clean Room Setup Under ₹2,500 for ${profile.roomSqFt} sq.ft`;
  } else if (qLower.includes('community') || qLower.includes('rwa') || qLower.includes('apartment')) {
    headline = `Neighborhood Anti-Smog Action Blueprint for ${airData.name}`;
  }

  return {
    engine: 'VayuShield Grounded Intelligence (Smart Fallback)',
    headline,
    immediateSteps: [
      `${routine[0].phase} (${routine[0].slot}): ${routine[0].action}`,
      `${routine[1].phase}: ${routine[1].action}`,
      `${routine[2].phase} (${routine[2].slot}): ${routine[2].action}`
    ],
    indoorHack: `${topHack.title} — ${topHack.howTo} (${topHack.impactExplanation})`,
    sustainableSwap: 'Batch local errands into the 1:30–4:00 PM thermal mixing dip and shift 3 weekly commute trips to transit/carpool + electric simmering indoors.',
    directImpact: `Combining these habits cuts your personal PM2.5 exposure by ~${impact.totalExposureReductionPct}% (${impact.baselinePm25} → ${impact.projectedPm25} µg/m³, avoiding ~${impact.cigarettesAvoidedPerDay} passive cigarettes/day), saves ${impact.co2SavedKgPerMonth} kg CO₂/month, and scales to ${impact.community1000FamiliesCo2TonsPerYear} metric tons CO₂/year if 1,000 neighborhood families join.`,
    communityTip: 'Propose a Zero Winter Leaf-Burning rule, damp morning courtyard sweeping, and a shared school-run carpool group in your apartment or street WhatsApp group.'
  };
}

/**
 * Calls the secure `/api/gemini` serverless proxy with optional session-scoped key header,
 * automatically falling back to the local grounded engine if offline or unconfigured.
 * @param {{ question: string, airData: { name: string, aqi: number, pm25: number }, profile: any, selectedSwapIds?: string[], sessionApiKey?: string }} params
 * @param {{ fetchImpl?: typeof fetch }} [options]
 */
export async function askAirQualityAssistant(params, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const profile = normalizeProfile(params.profile);
  const question = sanitizeText(params.question, 360) || COACH_PROMPT_TEMPLATES[0].prompt;

  const headers = { 'Content-Type': 'application/json' };
  if (isPlausibleApiKey(params.sessionApiKey)) {
    headers['x-gemini-api-key'] = params.sessionApiKey.trim();
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);

  try {
    const response = await fetchImpl('/api/gemini', {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        question,
        city: params.airData.name,
        aqi: params.airData.aqi,
        pm25: params.airData.pm25,
        commuteMode: profile.commuteMode,
        householdProfile: profile.householdProfile,
        budgetTier: profile.budgetTier,
        cookingFuel: profile.cookingFuel,
        roomSqFt: profile.roomSqFt
      })
    });

    if (!response.ok) {
      throw new Error(`Proxy HTTP ${response.status}`);
    }

    const payload = await response.json();
    if (!payload || !payload.headline || !Array.isArray(payload.immediateSteps)) {
      throw new Error('Malformed assistant payload');
    }

    return payload;
  } catch {
    return buildFallbackCoachingResponse(question, params.airData, profile, params.selectedSwapIds);
  } finally {
    clearTimeout(timer);
  }
}