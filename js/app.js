/**
 * @fileoverview Main accessible UI controller for VayuShield AI.
 * Renders all dynamic views using zero-XSS DOM helpers (zero innerHTML, zero inline handlers).
 */

import {
  buildWinterInversionWindows,
  calculateCigaretteEquivalent,
  CITY_PRESETS,
  classifyAqi
} from './core/aqiEngine.js';
import {
  calculateChoiceImpact,
  calculateFiltrationSizing,
  generateDailyRoutine,
  generateIndoorHacks,
  normalizeProfile,
  SUSTAINABLE_SWAPS
} from './core/recommendationEngine.js';
import {
  clearNode,
  createSafeElement,
  isPlausibleApiKey,
  sanitizeText
} from './core/security.js';
import {
  askAirQualityAssistant,
  COACH_PROMPT_TEMPLATES
} from './services/aiAssistantService.js';
import {
  fetchLiveAirQuality,
  geocodeCity
} from './services/airQualityService.js';

const STORAGE_PROFILE_KEY = 'vayushield_profile_v1';
const STORAGE_SWAPS_KEY = 'vayushield_swaps_v1';
const STORAGE_PLEDGES_KEY = 'vayushield_pledges_v1';
const SESSION_API_KEY = 'vayushield_gemini_session_key';
const SVG_NS = 'http://www.w3.org/2000/svg';

const DEFAULT_PLEDGES = [
  {
    id: 'pl-1',
    neighborhood: 'Dwarka Sector 12 RWA',
    action: 'Adopted damp courtyard sweeping and strict zero winter leaf-burning across 8 towers.',
    supporters: 34
  },
  {
    id: 'pl-2',
    neighborhood: 'Indiranagar Parents Circle',
    action: 'Running 5 shared neighborhood carpools for 7:30 AM school drop-offs.',
    supporters: 21
  },
  {
    id: 'pl-3',
    neighborhood: 'Salt Lake Block CD',
    action: 'Built 6 community DIY HEPA box filters for our senior citizens reading room.',
    supporters: 19
  }
];

const state = {
  airData: { ...CITY_PRESETS[0], sourceLabel: 'Winter Smog Baseline Model' },
  profile: loadJson(STORAGE_PROFILE_KEY, normalizeProfile()),
  selectedSwaps: loadJson(STORAGE_SWAPS_KEY, ['transit-carpool', 'hepa-sealed-sleep', 'induction-cooking']),
  pledges: loadJson(STORAGE_PLEDGES_KEY, DEFAULT_PLEDGES),
  lastFocusedBeforeModal: null
};

function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage quota errors gracefully
  }
}

function createSvgElement(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.toLowerCase().startsWith('on')) continue;
    el.setAttribute(k, String(v));
  }
  return el;
}

function showToast(message) {
  const region = document.getElementById('toast-region');
  if (!region) return;
  const toast = createSafeElement(document, 'div', {
    className: 'toast',
    text: sanitizeText(message, 160)
  });
  region.appendChild(toast);
  setTimeout(() => toast.remove(), 3400);
}

function updateAiModeIndicator() {
  const label = document.getElementById('ai-mode-label');
  const hasSessionKey = isPlausibleApiKey(sessionStorage.getItem(SESSION_API_KEY));
  if (label) {
    label.textContent = hasSessionKey ? 'Engine: Gemini session' : 'Engine: Grounded / proxy';
  }
}

function renderCityPresets() {
  const container = document.getElementById('city-presets');
  clearNode(container);

  for (const city of CITY_PRESETS) {
    const isSelected = state.airData.name.toLowerCase() === city.name.toLowerCase();
    const btn = createSafeElement(document, 'button', {
      className: `chip-btn${isSelected ? ' is-selected' : ''}`,
      text: city.name,
      attrs: { type: 'button', 'aria-pressed': String(isSelected) }
    });
    btn.addEventListener('click', () => loadCityAirQuality(city));
    container.appendChild(btn);
  }
}

