/**
 * @fileoverview VayuShield 2.0 Application Controller.
 * Coordinates all 8 intelligence modules with:
 * - Zero innerHTML and zero inline style mutations (strict CSP compliant)
 * - Race-condition protection via monotonic request tokens
 * - Explicit error/retry states (never substitutes another city on API failure)
 * - Interactive 24h / 7d / 30d historical SVG trend charts & 24h dispersion charts
 * - WCAG 2.2 AA roving-tab keyboard navigation and live-region announcements
 */

import { compareToWhoGuideline } from './core/cpcbAqi.js';
import {
  ACTION_CATEGORIES,
  computeCommunityStats,
  moderateCommunitySubmission
} from './core/communityModeration.js';
import {
  calculateMortalityRiskHeuristic,
  evaluateSelectedScenarios,
  normalizeProfile
} from './core/impactModel.js';
import { evaluateIndoorFiltration } from './core/indoorPhysics.js';
import { buildImmediateAction, buildIntelligentRoutine } from './core/routineEngine.js';
import { clearNode, createSafeElement, sanitizeText } from './core/security.js';
import { askVayuShieldCoach, COACH_PROMPT_TEMPLATES } from './services/aiAssistantService.js';
import {
  clearAirQualityCache,
  CURATED_CITIES,
  fetchAirIntelligence,
  geocodeCity
} from './services/airQualityService.js';

const STORAGE_PROFILE_KEY = 'vayushield_profile_v2';
const STORAGE_SCENARIOS_KEY = 'vayushield_scenarios_v2';
const STORAGE_PLEDGES_KEY = 'vayushield_pledges_v2';
const SVG_NS = 'http://www.w3.org/2000/svg';

const DEFAULT_PLEDGES = [
  {
    id: 'seed-1',
    area: 'Dwarka District, Delhi',
    category: 'zero-burning',
    action: 'Resident association adopted damp morning courtyard sweeping and composting for winter leaf litter.',
    supporters: 28,
    status: 'active'
  },
  {
    id: 'seed-2',
    area: 'Indiranagar East, Bengaluru',
    category: 'mobility',
    action: 'Coordinated 4 shared school-run carpools across neighborhood families to cut morning corridor idling.',
    supporters: 19,
    status: 'active'
  },
  {
    id: 'seed-3',
    area: 'Salt Lake Zone, Kolkata',
    category: 'indoor-care',
    action: 'Assembled low-cost MERV-13/HEPA fan boxes for the community senior reading room during peak winter haze.',
    supporters: 15,
    status: 'active'
  }
];

const state = {
  location: { ...CURATED_CITIES[0] },
  pastDays: 1,
  intel: null,
  indoorEval: null,
  profile: loadJson(STORAGE_PROFILE_KEY, normalizeProfile()),
  selectedScenarios: loadJson(STORAGE_SCENARIOS_KEY, ['transit-shift', 'sleep-filtration', 'fitted-n95']),
  pledges: loadJson(STORAGE_PLEDGES_KEY, DEFAULT_PLEDGES),
  activePledgeFilter: 'all',
  customAch: null,
  customCadr: null,
  fetchToken: 0,
  coachToken: 0
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
    // Ignore private-browsing storage restrictions gracefully
  }
}

function createSvg(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.toLowerCase().startsWith('on') || k.toLowerCase() === 'style') continue;
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
  setTimeout(() => toast.remove(), 3500);
}

function formatCoord(val, pos, neg) {
  const num = Number(val);
  if (!Number.isFinite(num)) return '—';
  return `${Math.abs(num).toFixed(4)}° ${num >= 0 ? pos : neg}`;
}

function formatLocalTimestamp(iso) {
  if (!iso || typeof iso !== 'string') return 'Unknown time';
  return iso.replace('T', ' ');
}

function setLoadingState(isLoading) {
  const card = document.getElementById('telemetry-card');
  const disp = document.getElementById('dispersion-module');
  card?.classList.toggle('is-loading', isLoading);
  disp?.classList.toggle('is-loading', isLoading);
  const freshness = document.getElementById('freshness-badge');
  if (isLoading && freshness) {
    freshness.textContent = 'Updating…';
    freshness.className = 'badge badge-neutral';
  }
}

function showErrorBanner(title, detail) {
  const banner = document.getElementById('error-banner');
  document.getElementById('error-title').textContent = sanitizeText(title, 120);
  document.getElementById('error-detail').textContent = sanitizeText(detail, 260);
  banner.hidden = false;
}

function hideErrorBanner() {
  document.getElementById('error-banner').hidden = true;
}

/* ==================== MODULE 1: LIVE AIR INTELLIGENCE ==================== */

function renderCityPresets() {
  const container = document.getElementById('city-presets');
  clearNode(container);

  for (const city of CURATED_CITIES) {
    const isActive = state.location.name.toLowerCase() === city.name.toLowerCase();
    const btn = createSafeElement(document, 'button', {
      className: `chip-btn${isActive ? ' is-active' : ''}`,
      text: city.name,
      attrs: { type: 'button', 'aria-pressed': String(isActive) }
    });
    btn.addEventListener('click', () => {
      state.location = { ...city };
      loadLocationIntelligence();
    });
    container.appendChild(btn);
  }
}

