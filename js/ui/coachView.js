/**
 * @fileoverview Project ORACLE Conversational AI Coach UI controller & renderer:
 * dynamic status/model badges, prompt chips, structured fact/recommendation cards,
 * clipboard export, and AbortController cancellation.
 */

import { clearNode, createSafeElement, sanitizeText } from '../core/security.js';
import { askVayuShieldCoach, COACH_PROMPT_TEMPLATES } from '../services/aiAssistantService.js';
import { getButton, getField, showToast } from './domHelpers.js';

const COACH_LOADING_PHASES = Object.freeze([
  'Analyzing environmental context…',
  'Interpreting atmospheric conditions…',
  'Preparing household recommendations…'
]);

/**
 * Updates AI Coach connection status, active model label, and live city context badge.
 * @param {Record<string, any>} state
 * @param {{ statusText?: string, statusTone?: string, modelText?: string | null }} info
 * @returns {void}
 */
export function updateCoachHeaderStatus(state, { statusText, statusTone = 'teal', modelText = null }) {
  const statusEl = document.getElementById('coach-status-badge');
  const modelEl = document.getElementById('coach-model-badge');
  const ctxEl = document.getElementById('coach-context-badge');

  if (statusEl && statusText) {
    statusEl.textContent = statusText;
    statusEl.className = `badge badge-${statusTone}`;
  }
  if (modelEl && modelText) modelEl.textContent = modelText;
  if (ctxEl) {
    const city = state.intel?.location?.name || state.location.name;
    const aqi = state.intel?.cpcb?.aqi;
    ctxEl.textContent = aqi !== null && aqi !== undefined
      ? `Context: ${city} (Est. AQI ${aqi} · Modeled)`
      : `Context: ${city} (Telemetry Pending)`;
  }
}

/**
 * Renders the 8 suggested environmental prompt template chips.
 * @param {Record<string, any>} state
 * @returns {void}
 */
export function renderCoachTemplates(state) {
  const row = document.getElementById('coach-templates');
  clearNode(row);
  for (const tpl of COACH_PROMPT_TEMPLATES) {
    const btn = createSafeElement(document, 'button', {
      className: 'chip-btn',
      text: tpl.label,
      attrs: { type: 'button' }
    });
    btn.addEventListener('click', () => handleCoachSubmit(state, tpl.prompt));
    row.appendChild(btn);
  }
}

function formatCoachAnswerText(res) {
  return [res.headline, res.answer || res.directAnswer || '', res.indoorGuidance ? `\nIndoor Guidance: ${res.indoorGuidance}` : '']
    .filter(Boolean).join('\n');
}

function formatCoachRecsText(res, locationName) {
  const recs = Array.isArray(res.recommendations) ? res.recommendations : [];
  if (!recs.length) return formatCoachAnswerText(res);
  return [
    `${res.headline} — Recommendations (${locationName})`,
    ...recs.map((r, i) => `${i + 1}. [${String(r.priority || 'medium').toUpperCase()}] ${r.title} (${r.timeWindow || 'Today'}): ${r.description}${r.reason ? ` — ${r.reason}` : ''}`)
  ].join('\n');
}

function buildFactsRow(factsUsed) {
  const pills = factsUsed.map((f) => {
    const valText = typeof f === 'string'
      ? f
      : `${f.label}: ${f.value === null ? 'Unavailable' : `${f.value}${f.unit ? ` ${f.unit}` : ''}`}`;
    const srcTag = typeof f === 'object' && f.sourceType ? ` · ${f.sourceType}` : '';
    return createSafeElement(document, 'span', {
      className: 'fact-pill',
      attrs: { title: typeof f === 'object' && f.timestamp ? `Timestamp: ${f.timestamp}` : '' },
      children: [createSafeElement(document, 'strong', { text: valText }), createSafeElement(document, 'span', { text: srcTag })]
    });
  });
  return createSafeElement(document, 'div', { className: 'coach-facts-row', children: pills });
}

function buildRecommendationsSection(recommendations) {
  const items = recommendations.map((rec, idx) => {
    const isObj = rec && typeof rec === 'object';
    const title = isObj ? rec.title : `Step ${idx + 1}`;
    const desc = isObj ? rec.description : String(rec);
    const reason = isObj && rec.reason ? rec.reason : '';
    const priority = isObj ? rec.priority : 'medium';
    const timeWin = isObj && rec.timeWindow && rec.timeWindow !== 'Unavailable' ? rec.timeWindow : '';
    const tone = priority === 'high' ? 'alert' : priority === 'low' ? 'good' : 'warn';

    return createSafeElement(document, 'li', {
      className: 'coach-rec-item',
      children: [
        createSafeElement(document, 'div', {
          className: 'coach-rec-head',
          children: [
            createSafeElement(document, 'span', { className: 'coach-rec-title', text: `${idx + 1}. ${title}` }),
            createSafeElement(document, 'div', {
              className: 'action-group',
              children: [
                ...(timeWin ? [createSafeElement(document, 'span', { className: 'mono-meta', text: timeWin })] : []),
                createSafeElement(document, 'span', { className: `badge badge-${tone}`, text: priority })
              ]
            })
          ]
        }),
        createSafeElement(document, 'p', { className: 'routine-action', text: desc }),
        ...(reason ? [createSafeElement(document, 'p', { className: 'muted-text', text: reason })] : [])
      ]
    });
  });

  return createSafeElement(document, 'div', {
    children: [
      createSafeElement(document, 'h4', { className: 'coach-section-title', text: 'Recommendations' }),
      createSafeElement(document, 'ol', { className: 'coach-rec-list', children: items })
    ]
  });
}

