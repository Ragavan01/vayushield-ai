import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

test('WCAG 2.2 AA Audit: semantic landmarks, language, skip link, progressive disclosure & alert regions', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.match(html, /<html\s+lang="en">/i);
  assert.match(html, /class="skip-link"/);
  assert.match(html, /role="banner"/);
  assert.match(html, /<main[^>]*id="main-content"[^>]*role="main"/);
  assert.match(html, /role="contentinfo"/);
  assert.match(html, /id="error-banner"[^>]*role="alert"/);
  assert.match(html, /<details\s+class="methodology-drawer">/);
  assert.match(html, /role="tablist"/);
  assert.match(html, /role="tab"/);
  assert.match(html, /role="tabpanel"/);
  assert.match(html, /aria-live="polite"/);
});

test('WCAG 2.2 AA Audit: every form control across all modules has an explicit associated label', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const controlIds = [
    'city-search-input',
    'profile-household',
    'profile-commute',
    'profile-km',
    'profile-cooking',
    'profile-budget',
    'profile-room',
    'profile-ceiling',
    'profile-leakage',
    'iaq-ach-input',
    'iaq-cadr-input',
    'coach-input',
    'pledge-area',
    'pledge-category',
    'pledge-action',
    'pledge-consent'
  ];

  for (const id of controlIds) {
    const labelRe = new RegExp(`<label[^>]*for="${id}"`, 'i');
    assert.match(html, labelRe, `Missing explicit <label for="${id}">`);
  }
});

test('WCAG 2.2 AA & Mobile Responsive CSS Audit: focus outlines, 44px touch targets, reduced motion & breakpoints', () => {
  const css = fs.readFileSync(path.join(ROOT, 'styles/main.css'), 'utf8');
  assert.match(css, /:focus-visible\s*\{/);
  assert.match(css, /min-height:\s*44px/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(css, /@media\s*\(max-width:\s*1180px\)/);
  assert.match(css, /@media\s*\(max-width:\s*680px\)/);
  assert.match(css, /\.sr-only\s*\{/);
});