/**
 * @fileoverview VayuShield AI Coach Client Service Facade (Project ORACLE).
 * Proxies validated environmental context and session history to /api/gemini
 * with AbortSignal cancellation and transparent deterministic fallback.
 */

import { normalizeProfile } from '../core/impactModel.js';
import { sanitizeText } from '../core/security.js';
import {
  COACH_PROMPT_TEMPLATES,
  buildCoachContextPayload,
  classifyCoachIntent,
  createConversationSession
} from './aiContextBuilder.js';
import { buildGroundedFallback } from './aiGroundedEngine.js';

export {
  COACH_PROMPT_TEMPLATES,
  buildCoachContextPayload,
  buildGroundedFallback,
  classifyCoachIntent,
  createConversationSession
};

const CLIENT_TIMEOUT_MS = 18_000;

function createUserAbortError() {
  const err = new Error('Generation stopped by user.');
  err.name = 'UserAbortError';
  return err;
}

function attachAbortGuards(externalSignal) {
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) throw createUserAbortError();
    externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
    }
  };
}

/**
 * Queries POST /api/gemini with validated nested telemetry context, session history,
 * detected intent, and AbortSignal support; transparently falls back offline on failure.
 * @param {{ question?: string, intel: any, profile?: any, indoorEval?: any, history?: Array<any>, historySummary?: string }} params
 * @param {{ fetchImpl?: (...args: any[]) => Promise<any>, signal?: AbortSignal | null }} [options={}]
 * @returns {Promise<Record<string, any>>}
 */
export async function askVayuShieldCoach(params, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const externalSignal = options.signal || null;
  const profile = normalizeProfile(params.profile);
  const { intel, indoorEval } = params;
  const history = Array.isArray(params.history) ? params.history : [];
  const historySummary = typeof params.historySummary === 'string' ? params.historySummary : '';
  const question = sanitizeText(params.question, 500) || COACH_PROMPT_TEMPLATES[0].prompt;
  const intent = classifyCoachIntent(question, history.length);

  if (!intel || !intel.location) {
    return buildGroundedFallback(question, intel, profile, indoorEval, { diagnosticCode: 'NO_TELEMETRY', history });
  }

  const guard = attachAbortGuards(externalSignal);
  try {
    const context = buildCoachContextPayload(intel, profile, indoorEval);
    const response = await fetchImpl('/api/gemini', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: guard.signal,
      body: JSON.stringify({ question, intent, context, history, historySummary })
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || !payload.headline || !Array.isArray(payload.recommendations)) {
      return buildGroundedFallback(question, intel, profile, indoorEval, {
        diagnosticCode: payload?.diagnosticCode || `HTTP_${response.status}`,
        history
      });
    }

    const answer = payload.answer || payload.directAnswer || payload.indoorGuidance || '';
    return { ...payload, answer, directAnswer: payload.directAnswer || answer, isFallback: false, intent };
  } catch (err) {
    if (externalSignal?.aborted) throw createUserAbortError();
    return buildGroundedFallback(question, intel, profile, indoorEval, {
      diagnosticCode: err?.name === 'AbortError' ? 'CLIENT_TIMEOUT' : 'NETWORK_UNAVAILABLE',
      history
    });
  } finally {
    guard.cleanup();
  }
}