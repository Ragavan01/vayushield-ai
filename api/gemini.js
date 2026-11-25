/**
 * @fileoverview VayuShield AI Coach — Project ORACLE Production Serverless Proxy (Vercel).
 * Orchestrates request validation, rate limiting, smoke-test health checks, and
 * structured multi-turn Gemini generation via modular lib/ utilities.
 */

import crypto from 'node:crypto';
import { sanitizeText } from '../js/core/security.js';
import {
  DEFAULT_GEMINI_MODEL_ID,
  GEMINI_LIMITS,
  SMOKE_TEST_SCHEMA,
  SYSTEM_INSTRUCTION,
  SYSTEM_INSTRUCTION_VERSION
} from '../lib/geminiSchema.js';
import { checkRateLimit, resetRateLimiter } from '../lib/rateLimiter.js';
import {
  buildScientificPrompt,
  normalizeModelId,
  parseNullableMetric,
  parseStructuredCoachResponse,
  resolveModelConfig,
  sanitizeConversationHistory,
  validateEnvironmentalContext
} from '../lib/geminiParser.js';
import {
  buildGenerationConfig,
  classifyUpstreamError,
  invokeGeminiGenerate,
  logDiagnostic
} from '../lib/geminiClient.js';

export {
  DEFAULT_GEMINI_MODEL_ID,
  SYSTEM_INSTRUCTION_VERSION,
  buildScientificPrompt,
  checkRateLimit,
  normalizeModelId,
  parseNullableMetric,
  parseStructuredCoachResponse,
  resetRateLimiter,
  resolveModelConfig,
  sanitizeConversationHistory,
  validateEnvironmentalContext
};

function parseRequestBody(rawBody) {
  if (!rawBody) return null;
  if (typeof rawBody === 'object' && !Array.isArray(rawBody)) return rawBody;
  if (typeof rawBody !== 'string') return null;
  try {
    const parsed = JSON.parse(rawBody);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_jsonErr) {
    return null;
  }
}

