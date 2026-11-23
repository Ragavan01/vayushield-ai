import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  clampNumber,
  isSafeHttpUrl,
  sanitizeText,
  validateEnum
} from '../js/core/security.js';

const ROOT = path.resolve(import.meta.dirname, '..');

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

test('Security Helpers: sanitizeText strips markup/control chars and validators reject unsafe schemes', () => {
  const cleaned = sanitizeText('<img src=x onerror=alert(1)>\u0000  Delhi  ', 40);
  assert.equal(cleaned.includes('<'), false);
  assert.equal(cleaned.includes('>'), false);
  assert.equal(cleaned.includes('\u0000'), false);
  assert.equal(isSafeHttpUrl('https://vayushield-ai-five.vercel.app'), true);
  assert.equal(isSafeHttpUrl('javascript:alert(1)'), false);
  assert.equal(clampNumber('bad', 10, 50, 25), 25);
  assert.equal(validateEnum('invalid', ['x', 'y'], 'x'), 'x');
});

test('Security Static Audit: zero innerHTML, eval, Function, document.write, or client API-key handling', () => {
  const sourceFiles = [
    'js/core/security.js',
    'js/core/cpcbAqi.js',
    'js/core/dispersionEngine.js',
    'js/core/indoorPhysics.js',
    'js/core/impactModel.js',
    'js/core/routineEngine.js',
    'js/core/communityModeration.js',
    'js/services/airQualityService.js',
    'js/services/aiAssistantService.js',
    'js/app.js',
    'api/gemini.js'
  ];

  for (const rel of sourceFiles) {
    const code = stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    assert.equal(/\.innerHTML\b/.test(code), false, `innerHTML found in ${rel}`);
    assert.equal(/\.outerHTML\b/.test(code), false, `outerHTML found in ${rel}`);
    assert.equal(/\beval\s*\(/.test(code), false, `eval() found in ${rel}`);
    assert.equal(/\bnew\s+Function\s*\(/.test(code), false, `Function() found in ${rel}`);
    assert.equal(/document\.write\s*\(/.test(code), false, `document.write() found in ${rel}`);
    assert.equal(/x-gemini-api-key/i.test(code), false, `Client API-key header found in ${rel}`);
    assert.equal(/sessionStorage/i.test(code), false, `Client credential sessionStorage found in ${rel}`);
  }
});

test('Security Static Audit: index.html has zero inline scripts, inline handlers, inline styles, or API-key inputs', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.equal(/\son[a-z]+\s*=/i.test(html), false, 'Inline JS event handler found in index.html');
  assert.equal(/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), false, 'Inline <script> found in index.html');
  assert.equal(/\sstyle\s*=/i.test(html), false, 'Inline style attribute found in index.html');
  assert.equal(/gemini-key-input/i.test(html), false, 'Client-side API key input must not exist in production UI');
});

test('Security Config: vercel.json enforces strict CSP across Open-Meteo AQ + Weather APIs and hardened headers', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  const headers = cfg.headers?.[0]?.headers || [];
  const map = Object.fromEntries(headers.map((h) => [h.key, h.value]));

  const csp = map['Content-Security-Policy'] || '';
  assert.ok(csp.length > 0);
  assert.equal(csp.includes('unsafe-inline'), false);
  assert.equal(csp.includes('unsafe-eval'), false);
  assert.ok(csp.includes('https://air-quality-api.open-meteo.com'));
  assert.ok(csp.includes('https://api.open-meteo.com'));
  assert.ok(csp.includes('https://geocoding-api.open-meteo.com'));
  assert.equal(map['X-Content-Type-Options'], 'nosniff');
  assert.equal(map['X-Frame-Options'], 'DENY');
  assert.ok(map['Strict-Transport-Security']);
  assert.ok(map['Referrer-Policy']);
});