function renderLiveIntelligence() {
  const intel = state.intel;
  if (!intel) return;

  const { location, current, rollingAverages, cpcb, dispersion, metadata } = intel;

  document.getElementById('source-type-badge').textContent = `Modeled · ${metadata.gridResolution}`;
  const freshnessEl = document.getElementById('freshness-badge');
  freshnessEl.textContent = `${metadata.freshness} · ${formatLocalTimestamp(current.timestamp)}`;
  freshnessEl.className = 'badge badge-teal';

  const trendEl = document.getElementById('trend-badge');
  const trendLabel = dispersion.available
    ? `6h Trend: ${dispersion.trend} (${dispersion.trendDeltaPct >= 0 ? '+' : ''}${dispersion.trendDeltaPct}%)`
    : 'Trend: Unavailable';
  trendEl.textContent = trendLabel;
  trendEl.className = `badge ${
    dispersion.trend === 'improving'
      ? 'badge-good'
      : dispersion.trend === 'worsening'
        ? 'badge-alert'
        : 'badge-neutral'
  }`;

  document.getElementById('city-heading').textContent = `${location.name}, ${location.region}`;
  document.getElementById('location-meta').textContent =
    `${formatCoord(location.lat, 'N', 'S')}, ${formatCoord(location.lon, 'E', 'W')} · Timezone: ${location.timezone}`;

  // AQI Readout
  const aqiBox = document.getElementById('aqi-box');
  document.getElementById('aqi-standard-label').textContent = cpcb.isOfficialCpcb
    ? 'Official CPCB AQI'
    : 'CPCB-Derived Est.';
  document.getElementById('aqi-value').textContent = cpcb.aqi !== null ? String(cpcb.aqi) : 'N/A';
  document.getElementById('aqi-band').textContent = cpcb.band?.label || 'Incomplete';
  aqiBox.className = `aqi-box aqi-${cpcb.band?.id || 'neutral'}`;

  // First-Screen Immediate Action Callout
  const immediate = buildImmediateAction(intel, state.profile);
  const callout = document.getElementById('immediate-action');
  callout.className = `action-callout action-${immediate.level}`;
  document.getElementById('action-headline').textContent = immediate.headline;
  document.getElementById('action-detail').textContent = immediate.detail;

  // Primary Pollutant & WHO 2021 Guideline Ratio
  const primary = cpcb.primaryPollutant;
  document.getElementById('primary-pollutant-line').textContent = primary
    ? `Primary concern: ${primary.name} (${primary.concentration} ${primary.unit}, ${primary.averaging} rolling mean → sub-index ${primary.subIndex})`
    : 'Primary concern: Insufficient valid pollutant readings';

  const whoPm25 = compareToWhoGuideline('pm25', rollingAverages.pm25_24h);
  const whoBadge = document.getElementById('who-ratio-badge');
  if (whoPm25) {
    whoBadge.textContent = whoPm25.exceeds
      ? `${whoPm25.ratio}× WHO 2021 24h PM2.5 (${whoPm25.guidelineValue} ${whoPm25.unit})`
      : `Within WHO 2021 24h PM2.5 (${whoPm25.guidelineValue} ${whoPm25.unit})`;
    whoBadge.className = `badge ${whoPm25.exceeds ? 'badge-warn' : 'badge-good'}`;
  } else {
    whoBadge.textContent = 'WHO 2021 comparison unavailable';
    whoBadge.className = 'badge badge-neutral';
  }

  // 6-Pollutant Breakdown Grid (PM2.5, PM10, NO2, SO2, O3, CO)
  const grid = document.getElementById('pollutant-grid');
  clearNode(grid);

  const subByKey = new Map(cpcb.subIndices.map((s) => [s.pollutant, s]));
  const displayOrder = [
    { key: 'pm25', label: 'PM2.5', unit: 'µg/m³', avg: '24h mean', val: rollingAverages.pm25_24h, cur: current.pm25 },
    { key: 'pm10', label: 'PM10', unit: 'µg/m³', avg: '24h mean', val: rollingAverages.pm10_24h, cur: current.pm10 },
    { key: 'no2', label: 'NO₂', unit: 'µg/m³', avg: '24h mean', val: rollingAverages.no2_24h, cur: current.no2 },
    { key: 'so2', label: 'SO₂', unit: 'µg/m³', avg: '24h mean', val: rollingAverages.so2_24h, cur: current.so2 },
    { key: 'o3', label: 'O₃', unit: 'µg/m³', avg: '8h mean', val: rollingAverages.o3_8h, cur: current.o3 },
    { key: 'co', label: 'CO', unit: 'mg/m³', avg: '8h mean', val: rollingAverages.coMg_8h, cur: current.coMg }
  ];

  for (const item of displayOrder) {
    const sub = subByKey.get(item.key);
    const isPrimary = primary && primary.pollutant === item.key;
    const valStr = item.val !== null && item.val !== undefined
      ? `${item.val} ${item.unit}`
      : 'Unavailable';
    const curStr = item.cur !== null && item.cur !== undefined
      ? `Now: ${Number(item.cur).toFixed(item.key === 'co' ? 2 : 1)}`
      : 'Now: —';

    const cell = createSafeElement(document, 'div', {
      className: `pollutant-cell${isPrimary ? ' is-primary' : ''}`,
      children: [
        createSafeElement(document, 'div', {
          className: 'pollutant-head',
          children: [
            createSafeElement(document, 'span', { text: `${item.label} (${item.avg})` }),
            createSafeElement(document, 'span', { text: sub ? `SI ${sub.subIndex}` : '—' })
          ]
        }),
        createSafeElement(document, 'strong', { className: 'pollutant-val', text: valStr }),
        createSafeElement(document, 'span', {
          className: 'pollutant-sub',
          text: isPrimary ? `${curStr} · Primary Driver` : curStr
        })
      ]
    });
    grid.appendChild(cell);
  }

  // Provenance Drawer
  document.getElementById('meta-provider-line').textContent =
    `Air Quality Source: ${metadata.provider} (${metadata.gridResolution}). Weather Source: ${metadata.weatherProvider}.`;
  document.getElementById('meta-averaging-line').textContent =
    `${cpcb.methodologyLabel}. ${metadata.averagingNote} NH₃ and Pb are not supplied by Open-Meteo CAMS.`;

  const heuristic = calculateMortalityRiskHeuristic(rollingAverages.pm25_24h);
  document.getElementById('meta-heuristic-line').textContent = heuristic
    ? `Mortality Risk Context (${heuristic.source}): ~${heuristic.cigaretteEquivalentPerDay} cigarettes/day equivalent. ${heuristic.caveat}`
    : 'Mortality risk heuristic requires a valid 24-hr PM2.5 rolling average.';

  const caveatList = document.getElementById('meta-caveats-list');
  clearNode(caveatList);
  for (const caveat of cpcb.caveats) {
    caveatList.appendChild(createSafeElement(document, 'li', { text: caveat }));
  }

  renderHistoryChart();
  renderCityPresets();
}

