/**
 * @fileoverview Live Air Intelligence renderer: AQI gauge, city presets,
 * 8-pollutant CPCB bento grid, provenance disclosures, and historical PM2.5 SVG chart.
 */

import { compareToWhoGuideline } from '../core/cpcbAqi.js';
import { calculateMortalityRiskHeuristic } from '../core/impactModel.js';
import { buildImmediateAction } from '../core/routineEngine.js';
import { clearNode, createSafeElement } from '../core/security.js';
import { CURATED_CITIES } from '../services/airQualityService.js';
import { createSvg, formatCoord, formatLocalTimestamp, showErrorBanner } from './domHelpers.js';

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
const TREND_ARROWS = Object.freeze({ rising: '↑ Rising', falling: '↓ Falling', steady: '→ Steady' });

/**
 * Updates the semicircular AQI SVG arc offset and color token.
 * @param {number | null} aqi
 * @param {string} bandId
 * @returns {void}
 */
export function updateAqiGauge(aqi, bandId) {
  const arc = document.getElementById('aqi-arc-fill');
  if (!arc) return;
  const ratio = typeof aqi === 'number' && Number.isFinite(aqi) ? Math.max(0.04, Math.min(1, aqi / 500)) : 0;
  arc.setAttribute('stroke-dashoffset', String(Number((AQI_ARC_LENGTH * (1 - ratio)).toFixed(1))));
  arc.setAttribute('stroke', AQI_ARC_COLORS[bandId] || AQI_ARC_COLORS.neutral);
}

/**
 * Renders quick-switch curated city preset buttons.
 * @param {Record<string, any>} state
 * @param {(city: Record<string, any>) => void} onSelectCity
 * @returns {void}
 */
export function renderCityPresets(state, onSelectCity) {
  const container = document.getElementById('city-presets');
  clearNode(container);

  for (const city of CURATED_CITIES) {
    const isActive = state.location.name.toLowerCase() === city.name.toLowerCase();
    const btn = createSafeElement(document, 'button', {
      className: `chip-btn${isActive ? ' is-active' : ''}`,
      text: city.name,
      attrs: { type: 'button', 'aria-pressed': String(isActive) }
    });
    btn.addEventListener('click', () => onSelectCity(city));
    container.appendChild(btn);
  }
}

function renderHeaderAndBadges(intel, profile) {
  const { location, current, rollingAverages, cpcb, dispersion, metadata } = intel;
  document.getElementById('source-type-badge').textContent = `Modeled · ${metadata.gridResolution}`;

  const freshnessEl = document.getElementById('freshness-badge');
  freshnessEl.textContent = `${metadata.freshness} · Valid ${formatLocalTimestamp(current.timestamp)}`;
  freshnessEl.className = `badge badge-${metadata.freshnessState?.badgeTone || 'teal'}`;
  if (metadata.isStaleFallback && metadata.staleWarning) {
    showErrorBanner('Displaying Stale Cached Data', metadata.staleWarning);
  }

  const trendEl = document.getElementById('trend-badge');
  trendEl.textContent = dispersion.available
    ? `6h Trend: ${dispersion.trend} (${dispersion.trendDeltaPct >= 0 ? '+' : ''}${dispersion.trendDeltaPct}%)`
    : 'Trend: Unavailable';
  trendEl.className = `badge ${dispersion.trend === 'improving' ? 'badge-good' : dispersion.trend === 'worsening' ? 'badge-alert' : 'badge-neutral'}`;

  document.getElementById('city-heading').textContent = `${location.name}, ${location.region}`;
  document.getElementById('location-meta').textContent =
    `${formatCoord(location.lat, 'N', 'S')}, ${formatCoord(location.lon, 'E', 'W')} · Timezone: ${location.timezone}`;

  const bandId = cpcb.band?.id || 'neutral';
  document.getElementById('aqi-standard-label').textContent = cpcb.isOfficialCpcb ? 'Official CPCB AQI' : 'CPCB-Derived Est.';
  document.getElementById('aqi-value').textContent = cpcb.aqi !== null ? String(cpcb.aqi) : 'N/A';
  document.getElementById('aqi-band').textContent = cpcb.band?.label || 'Incomplete';
  document.getElementById('aqi-box').className = `aqi-centerpiece aqi-${bandId}`;
  updateAqiGauge(cpcb.aqi, bandId);

  const immediate = buildImmediateAction(intel, profile);
  document.getElementById('immediate-action').className = `action-callout action-${immediate.level}`;
  document.getElementById('action-headline').textContent = immediate.headline;
  document.getElementById('action-detail').textContent = immediate.detail;

  const primary = cpcb.primaryPollutant;
  document.getElementById('primary-pollutant-line').textContent = primary
    ? `Primary concern: ${primary.name} (${primary.concentration} ${primary.unit}, ${primary.averaging} mean → sub-index ${primary.subIndex})`
    : 'Primary concern: Insufficient valid pollutant readings';

  const whoPm25 = compareToWhoGuideline('pm25', rollingAverages.pm25_24h);
  const whoBadge = document.getElementById('who-ratio-badge');
  whoBadge.textContent = whoPm25
    ? (whoPm25.exceeds ? `${whoPm25.ratio}× WHO 2021 24h PM2.5 (${whoPm25.guidelineValue} ${whoPm25.unit})` : `Within WHO 2021 24h PM2.5 (${whoPm25.guidelineValue} ${whoPm25.unit})`)
    : 'WHO 2021 comparison unavailable';
  whoBadge.className = `badge ${whoPm25 ? (whoPm25.exceeds ? 'badge-warn' : 'badge-good') : 'badge-neutral'}`;
}