function renderHeroTelemetry() {
  const air = state.airData;
  const band = classifyAqi(air.aqi);
  const cigs = calculateCigaretteEquivalent(air.pm25);

  document.getElementById('hero-heading').textContent = `${air.name}, ${air.region}`;
  document.getElementById('hero-source').textContent = `${air.sourceLabel} • Dominant Driver: ${air.dominantSource}`;
  document.getElementById('aqi-value').textContent = String(air.aqi);
  document.getElementById('aqi-band').textContent = band.label;

  const pill = document.getElementById('aqi-pill');
  pill.className = `aqi-readout aqi-${band.id}`;

  document.getElementById('metric-pm25').textContent = `${air.pm25} µg/m³`;
  document.getElementById('metric-pm10').textContent = `${air.pm10} µg/m³`;
  document.getElementById('metric-no2').textContent = `${air.no2} µg/m³`;
  document.getElementById('metric-cigs').textContent = `${cigs} cigs/day`;

  document.getElementById('aqi-summary').textContent = `Health Advisory: ${band.summary}`;
  document.getElementById('aqi-mask').textContent = `Mask Guidance: ${band.maskAdvice}`;
  document.getElementById('aqi-ventilation').textContent = `Ventilation: ${band.ventilationWindow}`;

  renderCityPresets();
  renderInversionChart();
}

function renderInversionChart() {
  const windows = buildWinterInversionWindows(state.airData.aqi, state.airData.windKmh);
  const container = document.getElementById('inversion-chart-container');
  const legend = document.getElementById('inversion-legend');
  clearNode(container);
  clearNode(legend);

  const svg = createSvgElement('svg', {
    viewBox: '0 0 420 145',
    class: 'inversion-svg',
    role: 'img',
    'aria-label': `24-hour projected AQI chart for ${state.airData.name}`
  });

  const minProjected = Math.min(...windows.map((w) => w.projectedAqi));
  const barWidth = 44;
  const gap = 22;

  windows.forEach((slot, idx) => {
    const x = 18 + idx * (barWidth + gap);
    const barHeight = Math.max(16, Math.round((slot.projectedAqi / maxAqi) * 95));
    const y = 112 - barHeight;
    const isBestWindow = slot.projectedAqi === minProjected || slot.safeForVentilation;
    const fill = isBestWindow
      ? '#1D5FD6'
      : slot.projectedAqi > 300
        ? '#991B1B'
        : '#C2410C';

    svg.appendChild(createSvgElement('rect', {
      x,
      y,
      width: barWidth,
      height: barHeight,
      rx: 4,
      fill
    }));

    const valText = createSvgElement('text', {
      x: x + barWidth / 2,
      y: y - 6,
      'text-anchor': 'middle',
      fill: '#111827',
      'font-size': '11',
      'font-weight': '500'
    });
    valText.textContent = String(slot.projectedAqi);
    svg.appendChild(valText);

    const lblText = createSvgElement('text', {
      x: x + barWidth / 2,
      y: 132,
      'text-anchor': 'middle',
      fill: '#64748B',
      'font-size': '10'
    });
    lblText.textContent = slot.window.split('–')[0].trim();
    svg.appendChild(lblText);

    const li = createSafeElement(document, 'li', {
      className: `inversion-item${isBestWindow ? ' is-safe' : ''}`,
      children: [
        createSafeElement(document, 'span', { text: `${slot.window} — ${slot.label}` }),
        createSafeElement(document, 'strong', { text: `AQI ${slot.projectedAqi}` })
      ]
    });
    legend.appendChild(li);
  });

  container.appendChild(svg);
}

function renderDailyRoutine() {
  const routine = generateDailyRoutine(state.airData, state.profile);
  const list = document.getElementById('routine-list');
  clearNode(list);

  for (const step of routine) {
    const li = createSafeElement(document, 'li', {
      className: 'routine-item',
      children: [
        createSafeElement(document, 'div', {
          className: 'routine-head',
          children: [
            createSafeElement(document, 'h3', { className: 'routine-phase', text: step.phase }),
            createSafeElement(document, 'span', { className: 'routine-slot', text: step.slot })
          ]
        }),
        createSafeElement(document, 'p', { className: 'routine-action', text: step.action }),
        createSafeElement(document, 'p', { className: 'routine-impact', text: `Direct Impact: ${step.directImpact}` })
      ]
    });
    list.appendChild(li);
  }
}

