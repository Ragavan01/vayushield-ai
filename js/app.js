/**
 * @fileoverview VayuShield Project APEX (v3.0) Application Controller.
 * Coordinates all 8 environmental intelligence modules with:
 * - Zero innerHTML and zero inline style mutations (strict CSP compliant)
 * - Circular SVG AQI arc gauge centerpiece with smooth semantic stroke mapping
 * - Debounced global city autocomplete combobox with full keyboard navigation
 * - Persisted location selection (never silently resets to Delhi on reload)
 * - Safe RFC-4180 CSV historical dataset export & non-sensitive summary sharing
 * - Multi-turn frosted-glass AI Coach thread with Copy, Retry, and Clear controls
 * - Scroll-synchronized desktop navigation bar & mobile bottom glass dock
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
  buildHistoricalCsv,
  CURATED_CITIES,
  fetchAirIntelligence,
  geocodeCity,
  searchCitySuggestions
} from './services/airQualityService.js';

const STORAGE_LOCATION_KEY = 'vayushield_location_v3';
const STORAGE_PROFILE_KEY = 'vayushield_profile_v2';
const STORAGE_SCENARIOS_KEY = 'vayushield_scenarios_v2';
const STORAGE_PLEDGES_KEY = 'vayushield_pledges_v2';
const SVG_NS = 'http://www.w3.org/2000/svg';
const AQI_ARC_LENGTH = 145;

const AQI_ARC_COLORS = Object.freeze({
  good: '#34D399',
  satisfactory: '#4ADE80',
  moderate: '#FBBF24',
  poor: '#FB923C',
  'very-poor': '#F87171',
  severe: '#FB7185',
  neutral: '#38BDF8'
});

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
    // Gracefully ignore restricted storage contexts
  }
}

function loadSavedLocation() {
  const saved = loadJson(STORAGE_LOCATION_KEY, null);
  if (
    saved &&
    typeof saved.name === 'string' &&
    typeof saved.lat === 'number' &&
    typeof saved.lon === 'number' &&
    Number.isFinite(saved.lat) &&
    Number.isFinite(saved.lon)
  ) {
    return {
      name: sanitizeText(saved.name, 60) || CURATED_CITIES[0].name,
      region: sanitizeText(saved.region, 80) || 'Saved Location',
      lat: saved.lat,
      lon: saved.lon
    };
  }
  return { ...CURATED_CITIES[0] };
}

const state = {
  location: loadSavedLocation(),
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
  coachToken: 0,
  coachHistory: [],
  suggestions: [],
  highlightedSuggestion: -1,
  searchDebounceTimer: null,
  searchSeq: 0
};

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
  document.getElementById('telemetry-card')?.classList.toggle('is-loading', isLoading);
  document.getElementById('dispersion-module')?.classList.toggle('is-loading', isLoading);
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

function setActiveLocation(loc, options = {}) {
  state.location = {
    name: sanitizeText(loc.name, 60) || 'Selected Location',
    region: sanitizeText(loc.region, 80) || `${loc.lat}°, ${loc.lon}°`,
    lat: Number(loc.lat),
    lon: Number(loc.lon)
  };
  // Persist city selections (avoid persisting unnamed raw GPS coordinates without explicit need)
  if (options.persist !== false) {
    saveJson(STORAGE_LOCATION_KEY, state.location);
  }
}

/* ==================== MODULE 1: LIVE AIR INTELLIGENCE ==================== */