function validatePreconditions(req, env, now, requestId) {
  if (req.method !== 'POST') {
    return { status: 405, payload: { error: 'Method not allowed. Use POST.', requestId } };
  }

  const contentType = String(req.headers?.['content-type'] || '');
  if (contentType && !contentType.toLowerCase().includes('application/json')) {
    return { status: 400, payload: { error: 'Content-Type must be application/json.', diagnosticCode: 'INVALID_CONTENT_TYPE', requestId } };
  }

  const clientIp = String(req.headers?.['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  if (!checkRateLimit(clientIp, now())) {
    logDiagnostic({ requestId, status: 'rate_limited', httpStatus: 429, fallbackActivated: true });
    return { status: 429, payload: { error: 'Rate limit exceeded. Please wait 60 seconds.', diagnosticCode: 'RATE_LIMITED', requestId, fallbackRecommended: true } };
  }

  const body = parseRequestBody(req.body);
  if (!body) {
    return { status: 400, payload: { error: 'Invalid JSON request body.', diagnosticCode: 'BAD_REQUEST', requestId } };
  }
  if (JSON.stringify(body).length > GEMINI_LIMITS.MAX_BODY_BYTES) {
    return { status: 413, payload: { error: 'Payload exceeds maximum allowed size.', diagnosticCode: 'PAYLOAD_TOO_LARGE', requestId } };
  }

  const config = resolveModelConfig(env);
  if (!config.apiKey) {
    logDiagnostic({ requestId, status: 'unconfigured', errorCategory: 'MISSING_GEMINI_API_KEY', fallbackActivated: true });
    return { status: 503, payload: { error: 'Server-side GEMINI_API_KEY is not configured.', diagnosticCode: 'MISSING_GEMINI_API_KEY', requestId, fallbackRecommended: true } };
  }
  if (!config.primaryValid) {
    logDiagnostic({ requestId, status: 'config_error', errorCategory: 'INVALID_GEMINI_MODEL_ID', fallbackActivated: true });
    return { status: 500, payload: { error: 'Server-side GEMINI_MODEL_ID configuration is invalid.', diagnosticCode: 'INVALID_GEMINI_MODEL_ID', requestId, fallbackRecommended: true } };
  }

  return { ok: true, body, config };
}

async function handleSmokeTest({ fetchImpl, config, requestId, startedAt, now, res }) {
  const smokePayload = {
    contents: [{
      role: 'user',
      parts: [{ text: 'Return a valid JSON object containing status: connected and message: VayuShield AI Coach is operational.' }]
    }],
    generationConfig: {
      maxOutputTokens: GEMINI_LIMITS.SMOKE_MAX_OUTPUT_TOKENS,
      responseMimeType: 'application/json',
      responseSchema: SMOKE_TEST_SCHEMA
    }
  };

  const smokeRes = await invokeGeminiGenerate({
    fetchImpl,
    apiKey: config.apiKey,
    modelId: config.primaryModel,
    bodyPayload: smokePayload,
    timeoutMs: GEMINI_LIMITS.SMOKE_TIMEOUT_MS
  });

  const latencyMs = Math.max(0, now() - startedAt);
  if (!smokeRes.ok) {
    const classified = classifyUpstreamError(smokeRes.httpStatus, smokeRes.apiStatus, smokeRes.apiMessage);
    logDiagnostic({ requestId, mode: 'smoke_test', modelId: config.primaryModel, latencyMs, errorCategory: classified.code });
    return res.status(classified.httpStatus).json({
      ok: false, provider: 'google-gemini', model: config.primaryModel, diagnosticCode: classified.code, error: classified.message, latencyMs, requestId
    });
  }

  try {
    const parsed = JSON.parse(smokeRes.text.replace(/```json/gi, '').replace(/```/g, '').trim());
    logDiagnostic({ requestId, mode: 'smoke_test', modelId: config.primaryModel, latencyMs, status: 'connected', tokenUsage: smokeRes.tokenUsage });
    return res.status(200).json({
      ok: true,
      status: sanitizeText(parsed.status, 32) || 'connected',
      message: sanitizeText(parsed.message, 120) || 'VayuShield AI Coach is operational.',
      provider: 'google-gemini',
      model: config.primaryModel,
      latencyMs,
      tokenUsage: smokeRes.tokenUsage,
      requestId
    });
  } catch (_parseErr) {
    return res.status(502).json({
      ok: false, provider: 'google-gemini', model: config.primaryModel, diagnosticCode: 'SMOKE_PARSE_ERROR', error: 'Smoke test returned non-JSON output.', latencyMs, requestId
    });
  }
}

function buildConversationContents(body, requestId) {
  const rawQuestion = typeof body.question === 'string' ? body.question : '';
  if (rawQuestion.length > GEMINI_LIMITS.MAX_QUESTION_CHARS) {
    return { status: 400, payload: { error: `Question exceeds ${GEMINI_LIMITS.MAX_QUESTION_CHARS} characters.`, diagnosticCode: 'QUESTION_TOO_LONG', requestId } };
  }

  const question = sanitizeText(rawQuestion, GEMINI_LIMITS.MAX_QUESTION_CHARS);
  if (!question) {
    return { status: 400, payload: { error: 'A non-empty question is required.', diagnosticCode: 'EMPTY_QUESTION', requestId } };
  }

  const historyResult = sanitizeConversationHistory(body.history, body.historySummary);
  if (!historyResult.valid) {
    return { status: 400, payload: { error: 'Conversation history must be an array.', diagnosticCode: 'INVALID_HISTORY', requestId } };
  }

  const validatedContext = validateEnvironmentalContext(body);
  const contextText = buildScientificPrompt(validatedContext);
  const contents = [
    ...historyResult.turns,
    {
      role: 'user',
      parts: [{ text: `${contextText}\n\n[DETECTED_INTENT]: ${validatedContext.intent}\n[USER_QUESTION]\n${question}\n[/USER_QUESTION]` }]
    }
  ];
  return { ok: true, contents };
}

async function attemptSingleModel({ fetchImpl, apiKey, modelId, contents }) {
  const genConfig = buildGenerationConfig(modelId);
  const payload = {
    systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
    contents,
    generationConfig: genConfig
  };

  let result = await invokeGeminiGenerate({ fetchImpl, apiKey, modelId, bodyPayload: payload });
  if (!result.ok && result.httpStatus === 400 && genConfig.thinkingConfig) {
    const retryConfig = { ...genConfig };
    delete retryConfig.thinkingConfig;
    result = await invokeGeminiGenerate({
      fetchImpl,
      apiKey,
      modelId,
      bodyPayload: { ...payload, generationConfig: retryConfig }
    });
  }
  return result;
}

async function executeModelCascade({ fetchImpl, config, contents, requestId, startedAt, now }) {
  const modelsToTry = config.fallbackModel ? [config.primaryModel, config.fallbackModel] : [config.primaryModel];
  let primaryFailure = null;

  for (let i = 0; i < modelsToTry.length; i++) {
    const modelId = modelsToTry[i];
    const result = await attemptSingleModel({ fetchImpl, apiKey: config.apiKey, modelId, contents });

    if (result.ok) {
      try {
        const structured = parseStructuredCoachResponse(result.text);
        const latencyMs = Math.max(0, now() - startedAt);
        logDiagnostic({ requestId, modelId, providerStatus: 'ok', latencyMs, tokenUsage: result.tokenUsage, fallbackActivated: i > 0, completionStatus: result.finishReason });
        return {
          status: 200,
          payload: {
            provider: 'google-gemini', model: modelId, engine: `Gemini Connected · ${modelId}`, mode: 'live-ai',
            isFallback: false, status: 'connected', requestId, latencyMs, tokenUsage: result.tokenUsage, ...structured
          }
        };
      } catch (_parseErr) {
        if (!primaryFailure) {
          primaryFailure = { modelId, httpStatus: 502, code: 'MALFORMED_MODEL_JSON', message: 'Gemini returned malformed or incomplete structured output.' };
        }
        continue;
      }
    }

    const classified = classifyUpstreamError(result.httpStatus, result.apiStatus, result.apiMessage);
    if (!primaryFailure) primaryFailure = { modelId, ...classified };
    if (classified.httpStatus === 401 || classified.httpStatus === 403 || classified.httpStatus === 400) break;
  }

  const latencyMs = Math.max(0, now() - startedAt);
  const finalError = primaryFailure || { modelId: config.primaryModel, httpStatus: 502, code: 'UPSTREAM_GENERATION_FAILED', message: 'Gemini generation failed.' };
  logDiagnostic({ requestId, modelId: finalError.modelId, providerStatus: 'error', httpStatus: finalError.httpStatus, latencyMs, errorCategory: finalError.code, fallbackActivated: true, completionStatus: 'failed' });
  return {
    status: finalError.httpStatus,
    payload: { provider: 'google-gemini', model: finalError.modelId, error: finalError.message, diagnosticCode: finalError.code, requestId, latencyMs, fallbackRecommended: true }
  };
}

/**
 * Factory creating the Vercel serverless HTTP handler with injectable dependencies for testing.
 * @param {{ fetchImpl?: (...args: any[]) => Promise<any>, env?: Record<string, string | undefined>, now?: () => number }} [deps={}]
 * @returns {(req: any, res: any) => Promise<any>}
 */
export function createGeminiHandler(deps = {}) {
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const env = deps.env || process.env;
  const now = deps.now || (() => Date.now());

  return async function handler(req, res) {
    const startedAt = now();
    const requestId = crypto.randomUUID ? crypto.randomUUID().slice(0, 12) : String(startedAt);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Request-Id', requestId);

    const check = validatePreconditions(req, env, now, requestId);
    if (!check.ok) return res.status(check.status).json(check.payload);

    if (check.body.action === 'smoke_test') {
      return handleSmokeTest({ fetchImpl, config: check.config, requestId, startedAt, now, res });
    }

    const conv = buildConversationContents(check.body, requestId);
    if (!conv.ok) return res.status(conv.status).json(conv.payload);

    const outcome = await executeModelCascade({ fetchImpl, config: check.config, contents: conv.contents, requestId, startedAt, now });
    return res.status(outcome.status).json(outcome.payload);
  };
}

export default createGeminiHandler();