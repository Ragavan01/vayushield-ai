/**
 * @fileoverview Accessible keyboard tabs, scroll-spy navigation, search combobox,
 * telemetry export/share, household/IAQ controls, AI Coach, and community form bindings.
 */

import { moderateCommunitySubmission } from '../core/communityModeration.js';
import { normalizeProfile } from '../core/impactModel.js';
import { buildIntelligentRoutine } from '../core/routineEngine.js';
import { createSafeElement, sanitizeText } from '../core/security.js';
import { buildHistoricalCsv, geocodeCity, searchCitySuggestions } from '../services/airQualityService.js';
import { handleCoachSubmit, renderCoachThread, stopCoachGeneration, updateCoachHeaderStatus } from './coachView.js';
import { closeSuggestions, renderCommunity, renderSuggestions } from './communityView.js';
import { getButton, getField, getForm, saveJson, showToast, STORAGE_KEYS } from './domHelpers.js';
import { renderIndoorLab, renderRoutine } from './indoorLabView.js';

/**
 * Wires ARIA-compliant tablist click and Left/Right/Home/End keyboard navigation.
 * @returns {void}
 */
export function initTabs() {
  const tabs = /** @type {HTMLElement[]} */ (Array.from(document.querySelectorAll('[role="tab"]')));
  const activate = (target) => {
    for (const tab of tabs) {
      const selected = tab === target;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      tab.classList.toggle('is-active', selected);
      const panel = document.getElementById(tab.getAttribute('aria-controls') || '');
      if (panel) panel.hidden = !selected;
    }
  };
  tabs.forEach((tab, idx) => {
    tab.addEventListener('click', () => activate(tab));
    tab.addEventListener('keydown', (e) => {
      const keyMap = { ArrowRight: (idx + 1) % tabs.length, ArrowLeft: (idx - 1 + tabs.length) % tabs.length, Home: 0, End: tabs.length - 1 };
      if (keyMap[e.key] === undefined) return;
      e.preventDefault();
      tabs[keyMap[e.key]].focus();
      activate(tabs[keyMap[e.key]]);
    });
  });
}

/**
 * Synchronizes desktop header capsule and mobile dock active links with scroll position.
 * @returns {void}
 */
export function initNavSync() {
  const links = Array.from(document.querySelectorAll('.header-nav .nav-link, .mobile-bottom-nav .dock-link'));
  const setActiveHref = (href) => links.forEach((link) => link.classList.toggle('is-active', link.getAttribute('href') === href));
  links.forEach((link) => link.addEventListener('click', () => setActiveHref(link.getAttribute('href'))));
  if (typeof IntersectionObserver === 'undefined') return;
  const sections = ['#live-intelligence', '#dispersion-module', '#profile-module', '#workspace-module']
    .map((sel) => document.querySelector(sel)).filter(Boolean);
  const observer = new IntersectionObserver((entries) => {
    const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (visible?.target?.id) setActiveHref(`#${visible.target.id}`);
  }, { rootMargin: '-20% 0px -55% 0px', threshold: [0.1, 0.4] });
  sections.forEach((s) => observer.observe(s));
}

function bindSearchKeyboardAndInput(state, searchInput, clearBtn, chooseSuggestion) {
  searchInput.addEventListener('input', () => {
    const val = sanitizeText(searchInput.value, 80);
    clearBtn.hidden = val.length === 0;
    clearTimeout(state.searchDebounceTimer);
    if (val.length < 2) { closeSuggestions(state); return; }
    state.searchDebounceTimer = setTimeout(async () => {
      const seq = ++state.searchSeq;
      try {
        const matches = await searchCitySuggestions(val);
        if (seq !== state.searchSeq) return;
        state.suggestions = matches;
        state.highlightedSuggestion = -1;
        renderSuggestions(state, matches, chooseSuggestion, matches.length === 0 ? `No matching locations found for "${val}"` : null);
      } catch (_searchErr) {
        if (seq === state.searchSeq) closeSuggestions(state);
      }
    }, 280);
  });

  searchInput.addEventListener('keydown', (e) => {
    if (!state.suggestions.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      state.highlightedSuggestion = (state.highlightedSuggestion + delta + state.suggestions.length) % state.suggestions.length;
      renderSuggestions(state, state.suggestions, chooseSuggestion);
    } else if (e.key === 'Escape') {
      closeSuggestions(state);
    } else if (e.key === 'Enter' && state.highlightedSuggestion >= 0) {
      e.preventDefault();
      chooseSuggestion(state.suggestions[state.highlightedSuggestion]);
    }
  });
}