function updateAqiGauge(aqi, bandId) {
  const arc = document.getElementById('aqi-arc-fill');
  if (!arc) return;
  const ratio = typeof aqi === 'number' && Number.isFinite(aqi)
    ? Math.max(0.04, Math.min(1, aqi / 500))
    : 0;
  const offset = Number((AQI_ARC_LENGTH * (1 - ratio)).toFixed(1));
  arc.setAttribute('stroke-dashoffset', String(offset));
  arc.setAttribute('stroke', AQI_ARC_COLORS[bandId] || AQI_ARC_COLORS.neutral);
}

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
      closeSuggestions();
      setActiveLocation(city);
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
  freshnessEl.textContent = `${metadata.freshness} · Valid ${formatLocalTimestamp(current.timestamp)}`;
  freshnessEl.className = `badge badge-${metadata.freshnessState?.badgeTone || 'teal'}`;

  if (metadata.isStaleFallback && metadata.staleWarning) {
    showErrorBanner('Displaying Stale Cached Data', metadata.staleWarning);
  }

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

  // Circular AQI Centerpiece
  const aqiBox = document.getElementById('aqi-box');
  document.getElementById('aqi-standard-label').textContent = cpcb.isOfficialCpcb
    ? 'Official CPCB AQI'
    : 'CPCB-Derived Est.';
  document.getElementById('aqi-value').textContent = cpcb.aqi !== null ? String(cpcb.aqi) : 'N/A';
  document.getElementById('aqi-band').textContent = cpcb.band?.label || 'Incomplete';
  aqiBox.className = `aqi-centerpiece aqi-${cpcb.band?.id || 'neutral'}`;
  updateAqiGauge(cpcb.aqi, cpcb.band?.id || 'neutral');

  // Immediate Action Callout
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

  // 6-Pollutant Breakdown Widgets
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
      attrs: { title: `${item.label} ${item.avg}: ${valStr}. CPCB sub-index: ${sub ? sub.subIndex : 'N/A'}.` },
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
    `Air Quality Source: ${metadata.provider} (${metadata.gridResolution}, ${metadata.temporalResolution}). Weather Source: ${metadata.weatherProvider}. Retrieved: ${metadata.fetchedAt}.`;
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
  const validPoints = points.filter((p) => typeof p.pm25 === 'number');

  document.getElementById('history-caption').textContent = validPoints.length >= 2
    ? `Modeled hourly PM2.5 over past ${history.pastDays === 1 ? '24 hours' : `${history.pastDays} days`} (${validPoints.length}/${history.expectedHours || points.length} valid hours)`
    : 'Historical records unavailable for the selected range.';

  if (validPoints.length < 2) {
    wrap.appendChild(createSafeElement(document, 'p', {
      className: 'muted-text',
      text: 'Insufficient historical data points returned by upstream API.'
    }));
    return;
  }

  const maxRender = 96;
  const step = Math.max(1, Math.floor(points.length / maxRender));
  const sampled = points.filter((_, idx) => idx % step === 0 || idx === points.length - 1);

  const values = sampled.map((p) => p.pm25).filter((v) => typeof v === 'number');
  const maxVal = Math.max(70, ...values);
  const minVal = Math.min(...values);
  const avgVal = (values.reduce((s, v) => s + v, 0) / values.length).toFixed(1);

  const width = 560;
  const height = 156;
  const padL = 36;
  const padR = 14;
  const padT = 18;
  const padB = 28;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const svg = createSvg('svg', {
    viewBox: `0 0 ${width} ${height}`,
    class: 'chart-svg',
    role: 'img',
    'aria-label': `Historical modeled PM2.5 over past ${history.pastDays} days. Min ${minVal}, average ${avgVal}, max ${maxVal} micrograms per cubic meter. Dashed green line marks WHO 2021 24-hour guideline (15), amber line marks CPCB Satisfactory upper limit (60).`
  });

  const thresholds = [
    { val: 15, color: '#34D399', label: 'WHO 15' },
    { val: 60, color: '#FBBF24', label: 'CPCB 60' }
  ];
  for (const th of thresholds) {
    if (th.val <= maxVal) {
      const ty = padT + plotH - (th.val / maxVal) * plotH;
      svg.appendChild(createSvg('line', {
        x1: padL, y1: ty.toFixed(1), x2: width - padR, y2: ty.toFixed(1),
        stroke: th.color, 'stroke-dasharray': '4 4', 'stroke-width': '1', opacity: '0.6'
      }));
      const tl = createSvg('text', {
        x: width - padR, y: (ty - 3).toFixed(1), 'text-anchor': 'end', fill: th.color, 'font-size': '9'
      });
      tl.textContent = th.label;
      svg.appendChild(tl);
    }
  }

  let currentSegment = [];
  const segments = [];
  sampled.forEach((pt, i) => {
    if (typeof pt.pm25 !== 'number') {
      if (currentSegment.length) {
        segments.push(currentSegment);
        currentSegment = [];
      }
      return;
    }
    const x = Number((padL + (i / Math.max(1, sampled.length - 1)) * plotW).toFixed(1));
    const y = Number((padT + plotH - (pt.pm25 / maxVal) * plotH).toFixed(1));
    currentSegment.push({ x, y, pt });
  });
  if (currentSegment.length) segments.push(currentSegment);

  for (const seg of segments) {
    const ptsStr = seg.map((p) => `${p.x},${p.y}`).join(' ');
    if (seg.length >= 2) {
      svg.appendChild(createSvg('polyline', {
        points: ptsStr,
        fill: 'none',
        stroke: '#2DD4BF',
        'stroke-width': '2',
        'stroke-linejoin': 'round'
      }));
    }
    for (const node of seg) {
      const dot = createSvg('circle', {
        cx: node.x, cy: node.y, r: '2.5', fill: '#2DD4BF', opacity: '0.9'
      });
      const tip = createSvg('title');
      tip.textContent = `${node.pt.time.replace('T', ' ')} — Modeled PM2.5: ${node.pt.pm25} µg/m³`;
      dot.appendChild(tip);
      svg.appendChild(dot);
    }
  }

  const axisLabels = [
    { x: padL - 6, y: padT + 4, anchor: 'end', text: String(Math.round(maxVal)), fill: '#93A4BA' },
    { x: padL - 6, y: padT + plotH, anchor: 'end', text: '0', fill: '#93A4BA' },
    { x: padL, y: height - 6, anchor: 'start', text: sampled[0].time.slice(5, 16).replace('T', ' '), fill: '#93A4BA' },
    { x: width - padR, y: height - 6, anchor: 'end', text: `Min ${minVal} · Avg ${avgVal} · Max ${maxVal} µg/m³`, fill: '#C8D4E3' }
  ];
  for (const l of axisLabels) {
    const t = createSvg('text', { x: l.x, y: l.y, 'text-anchor': l.anchor, fill: l.fill, 'font-size': '10' });
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

  const dayWin = dispersion.bestDaytimeWindow;
  const peakWin = dispersion.peakAccumulationWindow;
  const lowWin = dispersion.lowestPollutionWindow;

  if (dispersion.available && dayWin && peakWin) {
    document.getElementById('best-window-val').textContent = `Daytime: ${dayWin.label}`;
    const overnightTag = lowWin && !lowWin.isDaytime
      ? ` · Overnight min ${lowWin.label} (${lowWin.avgPm25} µg/m³)`
      : '';
    document.getElementById('best-window-note').textContent =
      `${dayWin.projectedText} · ${dayWin.deltaText}${overnightTag}`;

    document.getElementById('worst-window-val').textContent = peakWin.label;
    document.getElementById('worst-window-note').textContent =
      `${peakWin.projectedText} · ${peakWin.deltaText}${peakWin.avgVc ? ` · VC ${peakWin.avgVc.toLocaleString('en-IN')} m²/s` : ''}`;
  } else {
    document.getElementById('best-window-val').textContent = 'Unavailable';
    document.getElementById('worst-window-val').textContent = 'Unavailable';
  }

  document.getElementById('dispersion-methodology-text').textContent = dispersion.methodologyNote;
  document.getElementById('dispersion-confidence-reason').textContent = dispersion.confidence.reason;

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
  const bestStart = dayWin?.startHour;
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
    'aria-label': `Next 24-hour modeled hourly PM2.5 forecast. Best daytime window ${dayWin?.label}, peak window ${peakWin?.label}.`
  });

  hours.forEach((h, idx) => {
    const x = padL + idx * (barW + barGap);
    const bh = Math.max(6, (h.pm25 / maxPm) * plotH);
    const y = padT + plotH - bh;
    const isBestDay = h.isDaytime && (h.hourLabel === bestStart || (dayWin && h.pm25 <= dayWin.avgPm25 * 1.05));
    const fill = isBestDay
      ? '#2DD4BF'
      : h.pm25 > 120
        ? '#F87171'
        : h.pm25 > 60
          ? '#FBBF24'
          : '#38BDF8';

    const bar = createSvg('rect', {
      x: x.toFixed(1),
      y: y.toFixed(1),
      width: barW.toFixed(1),
      height: bh.toFixed(1),
      rx: '2.5',
      fill
    });
    const tip = createSvg('title');
    tip.textContent = `${h.hourLabel} (${h.isDaytime ? 'Daytime' : 'Overnight'}) — Forecast PM2.5: ${h.pm25} µg/m³ · ${h.dispersionCategory}${h.blh ? ` · BLH ${h.blh} m` : ''}`;
    bar.appendChild(tip);
    svg.appendChild(bar);

    if (idx % 4 === 0) {
      const lbl = createSvg('text', {
        x: (x + barW / 2).toFixed(1),
        y: height - 6,
        'text-anchor': 'middle',
        fill: '#93A4BA',
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
    fill: '#93A4BA',
    'font-size': '9.5'
  });
  maxLbl.textContent = String(Math.round(maxPm));
  svg.appendChild(maxLbl);

  chartWrap.appendChild(svg);

  for (let i = 0; i < hours.length; i += 4) {
    const pt = hours[i];
    const row = createSafeElement(document, 'div', {
      className: 'disp-row',
      children: [
        createSafeElement(document, 'span', {
          text: `${pt.hourLabel} · ${pt.dispersionCategory}${pt.blh ? ` (BLH ${pt.blh} m)` : ''}`
        }),
        createSafeElement(document, 'strong', { text: `${pt.pm25} µg/m³` })
      ]
    });
    timeline.appendChild(row);
  }
}

/* ==================== MODULE 4–6: ROUTINE, IAQ LAB & SIMULATOR ==================== */

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
    { label: `Outdoor Modeled (${outdoorPm25} µg/m³)`, val: outdoorPm25, fill: '#FBBF24', y: 12 },
    { label: `Indoor Unfiltered (${evalResult.outcomes.unfilteredIndoorPm25} µg/m³)`, val: evalResult.outcomes.unfilteredIndoorPm25, fill: '#F87171', y: 40 },
    { label: `Indoor Filtered @ ${evalResult.sizing.activeCadrM3h} m³/h (${evalResult.outcomes.filteredIndoorPm25} µg/m³)`, val: evalResult.outcomes.filteredIndoorPm25, fill: '#2DD4BF', y: 68 }
  ];

  for (const r of rows) {
    const labelEl = createSvg('text', { x: '0', y: String(r.y), fill: '#C8D4E3', 'font-size': '10.5' });
    labelEl.textContent = r.label;
    svg.appendChild(labelEl);

    svg.appendChild(createSvg('rect', {
      x: '245', y: String(r.y - 9), width: '310', height: '10', rx: '5', fill: 'rgba(255,255,255,0.08)'
    }));

    const fillW = Math.max(6, Math.round((r.val / maxRef) * 310));
    svg.appendChild(createSvg('rect', {
      x: '245', y: String(r.y - 9), width: String(fillW), height: '10', rx: '5', fill: r.fill
    }));
  }
  barBox.appendChild(svg);

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

  const safetyBox = document.getElementById('iaq-safety-notes');
  clearNode(safetyBox);
  for (const note of evalResult.safetyNotes) {
    safetyBox.appendChild(createSafeElement(document, 'p', { className: 'muted-text', text: note }));
  }
}

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

