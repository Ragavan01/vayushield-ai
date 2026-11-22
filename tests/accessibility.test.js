import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

test('Accessibility WCAG Audit: semantic landmarks, language, and skip link exist', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.match(html, /<html\s+lang="en">/i);
  assert.match(html, /class="skip-link"/);
  assert.match(html, /role="banner"/);
  assert.match(html, /<main[^>]*id="main-content"[^>]*role="main"/);
  assert.match(html, /role="contentinfo"/);
});

test('Accessibility WCAG Audit: ARIA tablist, dialog modal, and live regions are properly wired', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.match(html, /role="tablist"/);
  assert.match(html, /role="tab"/);
  assert.match(html, /role="tabpanel"/);
  assert.match(html, /role="dialog"[^>]*aria-modal="true"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /<progress\s+id="imp-meter"/);
});

test('Accessibility WCAG Audit: all static form controls have associated labels', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const controlIds = [
    'city-search-input',
    'profile-household',
    'profile-commute',
    'profile-budget',
    'profile-cooking',
    'profile-room',
    'profile-km',
    'coach-input',
    'pledge-neighborhood',
    'pledge-action',
    'gemini-key-input'
  ];

  for (const id of controlIds) {
    const labelRe = new RegExp(`<label[^>]*for="${id}"`, 'i');
    assert.match(html, labelRe, `Missing explicit <label for="${id}">`);
  }
});

test('Accessibility CSS Audit: visible focus indicators and prefers-reduced-motion support exist', () => {
  const css = fs.readFileSync(path.join(ROOT, 'styles/main.css'), 'utf8');
  assert.match(css, /:focus-visible\s*\{/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(css, /\.sr-only\s*\{/);
});