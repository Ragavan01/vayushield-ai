import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  clampNumber,
  isPlausibleApiKey,
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

test('Security: sanitizeText strips angle brackets, control chars, and enforces max length', () => {
  const dirty = '<script>alert("xss")</script>\u0000\n   Delhi   ';
  const clean = sanitizeText(dirty, 30);
  assert.equal(clean.includes('<'), false);
  assert.equal(clean.includes('>'), false);
  assert.equal(clean.includes('\u0000'), false);
  assert.ok(clean.length <= 30);
  assert.equal(sanitizeText(null), '');
  assert.equal(sanitizeText(12345), '');
});

test('Security: URL and API key validators reject unsafe inputs', () => {
  assert.equal(isSafeHttpUrl('https://vayushield.vercel.app'), true);
  assert.equal(isSafeHttpUrl('javascript:alert(1)'), false);
  assert.equal(isSafeHttpUrl('data:text/html,<script>alert(1)</script>'), false);
  assert.equal(isSafeHttpUrl('not-a-url'), false);

  assert.equal(isPlausibleApiKey('AIzaSyDemoValidFormatKey1234567890'), true);
  assert.equal(isPlausibleApiKey('AIzaShort'), false);
  assert.equal(isPlausibleApiKey('sk-invalid-prefix-1234567890123456'), false);
  assert.equal(clampNumber('NaN', 0, 100, 42), 42);
  assert.equal(validateEnum('bad', ['a', 'b'], 'a'), 'a');
});

test('Security Static Audit: zero innerHTML, eval, Function constructor, or document.write in source JS', () => {
  const files = [
    'js/app.js',
    'js/core/security.js',
    'js/core/aqiEngine.js',
    'js/core/recommendationEngine.js',
    'js/services/airQualityService.js',
    'js/services/aiAssistantService.js',
    'api/gemini.js'
  ];

  for (const rel of files) {
    const raw = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const code = stripComments(raw);
    assert.equal(/\.innerHTML\b/.test(code), false, `Disallowed innerHTML found in ${rel}`);
    assert.equal(/\.outerHTML\b/.test(code), false, `Disallowed outerHTML found in ${rel}`);
    assert.equal(/\beval\s*\(/.test(code), false, `Disallowed eval() found in ${rel}`);
    assert.equal(/\bnew\s+Function\s*\(/.test(code), false, `Disallowed Function() found in ${rel}`);
    assert.equal(/document\.write\s*\(/.test(code), false, `Disallowed document.write() found in ${rel}`);
  }
});

test('Security Static Audit: index.html contains zero inline JS handlers or inline script blocks', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.equal(/\son[a-z]+\s*=/i.test(html), false, 'Found inline event handler in index.html');
  assert.equal(/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), false, 'Found inline <script> block in index.html');
});

test('Security Config: vercel.json enforces strict CSP without unsafe-inline scripts and core HTTP headers', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  const headers = cfg.headers?.[0]?.headers || [];
  const map = Object.fromEntries(headers.map((h) => [h.key, h.value]));

  assert.ok(map['Content-Security-Policy'], 'Missing Content-Security-Policy header');
  assert.equal(map['Content-Security-Policy'].includes('unsafe-inline'), false);
  assert.equal(map['Content-Security-Policy'].includes('unsafe-eval'), false);
  assert.equal(map['X-Content-Type-Options'], 'nosniff');
  assert.equal(map['X-Frame-Options'], 'DENY');
  assert.ok(map['Strict-Transport-Security']);
  assert.ok(map['Referrer-Policy']);
});