function bindSearchEvents(state, actions) {
  const searchInput = getField('city-search-input');
  const clearBtn = getButton('btn-clear-search');
  const chooseSuggestion = (loc) => {
    searchInput.value = '';
    clearBtn.hidden = true;
    closeSuggestions(state);
    actions.setActiveLocation(loc);
    actions.loadLocationIntelligence();
    showToast(`Loaded modeled atmospheric data for ${loc.name}.`);
  };

  bindSearchKeyboardAndInput(state, searchInput, clearBtn, chooseSuggestion);
  clearBtn.addEventListener('click', () => { searchInput.value = ''; clearBtn.hidden = true; closeSuggestions(state); searchInput.focus(); });
  document.addEventListener('click', (e) => { if (e.target instanceof Element && !e.target.closest('.search-shell')) closeSuggestions(state); });

  getForm('city-search-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const query = sanitizeText(searchInput.value, 80);
    if (query.length < 2) return;
    closeSuggestions(state);
    const btn = getButton('btn-search-city');
    btn.disabled = true;
    try {
      const match = await geocodeCity(query);
      if (!match) { showToast(`No geographic match found for "${query}". Try a city or district name.`); return; }
      chooseSuggestion(match);
    } catch (_geoErr) {
      showToast('Geocoding service is temporarily unreachable.');
    } finally {
      btn.disabled = false;
    }
  });
}

async function handleShareSummary(state) {
  if (!state.intel) return;
  const { location, cpcb, dispersion, metadata } = state.intel;
  const summary = [
    `VayuShield Environmental Summary — ${location.name}, ${location.region}`,
    `CPCB-Derived Est. AQI: ${cpcb.aqi ?? 'N/A'} (${cpcb.band?.label || 'Incomplete'}) · Primary: ${cpcb.primaryPollutant?.name || 'N/A'}`,
    dispersion.bestDaytimeWindow ? `Best Practical Daytime Window: ${dispersion.bestDaytimeWindow.label} (Projected PM2.5: ${dispersion.bestDaytimeWindow.avgPm25} µg/m³)` : '',
    `Source: ${metadata.provider} (${metadata.gridResolution})`
  ].filter(Boolean).join('\n');

  try {
    if (navigator.share) await navigator.share({ title: `VayuShield — ${location.name}`, text: summary });
    else { await navigator.clipboard.writeText(summary); showToast('Copied non-sensitive air quality summary.'); }
  } catch (_shareErr) {
    showToast('Share cancelled or clipboard unavailable.');
  }
}

function handleExportCsv(state) {
  if (!state.intel?.history?.points?.length) { showToast('No historical telemetry available to export.'); return; }
  const url = URL.createObjectURL(new Blob([buildHistoricalCsv(state.intel)], { type: 'text/csv;charset=utf-8;' }));
  const slug = state.intel.location.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 32) || 'location';
  const link = createSafeElement(document, 'a', { attrs: { href: url, download: `vayushield-${slug}-${state.pastDays}d.csv` } });
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast(`Exported ${state.pastDays}d modeled PM2.5 dataset as CSV.`);
}

function bindLocationAndExportEvents(state, actions) {
  getButton('btn-gps').addEventListener('click', () => {
    if (!navigator.geolocation) { showToast('Browser geolocation is unavailable.'); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        actions.setActiveLocation({ name: 'Detected Coordinates', region: 'Local Modeled Grid', lat: Number(pos.coords.latitude.toFixed(4)), lon: Number(pos.coords.longitude.toFixed(4)) }, { persist: false });
        actions.loadLocationIntelligence();
        showToast('Loaded modeled telemetry for your current coordinates.');
      },
      (err) => showToast(err.code === 1 ? 'Location permission denied. Search any city manually above.' : 'Unable to determine browser coordinates. Search any city manually.'),
      { timeout: 8000 }
    );
  });

  getButton('btn-refresh').addEventListener('click', () => { actions.loadLocationIntelligence(true); showToast('Refreshing live atmospheric telemetry.'); });
  getButton('btn-retry-fetch').addEventListener('click', () => actions.loadLocationIntelligence(true));
  getButton('btn-share-summary').addEventListener('click', () => handleShareSummary(state));
  getButton('btn-export-csv').addEventListener('click', () => handleExportCsv(state));

  const segBtns = /** @type {HTMLButtonElement[]} */ (Array.from(document.querySelectorAll('.seg-btn')));
  segBtns.forEach((btn) => btn.addEventListener('click', () => {
    const days = Number(btn.dataset.days);
    if (![1, 7, 30].includes(days) || days === state.pastDays) return;
    state.pastDays = days;
    segBtns.forEach((b) => { b.classList.toggle('is-active', b === btn); b.setAttribute('aria-pressed', String(b === btn)); });
    actions.loadLocationIntelligence();
  }));
}

