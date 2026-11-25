/**
 * @fileoverview VayuShield Application Controller (Project APEX 2.0 + Project ORACLE).
 * Pure entry-point orchestrator connecting normalized environmental telemetry,
 * household state, and modular CSP-compliant UI views under js/ui/.
 */

import { normalizeProfile } from './core/impactModel.js';
import { sanitizeText } from './core/security.js';
import { createConversationSession } from './services/aiAssistantService.js';
import { CURATED_CITIES, fetchAirIntelligence } from './services/airQualityService.js';
import { renderCoachTemplates, renderCoachThread, stopCoachGeneration, updateCoachHeaderStatus } from './ui/coachView.js';
import { closeSuggestions, loadPledgesWithOrigin, renderCommunity } from './ui/communityView.js';
import { renderDispersionModule } from './ui/dispersionView.js';
import { getField, hideErrorBanner, loadJson, saveJson, setLoadingState, showErrorBanner, STORAGE_KEYS } from './ui/domHelpers.js';
import { initEvents, initNavSync, initTabs } from './ui/eventBindings.js';
import { renderImpactSimulator, renderIndoorLab, renderRoutine } from './ui/indoorLabView.js';
import { renderCityPresets, renderLiveIntelligence } from './ui/liveDashboardView.js';

function loadSavedLocation() {
  const saved = loadJson(STORAGE_KEYS.LOCATION, null);
  const valid = saved && typeof saved.name === 'string' && typeof saved.lat === 'number'
    && typeof saved.lon === 'number' && Number.isFinite(saved.lat) && Number.isFinite(saved.lon);
  if (!valid) return { ...CURATED_CITIES[0] };
  return {
    name: sanitizeText(saved.name, 60) || CURATED_CITIES[0].name,
    region: sanitizeText(saved.region, 80) || 'Saved Location',
    lat: saved.lat,
    lon: saved.lon
  };
}

const state = {
  location: loadSavedLocation(),
  pastDays: 1,
  intel: null,
  indoorEval: null,
  profile: loadJson(STORAGE_KEYS.PROFILE, normalizeProfile()),
  selectedScenarios: loadJson(STORAGE_KEYS.SCENARIOS, ['transit-shift', 'sleep-filtration', 'fitted-n95']),
  pledges: loadPledgesWithOrigin(),
  activePledgeFilter: 'all',
  iaqInputMode: 'cadr',
  iaqFilterGrade: 'h13',
  customAch: null,
  customCadr: null,
  fetchToken: 0,
  coachToken: 0,
  coachHistory: [],
  coachSession: createConversationSession(),
  coachAbortController: null,
  coachLoadingTimer: null,
  suggestions: [],
  highlightedSuggestion: -1,
  searchDebounceTimer: null,
  searchSeq: 0
};

/**
 * Updates active location state and persists to localStorage unless disabled.
 * @param {{ name?: string, region?: string, lat: number, lon: number }} loc
 * @param {{ persist?: boolean }} [options={}]
 * @returns {void}
 */
function setActiveLocation(loc, options = {}) {
  state.location = {
    name: sanitizeText(loc.name, 60) || 'Selected Location',
    region: sanitizeText(loc.region, 80) || `${loc.lat}°, ${loc.lon}°`,
    lat: Number(loc.lat),
    lon: Number(loc.lon)
  };
  if (options.persist !== false) saveJson(STORAGE_KEYS.LOCATION, state.location);
}

function handleCitySelect(city) {
  closeSuggestions(state);
  setActiveLocation(city);
  loadLocationIntelligence();
}

function renderDependentModules() {
  renderIndoorLab(state);
  renderRoutine(state);
  renderImpactSimulator(state);
}

function syncProfileInputs() {
  getField('profile-household').value = state.profile.householdProfile;
  getField('profile-commute').value = state.profile.commuteMode;
  getField('profile-km').value = String(state.profile.dailyCommuteKm);
  getField('profile-cooking').value = state.profile.cookingFuel;
  getField('profile-budget').value = state.profile.budgetTier;
  getField('profile-room').value = String(state.profile.roomSqFt);
  getField('profile-ceiling').value = String(state.profile.ceilingHeightFt);
  getField('profile-leakage').value = state.profile.leakageId;
}

function handleProfileChange() {
  state.profile = normalizeProfile({
    householdProfile: getField('profile-household').value,
    commuteMode: getField('profile-commute').value,
    dailyCommuteKm: getField('profile-km').value,
    cookingFuel: getField('profile-cooking').value,
    budgetTier: getField('profile-budget').value,
    roomSqFt: getField('profile-room').value,
    ceilingHeightFt: getField('profile-ceiling').value,
    leakageId: getField('profile-leakage').value
  });
  state.customAch = null;
  state.customCadr = null;
  saveJson(STORAGE_KEYS.PROFILE, state.profile);
  document.getElementById('profile-status').textContent = 'Profile recalculated';
  renderDependentModules();
}

async function loadLocationIntelligence(forceRefresh = false) {
  const token = ++state.fetchToken;
  setLoadingState(true);
  hideErrorBanner();

  try {
    const intel = await fetchAirIntelligence(state.location, { pastDays: state.pastDays, forceRefresh });
    if (token !== state.fetchToken) return;
    state.intel = intel;
    renderLiveIntelligence(state, handleCitySelect);
    renderDispersionModule(state.intel);
    renderDependentModules();

    if (state.coachSession.setLocation(state.location)) {
      stopCoachGeneration(state);
      state.coachHistory = [];
    }
    updateCoachHeaderStatus(state, { statusText: 'Ready', statusTone: 'teal' });
    renderCoachThread(state);
  } catch (err) {
    if (token !== state.fetchToken) return;
    showErrorBanner(
      `Live atmospheric data unavailable for ${state.location.name}`,
      `${err?.message || 'Upstream telemetry request failed.'} VayuShield does not substitute data from another city.`
    );
    const freshness = document.getElementById('freshness-badge');
    freshness.textContent = 'Unavailable';
    freshness.className = 'badge badge-alert';
    renderDependentModules();
  } finally {
    if (token === state.fetchToken) setLoadingState(false);
  }
}

syncProfileInputs();
initTabs();
initNavSync();
initEvents(state, { setActiveLocation, loadLocationIntelligence, syncProfileInputs, handleProfileChange, renderDependentModules });
renderCityPresets(state, handleCitySelect);
renderCoachTemplates(state);
renderCommunity(state);
loadLocationIntelligence();