/* ==================== MODULE 7: MULTI-TURN LIQUID GLASS AI COACH ==================== */

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

function formatCoachPlainText(res) {
  return [
    res.headline,
    '',
    'Telemetry & Facts Used:',
    ...(res.factsUsed || []).map((f) => `- ${f}`),
    '',
    'Recommendations:',
    ...(res.recommendations || []).map((r) => `- ${r}`),
    '',
    `Indoor Guidance: ${res.indoorGuidance || ''}`,
    '',
    'Assumptions & Limits:',
    ...(res.assumptionsAndLimits || []).map((a) => `- ${a}`)
  ].join('\n');
}

function renderCoachThread() {
  const out = document.getElementById('coach-output');
  clearNode(out);

  if (state.coachHistory.length === 0) {
    out.appendChild(createSafeElement(document, 'p', {
      className: 'muted-text',
      text: 'Select a suggested question above or ask anything about current air quality, dispersion windows, or indoor filtration.'
    }));
    return;
  }

  const makeListSection = (title, items) => createSafeElement(document, 'div', {
    children: [
      createSafeElement(document, 'h4', { className: 'coach-section-title', text: title }),
      createSafeElement(document, 'ul', {
        className: 'coach-list',
        children: (items || []).map((t) => createSafeElement(document, 'li', { text: t }))
      })
    ]
  });

  // Render newest turns at the top or chronological bottom — chronological matches familiar chat UX
  for (const turn of state.coachHistory) {
    out.appendChild(createSafeElement(document, 'div', {
      className: 'chat-bubble-user',
      text: turn.question
    }));

    if (turn.loading) {
      out.appendChild(createSafeElement(document, 'div', {
        className: 'coach-card is-loading',
        children: [
          createSafeElement(document, 'p', {
            className: 'muted-text',
            text: `Analyzing live ${state.location.name} telemetry and room physics…`
          })
        ]
      }));
      continue;
    }

    const res = turn.response;
    const copyBtn = createSafeElement(document, 'button', {
      className: 'btn btn-ghost btn-sm',
      text: 'Copy Response',
      attrs: { type: 'button' }
    });
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(formatCoachPlainText(res));
        showToast('Copied AI Coach response.');
      } catch {
        showToast('Clipboard access unavailable in this browser.');
      }
    });

    const retryBtn = createSafeElement(document, 'button', {
      className: 'btn btn-ghost btn-sm',
      text: 'Retry',
      attrs: { type: 'button' }
    });
    retryBtn.addEventListener('click', () => handleCoachSubmit(turn.question));

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
        makeListSection('Assumptions, Uncertainties & Limits', res.assumptionsAndLimits),
        createSafeElement(document, 'div', {
          className: 'coach-card-footer',
          children: [
            createSafeElement(document, 'span', {
              className: `badge ${res.isFallback ? 'badge-warn' : 'badge-teal'}`,
              text: res.engine
            }),
            createSafeElement(document, 'div', {
              className: 'action-group',
              children: [copyBtn, retryBtn]
            })
          ]
        })
      ]
    });
    out.appendChild(card);
  }
}