function renderIndoorHacks() {
  const sizing = calculateFiltrationSizing(state.profile.roomSqFt, state.airData.aqi);
  const hacks = generateIndoorHacks(state.airData, state.profile);

  document.getElementById('cadr-badge').textContent =
    `Room ${state.profile.roomSqFt} sq.ft → Min CADR ${sizing.minCadrM3h} m³/h (${sizing.achTarget} ACH)`;

  const grid = document.getElementById('iaq-grid');
  clearNode(grid);

  for (const hack of hacks) {
    const isMatch = hack.tier === state.profile.budgetTier;
    const costLabel = hack.estimatedCostInr === 0 ? '₹0 (Free Habit)' : `Est. ₹${hack.estimatedCostInr.toLocaleString('en-IN')}`;
    const card = createSafeElement(document, 'article', {
      className: `iaq-card${isMatch ? ' is-recommended' : ''}`,
      children: [
        createSafeElement(document, 'div', {
          className: 'iaq-meta',
          children: [
            createSafeElement(document, 'span', {
              className: isMatch ? 'badge badge-ai' : 'badge badge-subtle',
              text: isMatch ? 'Matches Your Budget' : costLabel
            }),
            createSafeElement(document, 'span', {
              className: 'badge badge-safe',
              text: `Up to -${hack.pm25ReductionPct}% Indoor PM2.5`
            })
          ]
        }),
        createSafeElement(document, 'h3', { className: 'iaq-title', text: hack.title }),
        createSafeElement(document, 'p', { className: 'muted-text', text: hack.howTo }),
        createSafeElement(document, 'p', { className: 'routine-impact', text: `Why It Works: ${hack.impactExplanation}` })
      ]
    });
    grid.appendChild(card);
  }
}

function renderImpactSimulator() {
  const list = document.getElementById('swaps-list');
  clearNode(list);
  const selectedSet = new Set(state.selectedSwaps);

  for (const swap of SUSTAINABLE_SWAPS) {
    const checked = selectedSet.has(swap.id);
    const checkbox = createSafeElement(document, 'input', {
      attrs: {
        type: 'checkbox',
        id: `swap-${swap.id}`,
        name: 'sustainable-swap',
        value: swap.id
      }
    });
    checkbox.checked = checked;
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        if (!state.selectedSwaps.includes(swap.id)) state.selectedSwaps.push(swap.id);
      } else {
        state.selectedSwaps = state.selectedSwaps.filter((id) => id !== swap.id);
      }
      saveJson(STORAGE_SWAPS_KEY, state.selectedSwaps);
      renderImpactSimulator();
    });

    const label = createSafeElement(document, 'label', {
      className: `swap-option${checked ? ' is-checked' : ''}`,
      attrs: { for: `swap-${swap.id}` },
      children: [
        checkbox,
        createSafeElement(document, 'span', {
          children: [
            createSafeElement(document, 'span', { className: 'swap-title', text: swap.title }),
            createSafeElement(document, 'span', { className: 'swap-benefit', text: swap.communityBenefit }),
            createSafeElement(document, 'span', {
              className: 'swap-stats',
              children: [
                createSafeElement(document, 'span', { text: `-${swap.pm25ExposureCutPct}% PM2.5` }),
                createSafeElement(document, 'span', { text: `-${swap.co2SavedKgPerMonth} kg CO₂/mo` }),
                createSafeElement(document, 'span', { text: `Save ₹${swap.monthlySavingsInr}/mo` })
              ]
            })
          ]
        })
      ]
    });
    list.appendChild(label);
  }

  const impact = calculateChoiceImpact(state.selectedSwaps, state.airData.pm25);
  document.getElementById('imp-pm25-pct').textContent = `-${impact.totalExposureReductionPct}%`;
  document.getElementById('imp-pm25-detail').textContent = `${impact.baselinePm25} → ${impact.projectedPm25} µg/m³`;
  document.getElementById('imp-cigs-saved').textContent = `${impact.cigarettesAvoidedPerDay} / day`;
  document.getElementById('imp-cigs-detail').textContent = `${impact.baselineCigarettes} → ${impact.projectedCigarettes} cigs eq.`;
  document.getElementById('imp-co2').textContent = `${impact.co2SavedKgPerMonth} kg/mo`;
  document.getElementById('imp-trees').textContent = `${impact.treesEquivalentPerYear} trees/yr equivalent`;
  document.getElementById('imp-inr').textContent = `₹${impact.monthlySavingsInr.toLocaleString('en-IN')} / mo`;

  const meter = document.getElementById('imp-meter');
  meter.value = impact.totalExposureReductionPct;
  document.getElementById('imp-meter-label').textContent = `${impact.totalExposureReductionPct}% (Max realistic: 78%)`;

  document.getElementById('imp-community-text').textContent =
    impact.selectedCount === 0
      ? 'Select at least one sustainable choice on the left to quantify your personal and neighborhood clean-air impact.'
      : `If 1,000 families in ${state.airData.name} adopt these ${impact.selectedCount} habits, your community prevents ${impact.community1000FamiliesCo2TonsPerYear} metric tons of CO₂/year and dramatically lowers winter peak street-level smog.`;
}