function renderHistoryChart() {
  const wrap = document.getElementById('history-chart-wrap');
  clearNode(wrap);

  const history = state.intel?.history;
  const points = history?.points || [];
  document.getElementById('history-caption').textContent = points.length >= 2
    ? `Modeled hourly PM2.5 over past ${history.pastDays === 1 ? '24 hours' : `${history.pastDays} days`} (${points.length} hourly points)`
    : 'Historical records unavailable for the selected range.';

  if (points.length < 2) {
    wrap.appendChild(createSafeElement(document, 'p', {
      className: 'muted-text',
      text: 'Insufficient historical data points returned by upstream API.'
    }));
    return;
  }

  // Downsample gently for crisp SVG rendering on 7d/30d views while preserving peaks
  const maxRender = 96;
  const step = Math.max(1, Math.floor(points.length / maxRender));
  const sampled = points.filter((_, idx) => idx % step === 0 || idx === points.length - 1);

  const values = sampled.map((p) => p.pm25);
  const maxVal = Math.max(30, ...values);
  const minVal = Math.min(...values);
  const avgVal = (values.reduce((s, v) => s + v, 0) / values.length).toFixed(1);

  const width = 560;
  const height = 148;
  const padL = 36;
  const padR = 14;
  const padT = 18;
  const padB = 26;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const svg = createSvg('svg', {
    viewBox: `0 0 ${width} ${height}`,
    class: 'chart-svg',
    role: 'img',
    'aria-label': `Historical modeled PM2.5 chart over past ${history.pastDays} days. Min ${minVal}, average ${avgVal}, max ${maxVal} micrograms per cubic meter.`
  });

  // WHO 24h reference line (15 µg/m³)
  const whoY = padT + plotH - (Math.min(15, maxVal) / maxVal) * plotH;
  svg.appendChild(createSvg('line', {
    x1: padL,
    y1: whoY,
    x2: width - padR,
    y2: whoY,
    stroke: '#22C55E',
    'stroke-dasharray': '4 4',
    'stroke-width': '1',
    opacity: '0.65'
  }));

  const coords = sampled.map((pt, i) => {
    const x = padL + (i / Math.max(1, sampled.length - 1)) * plotW;
    const y = padT + plotH - (pt.pm25 / maxVal) * plotH;
    return [Number(x.toFixed(1)), Number(y.toFixed(1))];
  });

  const polylinePoints = coords.map(([x, y]) => `${x},${y}`).join(' ');
  const areaPoints = `${padL},${padT + plotH} ${polylinePoints} ${coords[coords.length - 1][0]},${padT + plotH}`;

  svg.appendChild(createSvg('polygon', {
    points: areaPoints,
    fill: '#2DD4BF',
    opacity: '0.12'
  }));

  svg.appendChild(createSvg('polyline', {
    points: polylinePoints,
    fill: 'none',
    stroke: '#2DD4BF',
    'stroke-width': '2',
    'stroke-linejoin': 'round'
  }));

  // Axis & summary labels
  const labels = [
    { x: padL - 6, y: padT + 4, anchor: 'end', text: String(Math.round(maxVal)), fill: '#94A3B8' },
    { x: padL - 6, y: padT + plotH, anchor: 'end', text: '0', fill: '#94A3B8' },
    { x: padL, y: height - 6, anchor: 'start', text: sampled[0].time.slice(5, 16).replace('T', ' '), fill: '#94A3B8' },
    { x: width - padR, y: height - 6, anchor: 'end', text: `Avg ${avgVal} · Max ${maxVal} µg/m³`, fill: '#CBD5E1' }
  ];

  for (const l of labels) {
    const t = createSvg('text', {
      x: l.x,
      y: l.y,
      'text-anchor': l.anchor,
      fill: l.fill,
      'font-size': '10'
    });
    t.textContent = l.text;
    svg.appendChild(t);
  }

  wrap.appendChild(svg);
}

/* ==================== MODULE 2: ATMOSPHERIC DISPERSION ==================== */

