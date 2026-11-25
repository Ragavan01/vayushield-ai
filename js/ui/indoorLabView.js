/**
 * @fileoverview Daily Routine, Indoor Air Quality Physics Lab (SVG Room Blueprint &
 * CADR Performance Curve), and Personal Impact Simulator UI renderers.
 */

import { evaluateSelectedScenarios } from '../core/impactModel.js';
import { evaluateIndoorFiltration } from '../core/indoorPhysics.js';
import { buildIntelligentRoutine } from '../core/routineEngine.js';
import { clearNode, createSafeElement } from '../core/security.js';
import {
  createSvg,
  getField,
  getOutdoorPm25WithProvenance,
  REFERENCE_DESIGN_PM25,
  saveJson,
  STORAGE_KEYS
} from './domHelpers.js';

function appendSvgText(svg, attrs, text) {
  const el = createSvg('text', attrs);
  el.textContent = text;
  svg.appendChild(el);
}

/**
 * Renders the personalized conditional daily schedule.
 * @param {Record<string, any>} state
 * @returns {void}
 */
export function renderRoutine(state) {
  const list = document.getElementById('routine-list');
  clearNode(list);
  if (!state.intel || !state.indoorEval) return;

  for (const step of buildIntelligentRoutine(state.intel, state.profile, state.indoorEval)) {
    list.appendChild(createSafeElement(document, 'li', {
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
    }));
  }
}

function renderRoomBlueprint(evalResult) {
  const host = document.getElementById('iaq-room-blueprint');
  clearNode(host);
  const { dimensions, assumptions, sizing, outcomes } = evalResult;
  const svg = createSvg('svg', {
    viewBox: '0 0 360 165',
    class: 'chart-svg',
    role: 'img',
    'aria-label': `Room mass balance diagram: ${dimensions.floorAreaSqFt} square feet, ${dimensions.volumeM3} cubic meters, outdoor ${assumptions.outdoorPm25}, filtered indoor ${outcomes.filteredIndoorPm25} micrograms per cubic meter.`
  });

  svg.appendChild(createSvg('rect', { x: '6', y: '22', width: '78', height: '116', rx: '8', fill: 'rgba(251,191,36,0.1)', stroke: 'rgba(251,191,36,0.45)', 'stroke-dasharray': '4 3' }));
  appendSvgText(svg, { x: '45', y: '56', 'text-anchor': 'middle', fill: '#FDE68A', 'font-size': '9.5' }, 'OUTDOOR');
  appendSvgText(svg, { x: '45', y: '74', 'text-anchor': 'middle', fill: '#F5F8FC', 'font-size': '12', 'font-weight': '700' }, String(assumptions.outdoorPm25));
  appendSvgText(svg, { x: '45', y: '88', 'text-anchor': 'middle', fill: '#93A4BA', 'font-size': '8.5' }, 'µg/m³ PM2.5');
  appendSvgText(svg, { x: '45', y: '116', 'text-anchor': 'middle', fill: '#FBBF24', 'font-size': '8.5' }, `Inf. ${assumptions.infiltrationAch} ACH`);

  svg.appendChild(createSvg('line', { x1: '86', y1: '80', x2: '108', y2: '80', stroke: '#FBBF24', 'stroke-width': '2' }));
  svg.appendChild(createSvg('polygon', { points: '108,76 116,80 108,84', fill: '#FBBF24' }));
  svg.appendChild(createSvg('rect', { x: '118', y: '20', width: '234', height: '120', rx: '12', fill: 'rgba(45,212,191,0.07)', stroke: 'rgba(45,212,191,0.55)', 'stroke-width': '1.5' }));

  appendSvgText(svg, { x: '235', y: '37', 'text-anchor': 'middle', fill: '#93A4BA', 'font-size': '9.5' }, `${dimensions.floorAreaSqFt} sq.ft × ${dimensions.ceilingHeightFt} ft · Vol ${dimensions.volumeM3} m³`);
  appendSvgText(svg, { x: '198', y: '78', 'text-anchor': 'middle', fill: '#2DD4BF', 'font-size': '20', 'font-weight': '700' }, `${outcomes.filteredIndoorPm25} µg/m³`);
  appendSvgText(svg, { x: '198', y: '95', 'text-anchor': 'middle', fill: '#CBD6E4', 'font-size': '9' }, `Steady Indoor (-${outcomes.reductionPct}% vs ${outcomes.unfilteredIndoorPm25})`);

  svg.appendChild(createSvg('rect', { x: '278', y: '56', width: '62', height: '72', rx: '8', fill: 'rgba(56,189,248,0.16)', stroke: '#38BDF8', 'stroke-width': '1.2' }));
  appendSvgText(svg, { x: '309', y: '76', 'text-anchor': 'middle', fill: '#7DD3FC', 'font-size': '8.5', 'font-weight': '700' }, assumptions.inputMode === 'airflow' ? 'DIY FAN' : 'HEPA');
  appendSvgText(svg, { x: '309', y: '94', 'text-anchor': 'middle', fill: '#F5F8FC', 'font-size': '10.5', 'font-weight': '700' }, String(sizing.effectiveCadrM3h));
  appendSvgText(svg, { x: '309', y: '108', 'text-anchor': 'middle', fill: '#93A4BA', 'font-size': '8' }, 'm³/h eff.');
  appendSvgText(svg, { x: '309', y: '121', 'text-anchor': 'middle', fill: '#2DD4BF', 'font-size': '8' }, `${sizing.effectiveFiltrationAch} eACH`);
  appendSvgText(svg, { x: '235', y: '156', 'text-anchor': 'middle', fill: '#93A4BA', 'font-size': '8.8' }, `Sources: ${assumptions.indoorSourceLabel} · Dep. ${assumptions.depositionAch}/h`);

  host.appendChild(svg);
}