function renderCoachTemplates() {
  const container = document.getElementById('coach-templates');
  clearNode(container);

  for (const tpl of COACH_PROMPT_TEMPLATES) {
    const btn = createSafeElement(document, 'button', {
      className: 'chip-btn',
      text: tpl.label,
      attrs: { type: 'button' }
    });
    btn.addEventListener('click', () => {
      document.getElementById('coach-input').value = tpl.prompt;
      handleCoachQuery(tpl.prompt);
    });
    container.appendChild(btn);
  }
}

function renderCoachOutput(result) {
  const output = document.getElementById('coach-output');
  clearNode(output);
  document.getElementById('coach-engine-badge').textContent = result.engine;

  const stepsList = createSafeElement(document, 'ol', {
    className: 'coach-steps',
    children: result.immediateSteps.map((step) => createSafeElement(document, 'li', { text: step }))
  });

  const card = createSafeElement(document, 'article', {
    className: 'coach-card',
    children: [
      createSafeElement(document, 'h3', { className: 'iaq-title', text: result.headline }),
      stepsList,
      createSafeElement(document, 'p', { className: 'advisory-line', text: `Indoor Air Hack: ${result.indoorHack}` }),
      createSafeElement(document, 'p', { className: 'advisory-line', text: `Sustainable Swap: ${result.sustainableSwap}` }),
      createSafeElement(document, 'p', { className: 'routine-impact', text: `Direct Impact: ${result.directImpact}` }),
      createSafeElement(document, 'p', { className: 'muted-text', text: `Community Action: ${result.communityTip}` })
    ]
  });

  output.appendChild(card);
}

async function handleCoachQuery(question) {
  const btn = document.getElementById('btn-ask-coach');
  btn.disabled = true;
  btn.textContent = 'Analyzing Smog Context...';

  const result = await askAirQualityAssistant({
    question,
    airData: state.airData,
    profile: state.profile,
    selectedSwapIds: state.selectedSwaps,
    sessionApiKey: sessionStorage.getItem(SESSION_API_KEY) || ''
  });

  renderCoachOutput(result);
  btn.disabled = false;
  btn.textContent = 'Generate Tailored AI Plan';
}