function renderDispersionModule() {
  const intel = state.intel;
  if (!intel) return;
  const { current, dispersion } = intel;

  document.getElementById('dispersion-classification').textContent = dispersion.classification;
  const confBadge = document.getElementById('confidence-badge');
  confBadge.textContent = `Confidence: ${dispersion.confidence.level}`;
  confBadge.className = 'badge badge-modeled';

  document.getElementById('wx-temp').textContent =
    typeof current.tempC === 'number' ? `${current.tempC.toFixed(1)} °C` : 'Unavailable';
  document.getElementById('wx-wind').textContent =
    typeof current.windKmh === 'number'
      ? `${current.windKmh.toFixed(1)} km/h ${dispersion.hourly[0]?.windCompass || ''}`.trim()
      : 'Unavailable';
  document.getElementById('wx-rh').textContent =
    typeof current.rhPct === 'number' ? `${Math.round(current.rhPct)}%` : 'Unavailable';

  const firstHour = dispersion.hourly[0];
  document.getElementById('wx-vc').textContent =
    firstHour && typeof firstHour.vc === 'number'
      ? `${firstHour.vc.toLocaleString('en-IN')} m²/s`
      : 'Unavailable';

  if (dispersion.available && dispersion.bestOutdoorWindow && dispersion.peakAccumulationWindow) {
    document.getElementById('best-window-val').textContent = dispersion.bestOutdoorWindow.label;
    document.getElementById('best-window-note').textContent =
      `Avg ~${dispersion.bestOutdoorWindow.avgPm25} µg/m³ PM2.5${dispersion.bestOutdoorWindow.avgVc ? ` · VC ${dispersion.bestOutdoorWindow.avgVc.toLocaleString('en-IN')} m²/s` : ''}`;

    document.getElementById('worst-window-val').textContent = dispersion.peakAccumulationWindow.label;
    document.getElementById('worst-window-note').textContent =
      `Avg ~${dispersion.peakAccumulationWindow.avgPm25} µg/m³ PM2.5${dispersion.peakAccumulationWindow.avgVc ? ` · VC ${dispersion.peakAccumulationWindow.avgVc.toLocaleString('en-IN')} m²/s` : ''}`;
  } else {
    document.getElementById('best-window-val').textContent = 'Unavailable';
    document.getElementById('worst-window-val').textContent = 'Unavailable';
  }

  document.getElementById('dispersion-methodology-text').textContent = dispersion.methodologyNote;
  document.getElementById('dispersion-confidence-reason').textContent = dispersion.confidence.reason;

  // Render 24-Hour Hourly Forecast Bar Chart
  const chartWrap = document.getElementById('dispersion-chart-wrap');
  const timeline = document.getElementById('dispersion-timeline');
  clearNode(chartWrap);
  clearNode(timeline);

  if (!dispersion.available) {
    chartWrap.appendChild(createSafeElement(document, 'p', {
      className: 'muted-text',
      text: '24-hour dispersion forecast unavailable.'
    }));
    return;
  }

  const hours = dispersion.hourly;
  const maxPm = Math.max(40, ...hours.map((h) => h.pm25));
  const bestStart = dispersion.bestOutdoorWindow?.startHour;
  const width = 460;
  const height = 148;
  const padL = 28;
  const padR = 10;
  const padT = 16;
  const padB = 24;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const barGap = 3;
  const barW = Math.max(8, (plotW - barGap * (hours.length - 1)) / hours.length);

  const svg = createSvg('svg', {
    viewBox: `0 0 ${width} ${height}`,
    class: 'chart-svg',
    role: 'img',
    'aria-label': `Next 24-hour modeled hourly PM2.5 forecast. Cleanest window ${dispersion.bestOutdoorWindow?.label}, peak window ${dispersion.peakAccumulationWindow?.label}.`
  });

  hours.forEach((h, idx) => {
    const x = padL + idx * (barW + barGap);
    const bh = Math.max(6, (h.pm25 / maxPm) * plotH);
    const y = padT + plotH - bh;
    const isBest = h.hourLabel === bestStart || (h.pm25 <= (dispersion.bestOutdoorWindow?.avgPm25 || 0) * 1.05);
    const fill = isBest
      ? '#2DD4BF'
      : h.pm25 > 120
        ? '#EF4444'
        : h.pm25 > 60
          ? '#F59E0B'
          : '#38BDF8';

    svg.appendChild(createSvg('rect', {
      x: x.toFixed(1),
      y: y.toFixed(1),
      width: barW.toFixed(1),
      height: bh.toFixed(1),
      rx: '2',
      fill
    }));

    if (idx % 4 === 0) {
      const lbl = createSvg('text', {
        x: (x + barW / 2).toFixed(1),
        y: height - 6,
        'text-anchor': 'middle',
        fill: '#94A3B8',
        'font-size': '9.5'
      });
      lbl.textContent = h.hourLabel;
      svg.appendChild(lbl);
    }
  });

  const maxLbl = createSvg('text', {
    x: padL - 4,
    y: padT + 4,
    'text-anchor': 'end',
    fill: '#94A3B8',
    'font-size': '9.5'
  });
  maxLbl.textContent = String(Math.round(maxPm));
  svg.appendChild(maxLbl);

  chartWrap.appendChild(svg);

  // 6 evenly spaced 4-hour checkpoints
  for (let i = 0; i < hours.length; i += 4) {
    const pt = hours[i];
    const row = createSafeElement(document, 'div', {
      className: 'disp-row',
      children: [
        createSafeElement(document, 'span', {
          text: `${pt.hourLabel} · ${pt.dispersionCategory}${pt.blh ? ` (BLH ${pt.blh} m)` : ''}`
        }),
        createSafeElement(document, 'strong', {
          text: `${pt.pm25} µg/m³`
        })
      ]
    });
    timeline.appendChild(row);
  }
}

/* ==================== MODULE 4: INTELLIGENT DAILY ROUTINE ==================== */

function renderRoutine() {
  const list = document.getElementById('routine-list');
  clearNode(list);
  if (!state.intel || !state.indoorEval) return;

  const items = buildIntelligentRoutine(state.intel, state.profile, state.indoorEval);
  for (const step of items) {
    const li = createSafeElement(document, 'li', {
      className: 'routine-card',
      children: [
        createSafeElement(document, 'div', {
          className: 'routine-head',
          children: [
            createSafeElement(document, 'h3', { className: 'routine-title', text: step.phase }),
            createSafeElement(document, 'span', { className: 'routine-window', text: step.window })
          ]
        }),
        createSafeElement(document, 'p', { className: 'muted-text', text: step.condition }),
        createSafeElement(document, 'p', { className: 'routine-action', text: step.action }),
        createSafeElement(document, 'p', { className: 'mono-meta', text: step.basis })
      ]
    });
    list.appendChild(li);
  }
}