function drawCadrThresholds(svg, dims, maxPm) {
  for (const th of [{ val: 15, color: '#34D399', lbl: 'WHO 15' }, { val: 60, color: '#FBBF24', lbl: 'CPCB 60' }]) {
    if (th.val > maxPm) continue;
    const ty = dims.padT + dims.plotH - (th.val / maxPm) * dims.plotH;
    svg.appendChild(createSvg('line', {
      x1: dims.padL, y1: ty.toFixed(1), x2: dims.width - dims.padR, y2: ty.toFixed(1),
      stroke: th.color, 'stroke-dasharray': '3 3', 'stroke-width': '1', opacity: '0.55'
    }));
    appendSvgText(svg, { x: dims.width - dims.padR, y: (ty - 3).toFixed(1), 'text-anchor': 'end', fill: th.color, 'font-size': '8.5' }, th.lbl);
  }
}

function drawCadrAxes(svg, dims, maxPm, maxCadr, activeCadr) {
  const labels = [
    { x: dims.padL - 6, y: dims.padT + 4, anchor: 'end', text: String(Math.round(maxPm)) },
    { x: dims.padL - 6, y: dims.padT + dims.plotH, anchor: 'end', text: '0' },
    { x: dims.padL, y: dims.height - 8, anchor: 'start', text: '0 m³/h' },
    { x: dims.padL + dims.plotW / 2, y: dims.height - 8, anchor: 'middle', text: `Active: ${activeCadr} m³/h` },
    { x: dims.width - dims.padR, y: dims.height - 8, anchor: 'end', text: `${maxCadr} m³/h` }
  ];
  for (const l of labels) {
    appendSvgText(svg, { x: l.x, y: l.y, 'text-anchor': l.anchor, fill: '#93A4BA', 'font-size': '9.5' }, l.text);
  }
}

