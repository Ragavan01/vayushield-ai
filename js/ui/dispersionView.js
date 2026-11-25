/**
 * @fileoverview Atmospheric Dispersion module renderer: weather summary,
 * daylight-constrained outdoor windows, 24-hour bar chart, and 4-hour timeline.
 */

import { clearNode, createSafeElement } from '../core/security.js';
import { createSvg } from './domHelpers.js';

function renderDispersionSummary(current, dispersion) {
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
    firstHour && typeof firstHour.vc === 'number' ? `${firstHour.vc.toLocaleString('en-IN')} m²/s` : 'Unavailable';

  const dayWin = dispersion.bestDaytimeWindow;
  const peakWin = dispersion.peakAccumulationWindow;
  const lowWin = dispersion.lowestPollutionWindow;

  if (dispersion.available && dayWin && peakWin) {
    document.getElementById('best-window-val').textContent = `Daytime: ${dayWin.label}`;
    const overnightTag = lowWin && !lowWin.isDaytime ? ` · Overnight min ${lowWin.label} (${lowWin.avgPm25} µg/m³)` : '';
    document.getElementById('best-window-note').textContent = `${dayWin.projectedText} · ${dayWin.deltaText}${overnightTag}`;
    document.getElementById('worst-window-val').textContent = peakWin.label;
    document.getElementById('worst-window-note').textContent =
      `${peakWin.projectedText} · ${peakWin.deltaText}${peakWin.avgVc ? ` · VC ${peakWin.avgVc.toLocaleString('en-IN')} m²/s` : ''}`;
  } else {
    document.getElementById('best-window-val').textContent = 'Unavailable';
    document.getElementById('worst-window-val').textContent = 'Unavailable';
  }

  document.getElementById('dispersion-methodology-text').textContent = dispersion.methodologyNote;
  document.getElementById('dispersion-confidence-reason').textContent = dispersion.confidence.reason;
}

function drawDispersionBars(dispersion) {
  const hours = dispersion.hourly;
  const dayWin = dispersion.bestDaytimeWindow;
  const peakWin = dispersion.peakAccumulationWindow;
  const maxPm = Math.max(65, ...hours.map((h) => h.pm25));
  const width = 460;
  const height = 152;
  const padL = 28;
  const padR = 10;
  const padT = 16;
  const plotH = height - padT - 24;
  const barGap = 3;
  const barW = Math.max(8, (width - padL - padR - barGap * (hours.length - 1)) / hours.length);

  const svg = createSvg('svg', {
    viewBox: `0 0 ${width} ${height}`,
    class: 'chart-svg',
    role: 'img',
    'aria-label': `Next 24-hour modeled hourly PM2.5 forecast. Best daytime window ${dayWin?.label}, peak window ${peakWin?.label}.`
  });

  const cpcbY = padT + plotH - (Math.min(60, maxPm) / maxPm) * plotH;
  svg.appendChild(createSvg('line', {
    x1: padL, y1: cpcbY.toFixed(1), x2: width - padR, y2: cpcbY.toFixed(1),
    stroke: '#FBBF24', 'stroke-dasharray': '3 3', 'stroke-width': '1', opacity: '0.55'
  }));

  hours.forEach((h, idx) => {
    const x = padL + idx * (barW + barGap);
    const bh = Math.max(6, (h.pm25 / maxPm) * plotH);
    const isBestDay = h.isDaytime && (h.hourLabel === dayWin?.startHour || (dayWin && h.pm25 <= dayWin.avgPm25 * 1.05));
    const fill = isBestDay ? '#2DD4BF' : h.pm25 > 120 ? '#F87171' : h.pm25 > 60 ? '#FBBF24' : '#38BDF8';
    const bar = createSvg('rect', { x: x.toFixed(1), y: (padT + plotH - bh).toFixed(1), width: barW.toFixed(1), height: bh.toFixed(1), rx: '2.5', fill });
    const tip = createSvg('title');
    tip.textContent = `${h.hourLabel} (${h.isDaytime ? 'Daytime' : 'Overnight'}) — Forecast PM2.5: ${h.pm25} µg/m³ · ${h.dispersionCategory}${h.blh ? ` · BLH ${h.blh} m` : ''}`;
    bar.appendChild(tip);
    svg.appendChild(bar);

    if (idx % 4 === 0) {
      const lbl = createSvg('text', { x: (x + barW / 2).toFixed(1), y: height - 6, 'text-anchor': 'middle', fill: '#93A4BA', 'font-size': '9.5' });
      lbl.textContent = h.hourLabel;
      svg.appendChild(lbl);
    }
  });

  const maxLbl = createSvg('text', { x: padL - 4, y: padT + 4, 'text-anchor': 'end', fill: '#93A4BA', 'font-size': '9.5' });
  maxLbl.textContent = String(Math.round(maxPm));
  svg.appendChild(maxLbl);
  return svg;
}

/**
 * Renders the full Module 2 Atmospheric Dispersion forecast card.
 * @param {Record<string, any> | null} intel
 * @returns {void}
 */
export function renderDispersionModule(intel) {
  if (!intel) return;
  const { current, dispersion } = intel;
  renderDispersionSummary(current, dispersion);

  const chartWrap = document.getElementById('dispersion-chart-wrap');
  const timeline = document.getElementById('dispersion-timeline');
  clearNode(chartWrap);
  clearNode(timeline);

  if (!dispersion.available) {
    chartWrap.appendChild(createSafeElement(document, 'p', { className: 'muted-text', text: '24-hour dispersion forecast unavailable.' }));
    return;
  }

  chartWrap.appendChild(drawDispersionBars(dispersion));

  for (let i = 0; i < dispersion.hourly.length; i += 4) {
    const pt = dispersion.hourly[i];
    timeline.appendChild(createSafeElement(document, 'div', {
      className: 'disp-row',
      children: [
        createSafeElement(document, 'span', { text: `${pt.hourLabel} · ${pt.dispersionCategory}${pt.blh ? ` (BLH ${pt.blh} m)` : ''}` }),
        createSafeElement(document, 'strong', { text: `${pt.pm25} µg/m³` })
      ]
    }));
  }
}