/* ==================== MODULE 5: INDOOR AIR QUALITY LAB ==================== */

function renderIndoorLab() {
  const outdoorPm25 = state.intel?.rollingAverages?.pm25_24h ?? state.intel?.current?.pm25 ?? 120;
  const indoorSourceId = state.profile.cookingFuel === 'induction'
    ? 'minimal'
    : state.profile.cookingFuel === 'biomass-mixed'
      ? 'heavy'
      : 'cooking';

  const evalResult = evaluateIndoorFiltration({
    floorAreaSqFt: state.profile.roomSqFt,
    ceilingHeightFt: state.profile.ceilingHeightFt,
    outdoorPm25,
    leakageId: state.profile.leakageId,
    indoorSourceId,
    targetAch: state.customAch ?? undefined,
    deviceCadrM3h: state.customCadr ?? undefined
  });

  state.indoorEval = evalResult;

  // Keep numeric comparison inputs synchronized on initial run
  const achInput = document.getElementById('iaq-ach-input');
  const cadrInput = document.getElementById('iaq-cadr-input');
  if (state.customAch === null) achInput.value = String(evalResult.sizing.recommendedAch);
  if (state.customCadr === null) cadrInput.value = String(evalResult.sizing.recommendedCadrM3h);

  document.getElementById('iaq-volume-badge').textContent =
    `Volume: ${evalResult.dimensions.volumeM3} m³ (${evalResult.dimensions.floorAreaM2} m² × ${evalResult.dimensions.ceilingHeightM} m)`;
  document.getElementById('iaq-rec-cadr').textContent =
    `${evalResult.sizing.recommendedCadrM3h} m³/h (${evalResult.sizing.recommendedAch} ACH)`;
  document.getElementById('iaq-unfiltered').textContent =
    `${evalResult.outcomes.unfilteredIndoorPm25} µg/m³`;
  document.getElementById('iaq-filtered').textContent =
    `${evalResult.outcomes.filteredIndoorPm25} µg/m³ (${evalResult.outcomes.filteredRange[0]}–${evalResult.outcomes.filteredRange[1]})`;
  document.getElementById('iaq-reduction').textContent =
    `-${evalResult.outcomes.reductionPct}% (${evalResult.sizing.effectiveFiltrationAch} eACH)`;

  // CSP-safe SVG visual comparison bars (zero inline style attributes)
  const barBox = document.getElementById('iaq-visual-bar');
  clearNode(barBox);
  const maxRef = Math.max(25, outdoorPm25, evalResult.outcomes.unfilteredIndoorPm25);
  const svg = createSvg('svg', {
    viewBox: '0 0 560 92',
    class: 'chart-svg',
    role: 'img',
    'aria-label': `Indoor PM2.5 mass-balance comparison: outdoor ${outdoorPm25}, unfiltered indoor ${evalResult.outcomes.unfilteredIndoorPm25}, filtered indoor ${evalResult.outcomes.filteredIndoorPm25} micrograms per cubic meter.`
  });

  const rows = [
    { label: `Outdoor Modeled (${outdoorPm25} µg/m³)`, val: outdoorPm25, fill: '#F59E0B', y: 12 },
    { label: `Indoor Unfiltered (${evalResult.outcomes.unfilteredIndoorPm25} µg/m³)`, val: evalResult.outcomes.unfilteredIndoorPm25, fill: '#EF4444', y: 40 },
    { label: `Indoor Filtered @ ${evalResult.sizing.activeCadrM3h} m³/h (${evalResult.outcomes.filteredIndoorPm25} µg/m³)`, val: evalResult.outcomes.filteredIndoorPm25, fill: '#2DD4BF', y: 68 }
  ];

  for (const r of rows) {
    const labelEl = createSvg('text', { x: '0', y: String(r.y), fill: '#CBD5E1', 'font-size': '10.5' });
    labelEl.textContent = r.label;
    svg.appendChild(labelEl);

    svg.appendChild(createSvg('rect', {
      x: '245',
      y: String(r.y - 9),
      width: '310',
      height: '10',
      rx: '4',
      fill: '#142033'
    }));

    const fillW = Math.max(6, Math.round((r.val / maxRef) * 310));
    svg.appendChild(createSvg('rect', {
      x: '245',
      y: String(r.y - 9),
      width: String(fillW),
      height: '10',
      rx: '4',
      fill: r.fill
    }));
  }
  barBox.appendChild(svg);

  // Budget Tiers
  const tiersGrid = document.getElementById('iaq-tiers-grid');
  clearNode(tiersGrid);
  for (const tier of evalResult.tiers) {
    const isSelected = tier.id === state.profile.budgetTier;
    const card = createSafeElement(document, 'article', {
      className: 'subpanel',
      children: [
        createSafeElement(document, 'div', {
          className: 'provenance-row',
          children: [
            createSafeElement(document, 'span', {
              className: isSelected ? 'badge badge-teal' : 'badge badge-neutral',
              text: isSelected ? 'Selected Budget Tier' : tier.estimatedCostInr
            }),
            createSafeElement(document, 'span', {
              className: 'badge badge-neutral',
              text: tier.cadrM3h > 0 ? `Est. CADR ${tier.cadrM3h} m³/h` : 'Source / Sealing Control'
            })
          ]
        }),
        createSafeElement(document, 'h3', { className: 'subhead', text: tier.name }),
        createSafeElement(document, 'p', { className: 'muted-text', text: tier.note })
      ]
    });
    tiersGrid.appendChild(card);
  }

  // Safety & Gas vs Particle Distinction Notes
  const safetyBox = document.getElementById('iaq-safety-notes');
  clearNode(safetyBox);
  for (const note of evalResult.safetyNotes) {
    safetyBox.appendChild(createSafeElement(document, 'p', { className: 'muted-text', text: note }));
  }
}