function renderCadrCurveChart(evalResult) {
  const host = document.getElementById('iaq-curve-chart');
  clearNode(host);
  const curve = evalResult.cadrCurve || [];
  if (curve.length < 2) return;

  const dims = { width: 410, height: 165, padL: 36, padR: 16, padT: 16, plotW: 358, plotH: 119 };
  const maxPm = Math.max(70, ...curve.map((c) => c.indoorPm25));
  const maxCadr = curve[curve.length - 1].cadrM3h || 600;
  const svg = createSvg('svg', {
    viewBox: `0 0 ${dims.width} ${dims.height}`,
    class: 'chart-svg',
    role: 'img',
    'aria-label': `CADR performance curve from 0 to ${maxCadr} cubic meters per hour. Active effective CADR ${evalResult.sizing.effectiveCadrM3h} yields ${evalResult.outcomes.filteredIndoorPm25} micrograms per cubic meter.`
  });

  drawCadrThresholds(svg, dims, maxPm);
  const coords = curve.map((pt) => ({
    x: Number((dims.padL + (pt.cadrM3h / maxCadr) * dims.plotW).toFixed(1)),
    y: Number((dims.padT + dims.plotH - (pt.indoorPm25 / maxPm) * dims.plotH).toFixed(1)),
    pt
  }));
  svg.appendChild(createSvg('polyline', {
    points: coords.map((c) => `${c.x},${c.y}`).join(' '),
    fill: 'none', stroke: '#38BDF8', 'stroke-width': '2.2', 'stroke-linejoin': 'round'
  }));

  for (const node of coords) {
    const dot = createSvg('circle', { cx: node.x, cy: node.y, r: '3', fill: '#38BDF8' });
    const tip = createSvg('title');
    tip.textContent = `Eff. CADR ${node.pt.cadrM3h} m³/h (${node.pt.effectiveAch} eACH) → Indoor PM2.5: ${node.pt.indoorPm25} µg/m³`;
    dot.appendChild(tip);
    svg.appendChild(dot);
  }

  const ax = dims.padL + (Math.min(maxCadr, evalResult.sizing.effectiveCadrM3h) / maxCadr) * dims.plotW;
  const ay = dims.padT + dims.plotH - (Math.min(maxPm, evalResult.outcomes.filteredIndoorPm25) / maxPm) * dims.plotH;
  const activeDot = createSvg('circle', { cx: ax.toFixed(1), cy: ay.toFixed(1), r: '5', fill: '#2DD4BF', stroke: '#050810', 'stroke-width': '1.5' });
  const activeTip = createSvg('title');
  activeTip.textContent = `Current Setting: ${evalResult.sizing.effectiveCadrM3h} m³/h effective CADR → ${evalResult.outcomes.filteredIndoorPm25} µg/m³`;
  activeDot.appendChild(activeTip);
  svg.appendChild(activeDot);

  drawCadrAxes(svg, dims, maxPm, maxCadr, evalResult.sizing.effectiveCadrM3h);
  host.appendChild(svg);
}

function renderIndoorComparisonBars(evalResult, outdoorPm25, isReferenceFallback) {
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
    { label: `${isReferenceFallback ? 'Ref. Outdoor' : 'Outdoor Modeled'} (${outdoorPm25} µg/m³)`, val: outdoorPm25, fill: '#FBBF24', y: 12 },
    { label: `Indoor Unfiltered (${evalResult.outcomes.unfilteredIndoorPm25} µg/m³)`, val: evalResult.outcomes.unfilteredIndoorPm25, fill: '#F87171', y: 40 },
    { label: `Indoor Filtered @ ${evalResult.sizing.effectiveCadrM3h} m³/h eff. (${evalResult.outcomes.filteredIndoorPm25} µg/m³)`, val: evalResult.outcomes.filteredIndoorPm25, fill: '#2DD4BF', y: 68 }
  ];

  for (const r of rows) {
    appendSvgText(svg, { x: '0', y: String(r.y), fill: '#CBD6E4', 'font-size': '10.5' }, r.label);
    svg.appendChild(createSvg('rect', { x: '250', y: String(r.y - 9), width: '305', height: '10', rx: '5', fill: 'rgba(255,255,255,0.08)' }));
    svg.appendChild(createSvg('rect', { x: '250', y: String(r.y - 9), width: String(Math.max(6, Math.round((r.val / maxRef) * 305))), height: '10', rx: '5', fill: r.fill }));
  }
  barBox.appendChild(svg);
}