function buildPollutantList(rolling, current, trends) {
  return [
    { key: 'pm25', label: 'PM2.5', unit: 'µg/m³', avg: '24h', val: rolling.pm25_24h, cur: current.pm25, trend: trends?.pm25 },
    { key: 'pm10', label: 'PM10', unit: 'µg/m³', avg: '24h', val: rolling.pm10_24h, cur: current.pm10, trend: trends?.pm10 },
    { key: 'no2', label: 'NO₂', unit: 'µg/m³', avg: '24h', val: rolling.no2_24h, cur: current.no2, trend: trends?.no2 },
    { key: 'so2', label: 'SO₂', unit: 'µg/m³', avg: '24h', val: rolling.so2_24h, cur: current.so2, trend: trends?.so2 },
    { key: 'o3', label: 'O₃', unit: 'µg/m³', avg: '8h', val: rolling.o3_8h, cur: current.o3, trend: trends?.o3 },
    { key: 'co', label: 'CO', unit: 'mg/m³', avg: '8h', val: rolling.coMg_8h, cur: current.coMg, trend: trends?.co },
    { key: 'nh3', label: 'NH₃', unit: 'µg/m³', avg: '24h', val: null, cur: null, unsupportedReason: 'Not in CAMS model' },
    { key: 'pb', label: 'Pb', unit: 'µg/m³', avg: '24h', val: null, cur: null, unsupportedReason: 'Not in CAMS model' }
  ];
}

function renderPollutantGrid(intel) {
  const grid = document.getElementById('pollutant-grid');
  clearNode(grid);
  const { current, rollingAverages, pollutantTrends, cpcb } = intel;
  const subByKey = new Map(cpcb.subIndices.map((s) => [s.pollutant, s]));
  const primary = cpcb.primaryPollutant;

  for (const item of buildPollutantList(rollingAverages, current, pollutantTrends)) {
    const sub = subByKey.get(item.key);
    const isPrimary = Boolean(primary && primary.pollutant === item.key);
    const isUnavailable = item.val === null || item.val === undefined;
    const valStr = !isUnavailable ? `${item.val} ${item.unit}` : 'Unavailable';
    const decimals = item.key === 'co' ? 2 : 1;
    const subText = item.unsupportedReason
      || (isPrimary ? `Now: ${Number(item.cur).toFixed(decimals)} · Primary`
        : item.cur !== null && item.cur !== undefined
          ? `Now: ${Number(item.cur).toFixed(decimals)} ${TREND_ARROWS[item.trend] || ''}`.trim()
          : 'No valid reading');

    grid.appendChild(createSafeElement(document, 'div', {
      className: `pollutant-cell${isPrimary ? ' is-primary' : ''}${isUnavailable ? ' is-unavailable' : ''}`,
      attrs: {
        title: item.unsupportedReason
          ? `${item.label}: ${item.unsupportedReason} (requires ground CAAQMS station).`
          : `${item.label} (${item.avg} mean): ${valStr}. CPCB sub-index: ${sub ? sub.subIndex : 'N/A'}.`
      },
      children: [
        createSafeElement(document, 'div', {
          className: 'pollutant-head',
          children: [
            createSafeElement(document, 'span', { text: `${item.label} (${item.avg})` }),
            createSafeElement(document, 'span', { text: sub ? `SI ${sub.subIndex}` : 'N/A' })
          ]
        }),
        createSafeElement(document, 'strong', { className: 'pollutant-val', text: valStr }),
        createSafeElement(document, 'span', { className: 'pollutant-sub', text: subText })
      ]
    }));
  }
}