function renderPledges() {
  const list = document.getElementById('pledge-list');
  clearNode(list);
  document.getElementById('pledge-count').textContent = `${state.pledges.length} Active`;

  for (const pledge of state.pledges) {
    const upvoteBtn = createSafeElement(document, 'button', {
      className: 'btn btn-outline',
      text: `+1 (${pledge.supporters})`,
      attrs: {
        type: 'button',
        'aria-label': `Support pledge from ${pledge.neighborhood}, currently ${pledge.supporters} supporters`
      }
    });
    upvoteBtn.addEventListener('click', () => {
      pledge.supporters += 1;
      saveJson(STORAGE_PLEDGES_KEY, state.pledges);
      renderPledges();
      showToast(`Supported ${pledge.neighborhood}'s clean-air pledge!`);
    });

    const li = createSafeElement(document, 'li', {
      className: 'pledge-item',
      children: [
        createSafeElement(document, 'div', {
          children: [
            createSafeElement(document, 'span', { className: 'pledge-neighborhood', text: pledge.neighborhood }),
            createSafeElement(document, 'p', { className: 'pledge-text', text: pledge.action })
          ]
        }),
        upvoteBtn
      ]
    });
    list.appendChild(li);
  }
}

function renderAllViews() {
  renderHeroTelemetry();
  renderDailyRoutine();
  renderIndoorHacks();
  renderImpactSimulator();
  renderPledges();
}

async function loadCityAirQuality(location) {
  document.getElementById('hero-source').textContent = `Fetching live air quality for ${location.name}...`;
  const matchedPreset = CITY_PRESETS.find((c) => c.name.toLowerCase() === location.name.toLowerCase()) || null;
  const live = await fetchLiveAirQuality({
    name: location.name,
    region: location.region,
    lat: location.lat,
    lon: location.lon,
    fallbackPreset: matchedPreset
  });
  state.airData = live;
  renderAllViews();
  const activeQuestion = document.getElementById('coach-input').value.trim() || COACH_PROMPT_TEMPLATES[0].prompt;
  handleCoachQuery(activeQuestion);
}

function syncProfileInputs() {
  document.getElementById('profile-household').value = state.profile.householdProfile;
  document.getElementById('profile-commute').value = state.profile.commuteMode;
  document.getElementById('profile-budget').value = state.profile.budgetTier;
  document.getElementById('profile-cooking').value = state.profile.cookingFuel;
  document.getElementById('profile-room').value = String(state.profile.roomSqFt);
  document.getElementById('profile-km').value = String(state.profile.dailyCommuteKm);
}

function handleProfileChange() {
  state.profile = normalizeProfile({
    householdProfile: document.getElementById('profile-household').value,
    commuteMode: document.getElementById('profile-commute').value,
    budgetTier: document.getElementById('profile-budget').value,
    cookingFuel: document.getElementById('profile-cooking').value,
    roomSqFt: document.getElementById('profile-room').value,
    dailyCommuteKm: document.getElementById('profile-km').value
  });
  saveJson(STORAGE_PROFILE_KEY, state.profile);
  document.getElementById('profile-saved-badge').textContent = 'Recommendations Updated';
  renderDailyRoutine();
  renderIndoorHacks();
}

// Accessible Tabs with WCAG Roving Arrow-Key Navigation
function initTabs() {
  const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
  const activateTab = (targetTab) => {
    for (const tab of tabs) {
      const selected = tab === targetTab;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      tab.classList.toggle('is-active', selected);
      const panel = document.getElementById(tab.getAttribute('aria-controls'));
      if (panel) panel.hidden = !selected;
    }
  };

  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => activateTab(tab));
    tab.addEventListener('keydown', (event) => {
      let nextIdx = null;
      if (event.key === 'ArrowRight') nextIdx = (index + 1) % tabs.length;
      if (event.key === 'ArrowLeft') nextIdx = (index - 1 + tabs.length) % tabs.length;
      if (event.key === 'Home') nextIdx = 0;
      if (event.key === 'End') nextIdx = tabs.length - 1;
      if (nextIdx !== null) {
        event.preventDefault();
        tabs[nextIdx].focus();
        activateTab(tabs[nextIdx]);
      }
    });
  });
}

