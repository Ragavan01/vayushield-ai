import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  buildHistoricalCsv,
  searchCitySuggestions
} from '../js/services/airQualityService.js';
import { COACH_PROMPT_TEMPLATES } from '../js/services/aiAssistantService.js';

const ROOT = path.resolve(import.meta.dirname, '..');

test('APEX Search: searchCitySuggestions returns sanitized global matches and ignores short queries', async () => {
  assert.deepEqual(await searchCitySuggestions('a'), []);

  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      results: [
        { name: 'Coimbatore', admin1: 'Tamil Nadu', country: 'India', latitude: 11.01684, longitude: 76.95583 },
        { name: '<b>London</b>', admin1: 'England', country: 'United Kingdom', latitude: 51.5072, longitude: -0.1276 }
      ]
    })
  });

  const hits = await searchCitySuggestions('coim', { fetchImpl: mockFetch });
  assert.equal(hits.length, 2);
  assert.equal(hits[0].name, 'Coimbatore');
  assert.equal(hits[0].lat, 11.0168);
  assert.equal(hits[1].name.includes('<b>'), false);
});

test('APEX Data Export: buildHistoricalCsv neutralizes spreadsheet formula injection and preserves missing slots', () => {
  const csv = buildHistoricalCsv({
    location: { name: '=CMD|calc!A0' },
    metadata: { provider: 'Open-Meteo / CAMS' },
    history: {
      points: [
        { time: '2026-11-23T08:00', pm25: 54.2, pm10: 71.0 },
        { time: '2026-11-23T09:00', pm25: null, pm10: null }
      ]
    }
  });

  const lines = csv.split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /timestamp_local,location,pm25_ug_m3,pm10_ug_m3/);
  assert.match(lines[1], /"'=CMD\|calc!A0"/);
  assert.match(lines[2], /,,"/);
});

test('APEX 2.0 Visual, Performance & Honesty Audit: GPU-safe Liquid Glass, capsule nav, IAQ blueprint/curve & demo separation', () => {
  assert.ok(COACH_PROMPT_TEMPLATES.length >= 6);

  const css = fs.readFileSync(path.join(ROOT, 'styles/main.css'), 'utf8');
  assert.match(css, /--glass-01-bg/);
  assert.match(css, /--glass-02-bg/);
  assert.match(css, /--glass-03-bg/);
  assert.match(css, /--glass-04-bg/);
  assert.match(css, /--glass-05-bg/);
  assert.match(css, /@supports\s*\(backdrop-filter:/);
  assert.match(css, /\.header-capsule/);
  assert.match(css, /\.mobile-bottom-nav/);
  assert.equal(/background-attachment:\s*fixed/i.test(css), false, 'Avoid scroll-jank background-attachment: fixed');

  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.match(html, /id="aqi-arc-fill"/);
  assert.match(html, /role="combobox"/);
  assert.match(html, /id="search-suggestions"/);
  assert.match(html, /id="btn-export-csv"/);
  assert.match(html, /id="btn-share-summary"/);
  assert.match(html, /id="btn-reset-profile"/);
  assert.match(html, /id="btn-clear-chat"/);
  assert.match(html, /id="iaq-mode-select"/);
  assert.match(html, /id="iaq-filter-select"/);
  assert.match(html, /id="iaq-room-blueprint"/);
  assert.match(html, /id="iaq-curve-chart"/);
  assert.match(html, /id="iaq-ref-notice"/);
  assert.match(html, /id="imp-ref-notice"/);
  assert.match(html, /<label[^>]*for="iaq-mode-select"/);
  assert.match(html, /<label[^>]*for="iaq-filter-select"/);
  assert.match(html, /class="mobile-bottom-nav"/);

  const appJs = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
  assert.match(appJs, /Illustrative Example/);
  assert.match(appJs, /Saved on This Device/);
  assert.match(appJs, /Not in CAMS model/);
});