function renderProvenanceMeta(intel) {
  const { rollingAverages, cpcb, metadata } = intel;
  const yestNote = typeof rollingAverages.yesterdayPm25_24h === 'number'
    ? ` Prior 24h (Yesterday) PM2.5 mean: ${rollingAverages.yesterdayPm25_24h} µg/m³.` : '';

  document.getElementById('meta-provider-line').textContent =
    `Air Quality Source: ${metadata.provider} (${metadata.gridResolution}, ${metadata.temporalResolution}). Weather Source: ${metadata.weatherProvider}. Retrieved: ${metadata.fetchedAt}.${yestNote}`;
  document.getElementById('meta-averaging-line').textContent =
    `${cpcb.methodologyLabel}. ${metadata.averagingNote} NH₃ and Pb require ground monitoring stations.`;

  const heuristic = calculateMortalityRiskHeuristic(rollingAverages.pm25_24h);
  document.getElementById('meta-heuristic-line').textContent = heuristic
    ? `Mortality Risk Context (${heuristic.source}): ~${heuristic.cigaretteEquivalentPerDay} cigarettes/day equivalent. ${heuristic.caveat}`
    : 'Mortality risk heuristic requires a valid 24-hr PM2.5 rolling average.';

  const caveatList = document.getElementById('meta-caveats-list');
  clearNode(caveatList);
  for (const caveat of cpcb.caveats) {
    caveatList.appendChild(createSafeElement(document, 'li', { text: caveat }));
  }
}

function drawHistoryThresholds(svg, dims, maxVal) {
  const thresholds = [{ val: 15, color: '#34D399', label: 'WHO 15' }, { val: 60, color: '#FBBF24', label: 'CPCB 60' }];
  for (const th of thresholds) {
    if (th.val > maxVal) continue;
    const ty = dims.padT + dims.plotH - (th.val / maxVal) * dims.plotH;
    svg.appendChild(createSvg('line', {
      x1: dims.padL, y1: ty.toFixed(1), x2: dims.width - dims.padR, y2: ty.toFixed(1),
      stroke: th.color, 'stroke-dasharray': '4 4', 'stroke-width': '1', opacity: '0.6'
    }));
    const lbl = createSvg('text', { x: dims.width - dims.padR, y: (ty - 3).toFixed(1), 'text-anchor': 'end', fill: th.color, 'font-size': '9' });
    lbl.textContent = th.label;
    svg.appendChild(lbl);
  }
}

function drawHistorySeries(svg, sampled, dims, maxVal) {
  const segments = [];
  let current = [];
  sampled.forEach((pt, idx) => {
    if (typeof pt.pm25 !== 'number') {
      if (current.length) { segments.push(current); current = []; }
      return;
    }
    const x = Number((dims.padL + (idx / Math.max(1, sampled.length - 1)) * dims.plotW).toFixed(1));
    const y = Number((dims.padT + dims.plotH - (pt.pm25 / maxVal) * dims.plotH).toFixed(1));
    current.push({ x, y, pt });
  });
  if (current.length) segments.push(current);

  for (const seg of segments) {
    if (seg.length >= 2) {
      svg.appendChild(createSvg('polyline', {
        points: seg.map((p) => `${p.x},${p.y}`).join(' '),
        fill: 'none', stroke: '#2DD4BF', 'stroke-width': '2', 'stroke-linejoin': 'round'
      }));
    }
    for (const node of seg) {
      const dot = createSvg('circle', { cx: node.x, cy: node.y, r: '2.5', fill: '#2DD4BF', opacity: '0.9' });
      const tip = createSvg('title');
      tip.textContent = `${node.pt.time.replace('T', ' ')} — Modeled PM2.5: ${node.pt.pm25} µg/m³`;
      dot.appendChild(tip);
      svg.appendChild(dot);
    }
  }
}

