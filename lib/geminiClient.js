/**
 * @fileoverview Upstream Google Gemini REST v1beta transport, error classification,
 * generationConfig builder, and structured non-secret diagnostics.
 */

import { sanitizeText } from '../js/core/security.js';
import { COACH_RESPONSE_SCHEMA, GEMINI_LIMITS } from './geminiSchema.js';

/**
 * Classifies Gemini HTTP/API error responses into actionable diagnostic categories.
 * @param {number} status
 * @param {string} [apiStatus='']
 * @param {string} [apiMessage='']
 * @returns {{ httpStatus: number, code: string, message: string }}
 */
export function classifyUpstreamError(status, apiStatus = '', apiMessage = '') {
  const combined = `${apiStatus} ${apiMessage}`;
  if (status === 401 || status === 403 || /API_KEY_INVALID|PERMISSION_DENIED/i.test(combined)) {
    return { httpStatus: status === 401 ? 401 : 403, code: 'AUTH_OR_ACCESS_FAILURE', message: 'Gemini API authentication or project access failed.' };
  }
  if (status === 404 || /NOT_FOUND/i.test(combined)) {
    return { httpStatus: 404, code: 'MODEL_OR_ENDPOINT_NOT_FOUND', message: 'Configured Gemini model ID is unavailable for this API project or endpoint.' };
  }
  if (status === 429 || /RESOURCE_EXHAUSTED/i.test(combined)) {
    return { httpStatus: 429, code: 'QUOTA_OR_RATE_LIMIT_EXCEEDED', message: 'Gemini API quota or rate limit exceeded. Please retry shortly.' };
  }
  if (status === 400) {
    return { httpStatus: 400, code: 'UPSTREAM_INVALID_REQUEST', message: 'Gemini rejected the request format for the configured model.' };
  }
  if (status === 503) {
    return { httpStatus: 503, code: 'UPSTREAM_UNAVAILABLE', message: 'Gemini service is temporarily unavailable.' };
  }
  return { httpStatus: 502, code: `UPSTREAM_HTTP_${status}`, message: 'Upstream Gemini generation failed.' };
}

/**
 * Builds model-appropriate Gemini generationConfig with structured JSON output enforcement.
 * @param {string} modelId
 * @returns {Record<string, unknown>}
 */
export function buildGenerationConfig(modelId) {
  const genConfig = {
    maxOutputTokens: GEMINI_LIMITS.MAX_OUTPUT_TOKENS,
    responseMimeType: 'application/json',
    responseSchema: COACH_RESPONSE_SCHEMA
  };
  if (!/^gemini-3/i.test(modelId)) genConfig.temperature = 0.25;
  if (/^gemini-3\.8-flash/i.test(modelId)) genConfig.thinkingConfig = { thinkingLevel: 'low' };
  else if (/^gemini-3\.6-flash/i.test(modelId)) genConfig.thinkingConfig = { thinkingLevel: 'minimal' };
  else if (/^gemini-2\.5-flash/i.test(modelId)) genConfig.thinkingConfig = { thinkingBudget: 0 };
  return genConfig;
}

/**
 * Emits a structured server log entry strictly excluding credentials and private user text.
 * @param {Record<string, unknown>} record
 * @returns {void}
 */
export function logDiagnostic(record) {
  console.info(JSON.stringify({ service: 'vayushield-ai-coach', ...record }));
}

function extractTokenUsage(usage) {
  if (!usage) return null;
  return {
    promptTokens: usage.promptTokenCount ?? null,
    outputTokens: usage.candidatesTokenCount ?? null,
    totalTokens: usage.totalTokenCount ?? null
  };
}

async function parseGeminiHttpResponse(res) {
  const json = await res.json?.().catch(() => null);
  if (!res.ok) {
    return {
      ok: false,
      httpStatus: res.status,
      apiStatus: sanitizeText(json?.error?.status || '', 48),
      apiMessage: sanitizeText(json?.error?.message || '', 160)
    };
  }
  const candidate = json?.candidates?.[0];
  const finishReason = candidate?.finishReason || 'STOP';
  const text = candidate?.content?.parts?.map((p) => p?.text || '').join('') || '';
  if (!text) {
    return { ok: false, httpStatus: 502, apiStatus: finishReason, apiMessage: `Empty or blocked candidate (finishReason=${finishReason})` };
  }
  return { ok: true, text, finishReason, tokenUsage: extractTokenUsage(json?.usageMetadata) };
}

/**
 * Invokes Gemini REST v1beta :generateContent with timeout protection and header auth.
 * @param {{ fetchImpl: (...args: any[]) => Promise<any>, apiKey: string, modelId: string, bodyPayload: Record<string, unknown>, timeoutMs?: number }} params
 * @returns {Promise<{ ok: boolean, text?: string, finishReason?: string, tokenUsage?: Record<string, number | null> | null, httpStatus?: number, apiStatus?: string, apiMessage?: string }>}
 */
export async function invokeGeminiGenerate({
  fetchImpl,
  apiKey,
  modelId,
  bodyPayload,
  timeoutMs = GEMINI_LIMITS.UPSTREAM_TIMEOUT_MS
}) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      signal: controller.signal,
      body: JSON.stringify(bodyPayload)
    });
    return await parseGeminiHttpResponse(res);
  } catch (err) {
    const isTimeout = err?.name === 'AbortError';
    return {
      ok: false,
      httpStatus: isTimeout ? 504 : 502,
      apiStatus: isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR',
      apiMessage: isTimeout ? 'Upstream request timed out' : 'Network failure contacting Gemini API'
    };
  } finally {
    clearTimeout(timeoutId);
  }
}