function bindProfileAndIaqEvents(state, actions) {
  const profileIds = ['profile-household', 'profile-commute', 'profile-km', 'profile-cooking', 'profile-budget', 'profile-room', 'profile-ceiling', 'profile-leakage'];
  profileIds.forEach((id) => getField(id).addEventListener('change', actions.handleProfileChange));

  getButton('btn-reset-profile').addEventListener('click', () => {
    state.profile = normalizeProfile();
    state.customAch = null;
    state.customCadr = null;
    saveJson(STORAGE_KEYS.PROFILE, state.profile);
    actions.syncProfileInputs();
    document.getElementById('profile-status').textContent = 'Defaults restored';
    actions.renderDependentModules();
    showToast('Household parameters reset to defaults.');
  });

  const refreshIaq = () => { renderIndoorLab(state); renderRoutine(state); };
  getField('iaq-mode-select').addEventListener('change', (e) => { state.iaqInputMode = /** @type {HTMLSelectElement} */ (e.target).value; refreshIaq(); });
  getField('iaq-filter-select').addEventListener('change', (e) => { state.iaqFilterGrade = /** @type {HTMLSelectElement} */ (e.target).value; refreshIaq(); });
  getField('iaq-ach-input').addEventListener('change', (e) => { state.customAch = Number(/** @type {HTMLInputElement} */ (e.target).value); state.customCadr = null; refreshIaq(); });
  getField('iaq-cadr-input').addEventListener('change', (e) => { state.customCadr = Number(/** @type {HTMLInputElement} */ (e.target).value); refreshIaq(); });

  getButton('btn-copy-routine').addEventListener('click', async () => {
    if (!state.intel || !state.indoorEval) return;
    const steps = buildIntelligentRoutine(state.intel, state.profile, state.indoorEval);
    const text = [`VayuShield Plan — ${state.intel.location.name} (CPCB-Derived Est. AQI ${state.intel.cpcb.aqi ?? 'N/A'})`, ...steps.map((s) => `• ${s.phase} [${s.window}]: ${s.action}`)].join('\n');
    try { await navigator.clipboard.writeText(text); showToast('Copied daily schedule to clipboard.'); }
    catch (_clipErr) { showToast('Clipboard permission unavailable in this browser.'); }
  });
}

function bindCoachAndCommunityEvents(state) {
  const coachInput = /** @type {HTMLTextAreaElement} */ (document.getElementById('coach-input'));
  const autoSize = () => { coachInput.rows = Math.min(6, Math.max(2, coachInput.value.split('\n').length)); };
  coachInput.addEventListener('input', autoSize);
  coachInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); getForm('coach-form').requestSubmit(); }
  });

  getForm('coach-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = coachInput.value;
    if (!sanitizeText(q, 500)) return;
    coachInput.value = '';
    autoSize();
    handleCoachSubmit(state, q);
  });

  getButton('btn-stop-coach').addEventListener('click', () => { stopCoachGeneration(state); showToast('Stopped AI Coach generation.'); });
  getButton('btn-clear-chat').addEventListener('click', () => {
    stopCoachGeneration(state);
    state.coachSession.reset();
    state.coachHistory = [];
    updateCoachHeaderStatus(state, { statusText: 'Ready', statusTone: 'teal' });
    renderCoachThread(state);
    showToast('Started a new AI Coach conversation.');
  });

  getForm('pledge-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('pledge-error');
    const result = moderateCommunitySubmission({
      area: getField('pledge-area').value,
      category: getField('pledge-category').value,
      action: getField('pledge-action').value,
      consentAccepted: getField('pledge-consent').checked
    });
    if (!result.approved) { errorEl.textContent = result.reason; errorEl.hidden = false; return; }
    errorEl.hidden = true;
    state.pledges.unshift({ ...result.entry, origin: 'local' });
    saveJson(STORAGE_KEYS.PLEDGES, state.pledges);
    getForm('pledge-form').reset();
    renderCommunity(state);
    showToast('Saved moderated initiative to your browser board.');
  });
}

/**
 * Registers all application event listeners across search, profile, IAQ lab, AI Coach, and community.
 * @param {Record<string, any>} state
 * @param {{ setActiveLocation: Function, loadLocationIntelligence: Function, syncProfileInputs: Function, handleProfileChange: Function, renderDependentModules: Function }} actions
 * @returns {void}
 */
export function initEvents(state, actions) {
  bindSearchEvents(state, actions);
  bindLocationAndExportEvents(state, actions);
  bindProfileAndIaqEvents(state, actions);
  bindCoachAndCommunityEvents(state);
}