function renderFiltrationTiersAndNotes(evalResult, budgetTier) {
  const tiersGrid = document.getElementById('iaq-tiers-grid');
  clearNode(tiersGrid);
  for (const tier of evalResult.tiers) {
    const isSelected = tier.id === budgetTier;
    tiersGrid.appendChild(createSafeElement(document, 'article', {
      className: 'subpanel',
      children: [
        createSafeElement(document, 'div', {
          className: 'provenance-row',
          children: [
            createSafeElement(document, 'span', { className: isSelected ? 'badge badge-teal' : 'badge badge-neutral', text: isSelected ? 'Selected Budget Tier' : tier.estimatedCostInr }),
            createSafeElement(document, 'span', { className: 'badge badge-neutral', text: tier.cadrM3h > 0 ? `Est. CADR ${tier.cadrM3h} m³/h` : 'Source / Sealing Control' })
          ]
        }),
        createSafeElement(document, 'h3', { className: 'subhead', text: tier.name }),
        createSafeElement(document, 'p', { className: 'muted-text', text: tier.note })
      ]
    }));
  }

  const safetyBox = document.getElementById('iaq-safety-notes');
  clearNode(safetyBox);
  for (const note of evalResult.safetyNotes) {
    safetyBox.appendChild(createSafeElement(document, 'p', { className: 'muted-text', text: note }));
  }
}

/**
 * Evaluates and renders the Indoor Air Quality Lab physics, blueprint, and CADR curve.
 * @param {Record<string, any>} state
 * @returns {void}
 */
export function renderIndoorLab(state) {
  const { value: outdoorPm25, isReferenceFallback } = getOutdoorPm25WithProvenance(state.intel);
  const refNotice = document.getElementById('iaq-ref-notice');
  refNotice.hidden = !isReferenceFallback;
  if (isReferenceFallback) {
    refNotice.textContent = `Reference Scenario Active (${REFERENCE_DESIGN_PM25} µg/m³): Live ambient PM2.5 is currently unavailable, so calculations illustrate a design smog load rather than live readings.`;
  }

  const indoorSourceId = state.profile.cookingFuel === 'induction' ? 'minimal'
    : state.profile.cookingFuel === 'biomass-mixed' ? 'heavy' : 'cooking';

  const evalResult = evaluateIndoorFiltration({
    floorAreaSqFt: state.profile.roomSqFt,
    ceilingHeightFt: state.profile.ceilingHeightFt,
    outdoorPm25,
    leakageId: state.profile.leakageId,
    indoorSourceId,
    filterGradeId: state.iaqFilterGrade,
    inputMode: state.iaqInputMode,
    targetAch: state.customAch ?? undefined,
    deviceCadrM3h: state.customCadr ?? undefined
  });
  state.indoorEval = evalResult;

  document.getElementById('iaq-cadr-label').textContent = state.iaqInputMode === 'airflow'
    ? 'Compare DIY Fan Airflow (m³/h)' : 'Compare Purifier CADR (m³/h)';
  if (state.customAch === null) getField('iaq-ach-input').value = String(evalResult.sizing.recommendedAch);
  if (state.customCadr === null) getField('iaq-cadr-input').value = String(evalResult.sizing.recommendedCadrM3h);

  document.getElementById('iaq-volume-badge').textContent =
    `Volume: ${evalResult.dimensions.volumeM3} m³ (${evalResult.dimensions.floorAreaM2} m² × ${evalResult.dimensions.ceilingHeightM} m)`;
  document.getElementById('iaq-rec-cadr').textContent = state.iaqInputMode === 'airflow'
    ? `${evalResult.sizing.requiredFanAirflowM3h} m³/h fan (${evalResult.sizing.recommendedCadrM3h} CADR)`
    : `${evalResult.sizing.recommendedCadrM3h} m³/h (${evalResult.sizing.recommendedAch} ACH)`;
  document.getElementById('iaq-unfiltered').textContent = `${evalResult.outcomes.unfilteredIndoorPm25} µg/m³`;
  document.getElementById('iaq-filtered').textContent = `${evalResult.outcomes.filteredIndoorPm25} µg/m³ (${evalResult.outcomes.filteredRange[0]}–${evalResult.outcomes.filteredRange[1]})`;
  document.getElementById('iaq-reduction').textContent = `-${evalResult.outcomes.reductionPct}% (${evalResult.sizing.effectiveFiltrationAch} eACH)`;

  renderRoomBlueprint(evalResult);
  renderCadrCurveChart(evalResult);
  renderIndoorComparisonBars(evalResult, outdoorPm25, isReferenceFallback);
  renderFiltrationTiersAndNotes(evalResult, state.profile.budgetTier);
}