async function copyTextWithToast(text, successMsg) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(successMsg);
  } catch (_clipErr) {
    showToast('Clipboard access unavailable in this browser.');
  }
}

function buildCoachFooter(state, turn, res) {
  const copyAnswerBtn = createSafeElement(document, 'button', { className: 'btn btn-ghost btn-sm', text: 'Copy Answer', attrs: { type: 'button' } });
  copyAnswerBtn.addEventListener('click', () => copyTextWithToast(formatCoachAnswerText(res), 'Copied AI Coach answer.'));

  const copyRecsBtn = createSafeElement(document, 'button', { className: 'btn btn-ghost btn-sm', text: 'Copy Steps', attrs: { type: 'button' } });
  copyRecsBtn.addEventListener('click', () => copyTextWithToast(formatCoachRecsText(res, state.location.name), 'Copied recommendations.'));

  const retryBtn = createSafeElement(document, 'button', { className: 'btn btn-ghost btn-sm', text: 'Retry', attrs: { type: 'button' } });
  retryBtn.addEventListener('click', () => handleCoachSubmit(state, turn.question));

  const badgeLabel = res.isFallback
    ? `${res.engine}${res.diagnosticCode ? ` (${res.diagnosticCode})` : ''}`
    : `${res.engine}${typeof res.latencyMs === 'number' ? ` · ${res.latencyMs} ms` : ''}`;

  return createSafeElement(document, 'div', {
    className: 'coach-card-footer',
    children: [
      createSafeElement(document, 'span', { className: `badge ${res.isFallback ? 'badge-warn' : 'badge-teal'}`, text: badgeLabel }),
      createSafeElement(document, 'div', { className: 'action-group', children: [copyAnswerBtn, copyRecsBtn, retryBtn] })
    ]
  });
}

function buildCoachResponseCard(state, turn) {
  const res = turn.response;
  const children = [
    createSafeElement(document, 'h3', { className: 'panel-title', text: res.headline }),
    createSafeElement(document, 'p', { className: 'coach-answer', text: res.answer || res.directAnswer || '' })
  ];

  if (Array.isArray(res.factsUsed) && res.factsUsed.length > 0) children.push(buildFactsRow(res.factsUsed));
  if (Array.isArray(res.recommendations) && res.recommendations.length > 0) children.push(buildRecommendationsSection(res.recommendations));
  if (res.indoorGuidance) {
    children.push(createSafeElement(document, 'div', {
      children: [
        createSafeElement(document, 'h4', { className: 'coach-section-title', text: 'Indoor Air Guidance' }),
        createSafeElement(document, 'p', { className: 'muted-text', text: res.indoorGuidance })
      ]
    }));
  }
  if (Array.isArray(res.assumptionsAndLimits) && res.assumptionsAndLimits.length > 0) {
    children.push(createSafeElement(document, 'p', { className: 'mono-meta', text: res.assumptionsAndLimits.join(' · ') }));
  }
  if (Array.isArray(res.followUpSuggestions) && res.followUpSuggestions.length > 0) {
    const chips = res.followUpSuggestions.map((qText) => {
      const chip = createSafeElement(document, 'button', { className: 'chip-btn', text: qText, attrs: { type: 'button' } });
      chip.addEventListener('click', () => handleCoachSubmit(state, qText));
      return chip;
    });
    children.push(createSafeElement(document, 'div', { className: 'coach-followups', children: chips }));
  }

  children.push(buildCoachFooter(state, turn, res));
  return createSafeElement(document, 'article', { className: 'coach-card', children });
}

/**
 * Renders the multi-turn VayuShield AI Coach conversation thread.
 * @param {Record<string, any>} state
 * @returns {void}
 */