// Accessible Modal with Escape + Focus Restoration
function initModal() {
  const modal = document.getElementById('api-modal');
  const openBtn = document.getElementById('btn-open-settings');
  const closeBtn = document.getElementById('btn-close-modal');
  const keyInput = document.getElementById('gemini-key-input');

  const closeModal = () => {
    modal.hidden = true;
    if (state.lastFocusedBeforeModal) {
      state.lastFocusedBeforeModal.focus();
    }
  };

  openBtn.addEventListener('click', () => {
    state.lastFocusedBeforeModal = document.activeElement;
    keyInput.value = sessionStorage.getItem(SESSION_API_KEY) || '';
    modal.hidden = false;
    keyInput.focus();
  });

  closeBtn.addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) closeModal();
  });

  document.getElementById('api-settings-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const candidate = keyInput.value.trim();
    if (!isPlausibleApiKey(candidate)) {
      showToast('Please enter a valid Gemini API key starting with AIza...');
      return;
    }
    sessionStorage.setItem(SESSION_API_KEY, candidate);
    updateAiModeIndicator();
    closeModal();
    showToast('Session Gemini API key saved securely.');
  });

  document.getElementById('btn-clear-key').addEventListener('click', () => {
    sessionStorage.removeItem(SESSION_API_KEY);
    keyInput.value = '';
    updateAiModeIndicator();
    closeModal();
    showToast('Cleared session API key. Using Server Proxy / Grounded AI.');
  });
}

function initEventListeners() {
  document.getElementById('city-search-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = document.getElementById('city-search-input');
    const query = sanitizeText(input.value, 80);
    if (query.length < 2) return;
    const match = await geocodeCity(query);
    if (!match) {
      showToast(`Could not locate "${query}". Try a major city name.`);
      return;
    }
    input.value = '';
    await loadCityAirQuality(match);
    showToast(`Updated live air quality for ${match.name}.`);
  });

  document.getElementById('btn-gps').addEventListener('click', () => {
    if (!navigator.geolocation) {
      showToast('Geolocation is unavailable in this browser.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        loadCityAirQuality({
          name: 'Your Local Area',
          region: `${pos.coords.latitude.toFixed(2)}°, ${pos.coords.longitude.toFixed(2)}°`,
          lat: pos.coords.latitude,
          lon: pos.coords.longitude
        });
        showToast('Loaded live AQI for your GPS coordinates.');
      },
      () => showToast('Location permission denied. Select a city preset or search above.')
    );
  });

  ['profile-household', 'profile-commute', 'profile-budget', 'profile-cooking', 'profile-room', 'profile-km']
    .forEach((id) => document.getElementById(id).addEventListener('change', handleProfileChange));

  document.getElementById('btn-copy-routine').addEventListener('click', async () => {
    const routine = generateDailyRoutine(state.airData, state.profile);
    const summary = [
      `VayuShield AI Family Smog Plan — ${state.airData.name} (AQI ${state.airData.aqi})`,
      ...routine.map((r) => `• ${r.slot} (${r.phase}): ${r.action}`)
    ].join('\n');
    try {
      await navigator.clipboard.writeText(summary);
      showToast('Copied personalized family plan to clipboard!');
    } catch {
      showToast('Clipboard access unavailable in this context.');
    }
  });

  document.getElementById('coach-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = document.getElementById('coach-input').value;
    handleCoachQuery(q);
  });

  document.getElementById('pledge-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const neighborhood = sanitizeText(document.getElementById('pledge-neighborhood').value, 60);
    const action = sanitizeText(document.getElementById('pledge-action').value, 140);
    if (!neighborhood || !action) return;

    state.pledges.unshift({
      id: `pl-${Date.now()}`,
      neighborhood,
      action,
      supporters: 1
    });
    saveJson(STORAGE_PLEDGES_KEY, state.pledges);
    e.target.reset();
    renderPledges();
    showToast('Community clean-air pledge published!');
  });
}

// Bootstrap
syncProfileInputs();
updateAiModeIndicator();
initTabs();
initModal();
initEventListeners();
renderCoachTemplates();
renderAllViews();
loadCityAirQuality(CITY_PRESETS[0]);