/* ==================== MODULE 6: SUSTAINABLE IMPACT SIMULATOR ==================== */

function renderImpactSimulator() {
  const outdoorPm25 = state.intel?.rollingAverages?.pm25_24h ?? state.intel?.current?.pm25 ?? 120;
  const result = evaluateSelectedScenarios(state.selectedScenarios, state.profile, outdoorPm25);

  const list = document.getElementById('scenarios-list');
  clearNode(list);
  const selectedSet = new Set(state.selectedScenarios);

  for (const sc of result.scenarios) {
    const checked = selectedSet.has(sc.id);
    const checkbox = createSafeElement(document, 'input', {
      attrs: { type: 'checkbox', id: `sc-${sc.id}`, value: sc.id }
    });
    checkbox.checked = checked;
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        if (!state.selectedScenarios.includes(sc.id)) state.selectedScenarios.push(sc.id);
      } else {
        state.selectedScenarios = state.selectedScenarios.filter((id) => id !== sc.id);
      }
      saveJson(STORAGE_SCENARIOS_KEY, state.selectedScenarios);
      renderImpactSimulator();
    });

    const statsParts = [];
    if (sc.pm25DoseCutUg > 0) statsParts.push(`-${sc.pm25DoseCutUg} µg/m³ 24h personal dose`);
    if (sc.co2SavedKgPerMonth > 0) statsParts.push(`-${sc.co2SavedKgPerMonth} kg CO₂/mo`);
    if (sc.monthlySavingsInr > 0) statsParts.push(`Save ₹${sc.monthlySavingsInr.toLocaleString('en-IN')}/mo`);

    const label = createSafeElement(document, 'label', {
      className: `scenario-option${checked ? ' is-checked' : ''}`,
      attrs: { for: `sc-${sc.id}` },
      children: [
        checkbox,
        createSafeElement(document, 'span', {
          children: [
            createSafeElement(document, 'strong', { className: 'routine-title', text: sc.title }),
            createSafeElement(document, 'p', { className: 'muted-text', text: sc.assumption }),
            createSafeElement(document, 'span', {
              className: 'mono-meta accent-text',
              text: statsParts.join(' · ') || 'Baseline sustainable habit maintained'
            })
          ]
        })
      ]
    });
    list.appendChild(label);
  }

  document.getElementById('imp-pm25-pct').textContent = `-${result.exposureReductionPct}%`;
  document.getElementById('imp-pm25-detail').textContent =
    `${result.baselinePersonalPm25} → ${result.projectedPersonalPm25} µg/m³`;
  document.getElementById('imp-co2').textContent = `${result.co2SavedKgPerMonth} kg/mo`;
  document.getElementById('imp-co2-yr').textContent = `${result.co2SavedKgPerYear} kg CO₂/year`;
  document.getElementById('imp-inr').textContent = `₹${result.monthlySavingsInr.toLocaleString('en-IN')} / mo`;
  document.getElementById('imp-community').textContent = `${result.community1000HouseholdsCo2TonsYr} t/yr`;

  document.getElementById('imp-meter').value = result.exposureReductionPct;
  document.getElementById('imp-meter-text').textContent = `${result.exposureReductionPct}%`;
  document.getElementById('imp-disclaimer').textContent = result.methodologyDisclaimer;
}

/* ==================== MODULE 7: VAYUSHIELD AI COACH ==================== */

function renderCoachTemplates() {
  const row = document.getElementById('coach-templates');
  clearNode(row);
  for (const tpl of COACH_PROMPT_TEMPLATES) {
    const btn = createSafeElement(document, 'button', {
      className: 'chip-btn',
      text: tpl.label,
      attrs: { type: 'button' }
    });
    btn.addEventListener('click', () => {
      document.getElementById('coach-input').value = tpl.prompt;
      handleCoachSubmit(tpl.prompt);
    });
    row.appendChild(btn);
  }
}

function renderCoachResult(res) {
  const out = document.getElementById('coach-output');
  clearNode(out);
  const badge = document.getElementById('coach-engine-badge');
  badge.textContent = res.engine;
  badge.className = `badge ${res.isFallback ? 'badge-warn' : 'badge-teal'}`;

  const makeListSection = (title, items) => createSafeElement(document, 'div', {
    children: [
      createSafeElement(document, 'h4', { className: 'coach-section-title', text: title }),
      createSafeElement(document, 'ul', {
        className: 'coach-list',
        children: (items || []).map((t) => createSafeElement(document, 'li', { text: t }))
      })
    ]
  });

  const card = createSafeElement(document, 'article', {
    className: 'coach-card',
    children: [
      createSafeElement(document, 'h3', { className: 'panel-title', text: res.headline }),
      makeListSection('Telemetry & Facts Used', res.factsUsed),
      makeListSection('Evidence-Based Recommendations', res.recommendations),
      createSafeElement(document, 'div', {
        children: [
          createSafeElement(document, 'h4', { className: 'coach-section-title', text: 'Indoor Air & Filtration Guidance' }),
          createSafeElement(document, 'p', { className: 'routine-action', text: res.indoorGuidance })
        ]
      }),
      makeListSection('Assumptions, Uncertainties & Limits', res.assumptionsAndLimits)
    ]
  });
  out.appendChild(card);
}