/**
 * Renders the historical 24h/7d/30d modeled PM2.5 SVG trend chart.
 * @param {Record<string, any> | null} intel
 * @returns {void}
 */
export function renderHistoryChart(intel) {
  const wrap = document.getElementById('history-chart-wrap');
  clearNode(wrap);
  const history = intel?.history;
  const points = history?.points || [];
  const validPoints = points.filter((p) => typeof p.pm25 === 'number');

  document.getElementById('history-caption').textContent = validPoints.length >= 2
    ? `Modeled hourly PM2.5 over past ${history.pastDays === 1 ? '24 hours' : `${history.pastDays} days`} (${validPoints.length}/${history.expectedHours || points.length} valid hours)`
    : 'Historical records unavailable for the selected range.';

  if (validPoints.length < 2) {
    wrap.appendChild(createSafeElement(document, 'p', { className: 'muted-text', text: 'Insufficient historical data points returned by upstream API.' }));
    return;
  }

  const step = Math.max(1, Math.floor(points.length / 96));
  const sampled = points.filter((_, idx) => idx % step === 0 || idx === points.length - 1);
  const values = sampled.map((p) => p.pm25).filter((v) => typeof v === 'number');
  const maxVal = Math.max(70, ...values);
  const minVal = Math.min(...values);
  const avgVal = (values.reduce((s, v) => s + v, 0) / values.length).toFixed(1);
  const dims = { width: 560, height: 156, padL: 36, padR: 14, padT: 18, padB: 28, plotW: 510, plotH: 110 };

  const svg = createSvg('svg', {
    viewBox: `0 0 ${dims.width} ${dims.height}`,
    class: 'chart-svg',
    role: 'img',
    'aria-label': `Historical modeled PM2.5 over past ${history.pastDays} days. Min ${minVal}, average ${avgVal}, max ${maxVal} micrograms per cubic meter. Dashed green line marks WHO 2021 24-hour guideline (15), amber line marks CPCB Satisfactory upper limit (60).`
  });

  drawHistoryThresholds(svg, dims, maxVal);
  drawHistorySeries(svg, sampled, dims, maxVal);

  const axisLabels = [
    { x: dims.padL - 6, y: dims.padT + 4, anchor: 'end', text: String(Math.round(maxVal)), fill: '#93A4BA' },
    { x: dims.padL - 6, y: dims.padT + dims.plotH, anchor: 'end', text: '0', fill: '#93A4BA' },
    { x: dims.padL, y: dims.height - 6, anchor: 'start', text: sampled[0].time.slice(5, 16).replace('T', ' '), fill: '#93A4BA' },
    { x: dims.width - dims.padR, y: dims.height - 6, anchor: 'end', text: `Min ${minVal} · Avg ${avgVal} · Max ${maxVal} µg/m³`, fill: '#CBD6E4' }
  ];
  for (const lbl of axisLabels) {
    const t = createSvg('text', { x: lbl.x, y: lbl.y, 'text-anchor': lbl.anchor, fill: lbl.fill, 'font-size': '10' });
    t.textContent = lbl.text;
    svg.appendChild(t);
  }
  wrap.appendChild(svg);
}

/**
 * Renders the full Module 1 Live Air Intelligence dashboard section.
 * @param {Record<string, any>} state
 * @param {(city: Record<string, any>) => void} onSelectCity
 * @returns {void}
 */
export function renderLiveIntelligence(state, onSelectCity) {
  if (!state.intel) return;
  renderHeaderAndBadges(state.intel, state.profile);
  renderPollutantGrid(state.intel);
  renderProvenanceMeta(state.intel);
  renderHistoryChart(state.intel);
  renderCityPresets(state, onSelectCity);
}