async function handleCoachSubmit(rawQuestion, options = {}) {
  const question = sanitizeText(rawQuestion, 360) || COACH_PROMPT_TEMPLATES[0].prompt;
  const token = ++state.coachToken;
  const btn = document.getElementById('btn-ask-coach');
  btn.disabled = true;
  btn.textContent = 'Evaluating Telemetry…';

  if (options.resetThread) {
    state.coachHistory = [];
  }

  const turn = { id: token, question, loading: true, response: null };
  state.coachHistory.push(turn);
  // Cap in-memory thread length to keep DOM lean
  if (state.coachHistory.length > 8) {
    state.coachHistory = state.coachHistory.slice(-8);
  }
  renderCoachThread();

  const result = await askVayuShieldCoach({
    question,
    intel: state.intel,
    profile: state.profile,
    indoorEval: state.indoorEval
  });

  if (token !== state.coachToken) return;
  turn.loading = false;
  turn.response = result;

  const badge = document.getElementById('coach-engine-badge');
  badge.textContent = result.engine;
  badge.className = `badge ${result.isFallback ? 'badge-warn' : 'badge-teal'}`;

  renderCoachThread();
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

/* ==================== AUTOCOMPLETE COMBOBOX ==================== */

function closeSuggestions() {
  const list = document.getElementById('search-suggestions');
  const input = document.getElementById('city-search-input');
  state.suggestions = [];
  state.highlightedSuggestion = -1;
  if (list) {
    clearNode(list);
    list.hidden = true;
  }
  input?.setAttribute('aria-expanded', 'false');
}

function renderSuggestions(items, emptyMessage = null) {
  const list = document.getElementById('search-suggestions');
  const input = document.getElementById('city-search-input');
  clearNode(list);

  if (!items.length) {
    if (emptyMessage) {
      list.appendChild(createSafeElement(document, 'li', {
        className: 'muted-text',
        attrs: { role: 'option', 'aria-disabled': 'true' },
        text: emptyMessage
      }));
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
    } else {
      closeSuggestions();
    }
    return;
  }

  items.forEach((loc, idx) => {
    const btn = createSafeElement(document, 'button', {
      className: `suggestion-item${idx === state.highlightedSuggestion ? ' is-highlighted' : ''}`,
      attrs: { type: 'button', role: 'option', 'aria-selected': String(idx === state.highlightedSuggestion) },
      children: [
        createSafeElement(document, 'strong', { text: loc.name }),
        createSafeElement(document, 'span', { className: 'muted-text', text: loc.region })
      ]
    });
    btn.addEventListener('click', () => {
      input.value = '';
      document.getElementById('btn-clear-search').hidden = true;
      closeSuggestions();
      setActiveLocation(loc);
      loadLocationIntelligence();
      showToast(`Loaded modeled atmospheric data for ${loc.name}.`);
    });
    list.appendChild(createSafeElement(document, 'li', { children: [btn] }));
  });

  list.hidden = false;
  input.setAttribute('aria-expanded', 'true');
}

/* ==================== ORCHESTRATION & EVENTS ==================== */

function renderDependentModules() {
  renderIndoorLab();
  renderRoutine();
  renderImpactSimulator();
}

async function loadLocationIntelligence(forceRefresh = false) {
  const token = ++state.fetchToken;
  setLoadingState(true);
  hideErrorBanner();

  try {
    const intel = await fetchAirIntelligence(state.location, {
      pastDays: state.pastDays,
      forceRefresh
    });
    if (token !== state.fetchToken) return;
    state.intel = intel;
    renderLiveIntelligence();
    renderDispersionModule();
    renderDependentModules();
    const initialQ = COACH_PROMPT_TEMPLATES[0].prompt;
    handleCoachSubmit(initialQ, { resetThread: true });
  } catch (err) {
    if (token !== state.fetchToken) return;
    showErrorBanner(
      `Live atmospheric data unavailable for ${state.location.name}`,
      `${err?.message || 'Upstream telemetry request failed.'} VayuShield does not substitute data from another city.`
    );
    document.getElementById('freshness-badge').textContent = 'Unavailable';
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

function initNavSync() {
  const links = Array.from(document.querySelectorAll('.header-nav .nav-link, .mobile-bottom-nav .dock-link'));
  const setActiveHref = (href) => {
    links.forEach((link) => {
      link.classList.toggle('is-active', link.getAttribute('href') === href);
    });
  };
  links.forEach((link) => {
    link.addEventListener('click', () => setActiveHref(link.getAttribute('href')));
  });
}

function initEvents() {
  const searchInput = document.getElementById('city-search-input');
  const clearSearchBtn = document.getElementById('btn-clear-search');

  searchInput.addEventListener('input', () => {
    const val = sanitizeText(searchInput.value, 80);
    clearSearchBtn.hidden = val.length === 0;
    clearTimeout(state.searchDebounceTimer);

    if (val.length < 2) {
      closeSuggestions();
      return;
    }

    state.searchDebounceTimer = setTimeout(async () => {
      const seq = ++state.searchSeq;
      try {
        const matches = await searchCitySuggestions(val);
        if (seq !== state.searchSeq) return;
        state.suggestions = matches;
        state.highlightedSuggestion = -1;
        renderSuggestions(matches, matches.length === 0 ? `No matching locations found for "${val}"` : null);
      } catch {
        if (seq === state.searchSeq) closeSuggestions();
      }
    }, 280);
  });

  searchInput.addEventListener('keydown', (e) => {
    if (!state.suggestions.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      state.highlightedSuggestion = (state.highlightedSuggestion + 1) % state.suggestions.length;
      renderSuggestions(state.suggestions);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      state.highlightedSuggestion = (state.highlightedSuggestion - 1 + state.suggestions.length) % state.suggestions.length;
      renderSuggestions(state.suggestions);
    } else if (e.key === 'Escape') {
      closeSuggestions();
    } else if (e.key === 'Enter' && state.highlightedSuggestion >= 0) {
      e.preventDefault();
      const chosen = state.suggestions[state.highlightedSuggestion];
      searchInput.value = '';
      clearSearchBtn.hidden = true;
      closeSuggestions();
      setActiveLocation(chosen);
      loadLocationIntelligence();
      showToast(`Loaded modeled atmospheric data for ${chosen.name}.`);
    }
  });

  clearSearchBtn.addEventListener('click', () => {
    searchInput.value = '';
    clearSearchBtn.hidden = true;
    closeSuggestions();
    searchInput.focus();
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-shell')) closeSuggestions();
  });

  document.getElementById('city-search-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const query = sanitizeText(searchInput.value, 80);
    if (query.length < 2) return;
    closeSuggestions();

    const btn = document.getElementById('btn-search-city');
    btn.disabled = true;
    try {
      const match = await geocodeCity(query);
      if (!match) {
        showToast(`No geographic match found for "${query}". Try a city or district name.`);
        return;
      }
      searchInput.value = '';
      clearSearchBtn.hidden = true;
      setActiveLocation(match);
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
        setActiveLocation({
          name: 'Detected Coordinates',
          region: 'Local Modeled Grid',
          lat: Number(pos.coords.latitude.toFixed(4)),
          lon: Number(pos.coords.longitude.toFixed(4))
        }, { persist: false });
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
    loadLocationIntelligence(true);
    showToast('Refreshing live atmospheric telemetry.');
  });

  document.getElementById('btn-retry-fetch').addEventListener('click', () => {
    loadLocationIntelligence(true);
  });

  document.getElementById('btn-share-summary').addEventListener('click', async () => {
    if (!state.intel) return;
    const { location, cpcb, dispersion, metadata } = state.intel;
    const summary = [
      `VayuShield Environmental Summary — ${location.name}, ${location.region}`,
      `CPCB-Derived Est. AQI: ${cpcb.aqi ?? 'N/A'} (${cpcb.band?.label || 'Incomplete'}) · Primary: ${cpcb.primaryPollutant?.name || 'N/A'}`,
      dispersion.bestDaytimeWindow ? `Best Practical Daytime Window: ${dispersion.bestDaytimeWindow.label} (Projected PM2.5: ${dispersion.bestDaytimeWindow.avgPm25} µg/m³)` : '',
      `Source: ${metadata.provider} (${metadata.gridResolution})`
    ].filter(Boolean).join('\n');

    try {
      if (navigator.share) {
        await navigator.share({ title: `VayuShield — ${location.name}`, text: summary });
      } else {
        await navigator.clipboard.writeText(summary);
        showToast('Copied non-sensitive air quality summary.');
      }
    } catch {
      showToast('Share cancelled or clipboard unavailable.');
    }
  });

  document.getElementById('btn-export-csv').addEventListener('click', () => {
    if (!state.intel?.history?.points?.length) {
      showToast('No historical telemetry available to export.');
      return;
    }
    const csv = buildHistoricalCsv(state.intel);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const slug = state.intel.location.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 32) || 'location';
    const link = createSafeElement(document, 'a', {
      attrs: { href: url, download: `vayushield-${slug}-${state.pastDays}d.csv` }
    });
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast(`Exported ${state.pastDays}d modeled PM2.5 dataset as CSV.`);
  });

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

  [
    'profile-household', 'profile-commute', 'profile-km', 'profile-cooking',
    'profile-budget', 'profile-room', 'profile-ceiling', 'profile-leakage'
  ].forEach((id) => document.getElementById(id).addEventListener('change', handleProfileChange));

  document.getElementById('btn-reset-profile').addEventListener('click', () => {
    state.profile = normalizeProfile();
    state.customAch = null;
    state.customCadr = null;
    saveJson(STORAGE_PROFILE_KEY, state.profile);
    syncProfileInputs();
    document.getElementById('profile-status').textContent = 'Defaults restored';
    renderDependentModules();
    showToast('Household parameters reset to defaults.');
  });

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
    const input = document.getElementById('coach-input');
    const q = input.value;
    input.value = '';
    handleCoachSubmit(q);
  });

  document.getElementById('btn-clear-chat').addEventListener('click', () => {
    state.coachHistory = [];
    renderCoachThread();
    showToast('Cleared AI Coach conversation thread.');
  });

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
initNavSync();
initEvents();
renderCityPresets();
renderCoachTemplates();
renderCommunity();
loadLocationIntelligence();