export function renderCoachThread(state) {
  const out = document.getElementById('coach-output');
  clearNode(out);

  if (state.coachHistory.length === 0) {
    out.appendChild(createSafeElement(document, 'div', {
      className: 'coach-welcome',
      children: [
        createSafeElement(document, 'strong', { className: 'subhead', text: `Ready to analyze ${state.location.name}` }),
        createSafeElement(document, 'p', { className: 'muted-text', text: 'Select any suggested prompt above or ask a custom question below. Conversation context stays active across follow-up questions and resets automatically if you switch cities.' })
      ]
    }));
    return;
  }

  for (const turn of state.coachHistory) {
    out.appendChild(createSafeElement(document, 'div', { className: 'chat-bubble-user', text: turn.question }));
    if (turn.loading) {
      out.appendChild(createSafeElement(document, 'div', {
        className: 'coach-card is-loading',
        children: [createSafeElement(document, 'p', { className: 'muted-text', attrs: { id: `coach-loading-${turn.id}` }, text: turn.loadingText || COACH_LOADING_PHASES[0] })]
      }));
    } else if (turn.aborted) {
      const retryBtn = createSafeElement(document, 'button', { className: 'btn btn-ghost btn-sm', text: 'Retry', attrs: { type: 'button' } });
      retryBtn.addEventListener('click', () => handleCoachSubmit(state, turn.question));
      out.appendChild(createSafeElement(document, 'div', {
        className: 'coach-card',
        children: [createSafeElement(document, 'p', { className: 'muted-text', text: 'Generation stopped before completion.' }), createSafeElement(document, 'div', { className: 'action-group', children: [retryBtn] })]
      }));
    } else {
      out.appendChild(buildCoachResponseCard(state, turn));
    }
  }
  out.scrollTop = out.scrollHeight;
}

/**
 * Aborts any in-flight AI Coach request and clears loading phase timers.
 * @param {Record<string, any>} state
 * @returns {void}
 */
export function stopCoachGeneration(state) {
  if (state.coachAbortController) {
    state.coachAbortController.abort();
    state.coachAbortController = null;
  }
  clearInterval(state.coachLoadingTimer);
}

function applyCoachResultStatus(state, result) {
  if (!result.isFallback) {
    updateCoachHeaderStatus(state, { statusText: 'Connected', statusTone: 'good', modelText: `Model: ${result.model}` });
    return;
  }
  const isRateLimited = result.diagnosticCode === 'RATE_LIMITED' || result.diagnosticCode === 'QUOTA_OR_RATE_LIMIT_EXCEEDED';
  updateCoachHeaderStatus(state, {
    statusText: isRateLimited ? 'Rate limited' : 'Grounded fallback active',
    statusTone: isRateLimited ? 'alert' : 'warn',
    modelText: 'Model: Offline Grounded Engine'
  });
}

function setCoachBusyState(isBusy) {
  const sendBtn = getButton('btn-ask-coach');
  const stopBtn = getButton('btn-stop-coach');
  const inputEl = getField('coach-input');
  sendBtn.disabled = isBusy;
  sendBtn.textContent = isBusy ? 'Sending…' : 'Send';
  stopBtn.hidden = !isBusy;
  inputEl.disabled = isBusy;
  if (!isBusy) inputEl.focus();
}

function startCoachPhaseTimer(state, turn) {
  let phaseIdx = 0;
  clearInterval(state.coachLoadingTimer);
  state.coachLoadingTimer = setInterval(() => {
    phaseIdx = Math.min(COACH_LOADING_PHASES.length - 1, phaseIdx + 1);
    turn.loadingText = COACH_LOADING_PHASES[phaseIdx];
    const el = document.getElementById(`coach-loading-${turn.id}`);
    if (el) el.textContent = turn.loadingText;
  }, 1600);
}

/**
 * Submits a user question to the VayuShield AI Coach with progress phases and cancellation.
 * @param {Record<string, any>} state
 * @param {string} rawQuestion
 * @returns {Promise<void>}
 */
export async function handleCoachSubmit(state, rawQuestion) {
  const question = sanitizeText(rawQuestion, 500);
  if (!question || state.coachAbortController) return;

  const token = ++state.coachToken;
  setCoachBusyState(true);
  updateCoachHeaderStatus(state, { statusText: 'Connecting…', statusTone: 'neutral' });

  const turn = { id: token, question, loading: true, loadingText: COACH_LOADING_PHASES[0], response: null, aborted: false };
  state.coachHistory = [...state.coachHistory, turn].slice(-10);
  renderCoachThread(state);
  startCoachPhaseTimer(state, turn);

  const abortController = new AbortController();
  state.coachAbortController = abortController;
  const { history, historySummary } = state.coachSession.exportHistoryPayload();

  try {
    const result = await askVayuShieldCoach(
      { question, intel: state.intel, profile: state.profile, indoorEval: state.indoorEval, history, historySummary },
      { signal: abortController.signal }
    );
    if (token !== state.coachToken) return;
    turn.loading = false;
    turn.response = result;
    state.coachSession.addExchange(question, result.answer || result.directAnswer || result.headline, result.intent);
    applyCoachResultStatus(state, result);
    renderCoachThread(state);
  } catch (_abortErr) {
    if (token !== state.coachToken) return;
    turn.loading = false;
    turn.aborted = true;
    updateCoachHeaderStatus(state, { statusText: 'Stopped', statusTone: 'neutral' });
    renderCoachThread(state);
  } finally {
    clearInterval(state.coachLoadingTimer);
    if (state.coachAbortController === abortController) state.coachAbortController = null;
    setCoachBusyState(false);
  }
}