function buildScenarioOption(sc, checked, state) {
  const checkbox = /** @type {HTMLInputElement} */ (createSafeElement(document, 'input', { attrs: { type: 'checkbox', id: `sc-${sc.id}`, value: sc.id } }));
  checkbox.checked = checked;
  checkbox.addEventListener('change', () => {
    state.selectedScenarios = checkbox.checked
      ? (state.selectedScenarios.includes(sc.id) ? state.selectedScenarios : [...state.selectedScenarios, sc.id])
      : state.selectedScenarios.filter((id) => id !== sc.id);
    saveJson(STORAGE_KEYS.SCENARIOS, state.selectedScenarios);
    renderImpactSimulator(state);
  });

  const statsParts = [];
  if (sc.pm25DoseCutUg > 0) statsParts.push(`-${sc.pm25DoseCutUg} µg/m³ 24h personal dose`);
  if (sc.co2SavedKgPerMonth > 0) statsParts.push(`-${sc.co2SavedKgPerMonth} kg CO₂/mo`);
  if (sc.monthlySavingsInr > 0) statsParts.push(`Save ₹${sc.monthlySavingsInr.toLocaleString('en-IN')}/mo`);

  return createSafeElement(document, 'label', {
    className: `scenario-option${checked ? ' is-checked' : ''}`,
    attrs: { for: `sc-${sc.id}` },
    children: [
      checkbox,
      createSafeElement(document, 'span', {
        children: [
          createSafeElement(document, 'strong', { className: 'routine-title', text: sc.title }),
          createSafeElement(document, 'p', { className: 'muted-text', text: sc.assumption }),
          createSafeElement(document, 'span', { className: 'mono-meta accent-text', text: statsParts.join(' · ') || 'Baseline sustainable habit maintained' })
        ]
      })
    ]
  });
}

/**
 * Renders the Personal Impact Simulator checkboxes, KPI cards, and exposure meter.
 * @param {Record<string, any>} state
 * @returns {void}
 */
export function renderImpactSimulator(state) {
  const { value: outdoorPm25, isReferenceFallback } = getOutdoorPm25WithProvenance(state.intel);
  const refNotice = document.getElementById('imp-ref-notice');
  refNotice.hidden = !isReferenceFallback;
  if (isReferenceFallback) {
    refNotice.textContent = `Reference Scenario Active (${REFERENCE_DESIGN_PM25} µg/m³): Live ambient PM2.5 is currently unavailable; simulator values reflect a standard design smog baseline.`;
  }

  const result = evaluateSelectedScenarios(state.selectedScenarios, state.profile, outdoorPm25);
  const list = document.getElementById('scenarios-list');
  clearNode(list);
  const selectedSet = new Set(state.selectedScenarios);
  for (const sc of result.scenarios) {
    list.appendChild(buildScenarioOption(sc, selectedSet.has(sc.id), state));
  }

  document.getElementById('imp-pm25-pct').textContent = `-${result.exposureReductionPct}%`;
  document.getElementById('imp-pm25-detail').textContent = `${result.baselinePersonalPm25} → ${result.projectedPersonalPm25} µg/m³`;
  document.getElementById('imp-co2').textContent = `${result.co2SavedKgPerMonth} kg/mo`;
  document.getElementById('imp-co2-yr').textContent = `${result.co2SavedKgPerYear} kg CO₂/year`;
  document.getElementById('imp-inr').textContent = `₹${result.monthlySavingsInr.toLocaleString('en-IN')} / mo`;
  document.getElementById('imp-community').textContent = `${result.community1000HouseholdsCo2TonsYr} t/yr`;
  /** @type {HTMLMeterElement} */ (document.getElementById('imp-meter')).value = result.exposureReductionPct;
  document.getElementById('imp-meter-text').textContent = `${result.exposureReductionPct}%`;
  document.getElementById('imp-disclaimer').textContent = result.methodologyDisclaimer;
}