async function handleCoachSubmit(question) {
  const token = ++state.coachToken;
  const btn = document.getElementById('btn-ask-coach');
  btn.disabled = true;
  btn.textContent = 'Evaluating Telemetry…';

  const result = await askVayuShieldCoach({
    question,
    intel: state.intel,
    profile: state.profile,
    indoorEval: state.indoorEval
  });

  if (token !== state.coachToken) return;
  renderCoachResult(result);
  btn.disabled = false;
  btn.textContent = 'Ask VayuShield AI';
}

/* ==================== MODULE 8: COMMUNITY CLEAN-AIR NETWORK ==================== */

function renderCommunity() {
  const stats = computeCommunityStats(state.pledges);
  const statsRow = document.getElementById('community-stats-badges');
  clearNode(statsRow);
  statsRow.appendChild(createSafeElement(document, 'span', {
    className: 'badge badge-teal',
    text: `${stats.totalPledges} Initiatives`
  }));
  statsRow.appendChild(createSafeElement(document, 'span', {
    className: 'badge badge-neutral',
    text: `${stats.totalSupporters} Total Supporters`
  }));

  // Filter chips
  const filterRow = document.getElementById('pledge-filter-row');
  clearNode(filterRow);
  const filters = [{ id: 'all', label: 'All Categories' }, ...ACTION_CATEGORIES];
  for (const f of filters) {
    const active = state.activePledgeFilter === f.id;
    const btn = createSafeElement(document, 'button', {
      className: `chip-btn${active ? ' is-active' : ''}`,
      text: f.label,
      attrs: { type: 'button', 'aria-pressed': String(active) }
    });
    btn.addEventListener('click', () => {
      state.activePledgeFilter = f.id;
      renderCommunity();
    });
    filterRow.appendChild(btn);
  }

  // Pledge list
  const list = document.getElementById('pledge-list');
  clearNode(list);
  const categoryLabels = Object.fromEntries(ACTION_CATEGORIES.map((c) => [c.id, c.label]));
  const visible = state.activePledgeFilter === 'all'
    ? state.pledges
    : state.pledges.filter((p) => p.category === state.activePledgeFilter);

  if (visible.length === 0) {
    list.appendChild(createSafeElement(document, 'li', {
      className: 'subpanel muted-text',
      text: 'No community initiatives logged in this category yet.'
    }));
    return;
  }

  for (const pledge of visible) {
    const upvoteBtn = createSafeElement(document, 'button', {
      className: 'btn btn-secondary btn-sm',
      text: `Support (${pledge.supporters})`,
      attrs: {
        type: 'button',
        'aria-label': `Support clean-air initiative in ${pledge.area}, ${pledge.supporters} supporters`
      }
    });
    upvoteBtn.addEventListener('click', () => {
      pledge.supporters += 1;
      saveJson(STORAGE_PLEDGES_KEY, state.pledges);
      renderCommunity();
      showToast(`Recorded support for ${pledge.area}.`);
    });

    const li = createSafeElement(document, 'li', {
      className: 'pledge-card',
      children: [
        createSafeElement(document, 'div', {
          children: [
            createSafeElement(document, 'div', {
              className: 'provenance-row',
              children: [
                createSafeElement(document, 'span', { className: 'badge badge-teal', text: categoryLabels[pledge.category] || 'Community' }),
                createSafeElement(document, 'span', { className: 'mono-meta', text: pledge.area })
              ]
            }),
            createSafeElement(document, 'p', { className: 'routine-action', text: pledge.action })
          ]
        }),
        upvoteBtn
      ]
    });
    list.appendChild(li);
  }
}

/* ==================== ORCHESTRATION & EVENTS ==================== */

function renderDependentModules() {
  renderIndoorLab();
  renderRoutine();
  renderImpactSimulator();
}

async function loadLocationIntelligence() {
  const token = ++state.fetchToken;
  setLoadingState(true);
  hideErrorBanner();

  try {
    const intel = await fetchAirIntelligence(state.location, { pastDays: state.pastDays });
    if (token !== state.fetchToken) return;
    state.intel = intel;
    renderLiveIntelligence();
    renderDispersionModule();
    renderDependentModules();
    const activeQ = document.getElementById('coach-input').value.trim() || COACH_PROMPT_TEMPLATES[0].prompt;
    handleCoachSubmit(activeQ);
  } catch (err) {
    if (token !== state.fetchToken) return;
    showErrorBanner(
      `Live atmospheric data unavailable for ${state.location.name}`,
      `${err?.message || 'Upstream telemetry request failed.'} VayuShield does not substitute data from another city.`
    );
    document.getElementById('freshness-badge').textContent = 'Fetch failed';
    document.getElementById('freshness-badge').className = 'badge badge-alert';
  } finally {
    if (token === state.fetchToken) setLoadingState(false);
  }
}

function syncProfileInputs() {
  document.getElementById('profile-household').value = state.profile.householdProfile;
  document.getElementById('profile-commute').value = state.profile.commuteMode;
  document.getElementById('profile-km').value = String(state.profile.dailyCommuteKm);
  document.getElementById('profile-cooking').value = state.profile.cookingFuel;
  document.getElementById('profile-budget').value = state.profile.budgetTier;
  document.getElementById('profile-room').value = String(state.profile.roomSqFt);
  document.getElementById('profile-ceiling').value = String(state.profile.ceilingHeightFt);
  document.getElementById('profile-leakage').value = state.profile.leakageId;
}

function handleProfileChange() {
  state.profile = normalizeProfile({
    householdProfile: document.getElementById('profile-household').value,
    commuteMode: document.getElementById('profile-commute').value,
    dailyCommuteKm: document.getElementById('profile-km').value,
    cookingFuel: document.getElementById('profile-cooking').value,
    budgetTier: document.getElementById('profile-budget').value,
    roomSqFt: document.getElementById('profile-room').value,
    ceilingHeightFt: document.getElementById('profile-ceiling').value,
    leakageId: document.getElementById('profile-leakage').value
  });
  // Reset manual IAQ overrides when core room geometry changes so sizing stays aligned
  state.customAch = null;
  state.customCadr = null;
  saveJson(STORAGE_PROFILE_KEY, state.profile);
  document.getElementById('profile-status').textContent = 'Profile recalculated';
  renderDependentModules();
}

