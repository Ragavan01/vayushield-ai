import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SOURCE_DIRS = ['api', 'lib', 'js'];

function walkJs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkJs(full);
    return /\.js$/i.test(entry.name) ? [full] : [];
  });
}

function measureLongFunctions(lines, maxLines) {
  const fnRe = /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(|^\s*(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s+)?\([^)]*\)\s*=>\s*\{/;
  const breaches = [];
  let active = null;
  let depth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = !active ? line.match(fnRe) : null;
    if (match) active = { name: match[1] || match[2], start: i + 1, startDepth: depth };

    const opens = (line.match(/\{/g) || []).length;
    const closes = (line.match(/\}/g) || []).length;
    depth += opens - closes;

    if (active && depth <= active.startDepth && (opens > 0 || closes > 0)) {
      const length = (i + 1) - active.start + 1;
      if (length > maxLines) breaches.push(`${active.name}() (${length} lines)`);
      active = null;
    }
  }
  return breaches;
}

test('Code Quality Gate: modular file sizing, zero var/console.log in browser, zero bare catch blocks', () => {
  const files = SOURCE_DIRS.flatMap((d) => walkJs(path.join(ROOT, d)));
  assert.ok(files.length >= 22, 'Expected modular architecture across api/, lib/, and js/');

  for (const full of files) {
    const rel = path.relative(ROOT, full);
    const src = fs.readFileSync(full, 'utf8');
    const lines = src.split(/\r?\n/);

    assert.ok(lines.length <= 360, `${rel} exceeds 360-line modularity limit (${lines.length} lines)`);
    assert.equal(/\bcatch\s*\{/.test(src), false, `Bare catch block found in ${rel}`);
    assert.equal(/^\s*var\s+/m.test(src), false, `Legacy var declaration found in ${rel}`);
    if (rel.startsWith('js')) {
      assert.equal(/\bconsole\.log\s*\(/.test(src), false, `console.log found in browser module ${rel}`);
    }
  }
});

test('Code Quality Gate: 100% JSDoc export documentation & bounded function complexity', () => {
  const files = SOURCE_DIRS.flatMap((d) => walkJs(path.join(ROOT, d)));
  for (const full of files) {
    const rel = path.relative(ROOT, full);
    const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      if (/^\s*export\s+(?:async\s+)?(?:function|const)\s+[A-Za-z0-9_$]+/.test(lines[i])) {
        const prev = lines.slice(Math.max(0, i - 3), i).join('\n');
        assert.ok(prev.includes('*/'), `Missing JSDoc on export at ${rel}:${i + 1}`);
      }
    }

    const longFns = measureLongFunctions(lines, 50);
    assert.deepEqual(longFns, [], `Oversized functions (>50 lines) in ${rel}: ${longFns.join(', ')}`);
  }
});

test('Code Quality Gate: repository includes static type-checking and editor formatting configs', () => {
  const jsconfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'jsconfig.json'), 'utf8'));
  assert.equal(jsconfig.compilerOptions?.checkJs, true);
  const editorconfig = fs.readFileSync(path.join(ROOT, '.editorconfig'), 'utf8');
  assert.match(editorconfig, /indent_style\s*=\s*space/);
});