function initTabs() {
  const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
  const activate = (target) => {
    for (const tab of tabs) {
      const selected = tab === target;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      tab.classList.toggle('is-active', selected);
      const panel = document.getElementById(tab.getAttribute('aria-controls'));
      if (panel) panel.hidden = !selected;
    }
  };

  tabs.forEach((tab, idx) => {
    tab.addEventListener('click', () => activate(tab));
    tab.addEventListener('keydown', (e) => {
      let next = null;
      if (e.key === 'ArrowRight') next = (idx + 1) % tabs.length;
      if (e.key === 'ArrowLeft') next = (idx - 1 + tabs.length) % tabs.length;
      if (e.key === 'Home') next = 0;
      if (e.key === 'End') next = tabs.length - 1;
      if (next !== null) {
        e.preventDefault();
        tabs[next].focus();
        activate(tabs[next]);
      }
    });
  });
}

function initEvents() {
  document.getElementById('city-search-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = document.getElementById('city-search-input');
    const query = sanitizeText(input.value, 80);
    if (query.length < 2) return;

    const btn = document.getElementById('btn-search-city');
    btn.disabled = true;
    try {
      const match = await geocodeCity(query);
      if (!match) {
        showToast(`No geographic match found for "${query}". Try a city or district name.`);
        return;
      }
      input.value = '';
      state.location = match;
      await loadLocationIntelligence();
      showToast(`Loaded modeled atmospheric data for ${match.name}.`);
    } catch {
      showToast('Geocoding service is temporarily unreachable.');
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('btn-gps').addEventListener('click', () => {
    if (!navigator.geolocation) {
      showToast('Browser geolocation is unavailable.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        state.location = {
          name: 'Detected Coordinates',
          region: 'Local Modeled Grid',
          lat: Number(pos.coords.latitude.toFixed(4)),
          lon: Number(pos.coords.longitude.toFixed(4))
        };
        loadLocationIntelligence();
        showToast('Loaded modeled telemetry for your current coordinates.');
      },
      (err) => {
        const msg = err.code === 1
          ? 'Location permission denied. Search any city manually above.'
          : 'Unable to determine browser coordinates. Search any city manually.';
        showToast(msg);
      },
      { timeout: 8000 }
    );
  });

  document.getElementById('btn-refresh').addEventListener('click', () => {
    clearAirQualityCache();
    loadLocationIntelligence();
    showToast('Refreshing live atmospheric telemetry.');
  });

  document.getElementById('btn-retry-fetch').addEventListener('click', () => {
    clearAirQualityCache();
    loadLocationIntelligence();
  });

  // Historical range buttons (24h / 7d / 30d)
  const segBtns = Array.from(document.querySelectorAll('.seg-btn'));
  segBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const days = Number(btn.dataset.days);
      if (![1, 7, 30].includes(days) || days === state.pastDays) return;
      state.pastDays = days;
      segBtns.forEach((b) => {
        const active = b === btn;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-pressed', String(active));
      });
      loadLocationIntelligence();
    });
  });

  // Profile fields
  [
    'profile-household', 'profile-commute', 'profile-km', 'profile-cooking',
    'profile-budget', 'profile-room', 'profile-ceiling', 'profile-leakage'
  ].forEach((id) => document.getElementById(id).addEventListener('change', handleProfileChange));

  // IAQ interactive parameter overrides
  document.getElementById('iaq-ach-input').addEventListener('change', (e) => {
    state.customAch = Number(e.target.value);
    state.customCadr = null;
    renderIndoorLab();
    renderRoutine();
  });
  document.getElementById('iaq-cadr-input').addEventListener('change', (e) => {
    state.customCadr = Number(e.target.value);
    renderIndoorLab();
    renderRoutine();
  });

  document.getElementById('btn-copy-routine').addEventListener('click', async () => {
    if (!state.intel || !state.indoorEval) return;
    const steps = buildIntelligentRoutine(state.intel, state.profile, state.indoorEval);
    const text = [
      `VayuShield Plan — ${state.intel.location.name} (CPCB-Derived Est. AQI ${state.intel.cpcb.aqi ?? 'N/A'})`,
      ...steps.map((s) => `• ${s.phase} [${s.window}]: ${s.action}`)
    ].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      showToast('Copied daily schedule to clipboard.');
    } catch {
      showToast('Clipboard permission unavailable in this browser.');
    }
  });

  document.getElementById('coach-form').addEventListener('submit', (e) => {
    e.preventDefault();
    handleCoachSubmit(document.getElementById('coach-input').value);
  });

  // Moderated Community Submission
  document.getElementById('pledge-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('pledge-error');
    const result = moderateCommunitySubmission({
      area: document.getElementById('pledge-area').value,
      category: document.getElementById('pledge-category').value,
      action: document.getElementById('pledge-action').value,
      consentAccepted: document.getElementById('pledge-consent').checked
    });

    if (!result.approved) {
      errorEl.textContent = result.reason;
      errorEl.hidden = false;
      return;
    }

    errorEl.hidden = true;
    state.pledges.unshift(result.entry);
    saveJson(STORAGE_PLEDGES_KEY, state.pledges);
    e.target.reset();
    renderCommunity();
    showToast('Moderated community initiative published.');
  });
}

// Bootstrap
syncProfileInputs();
initTabs();
initEvents();
renderCityPresets();
renderCoachTemplates();
renderCommunity();
loadLocationIntelligence();