/**
 * Static complexity, maintainability, and test-coupling auditor for VayuShield.
 * Zero external dependencies.
 */
import fs from 'node:fs';
import path from 'node:path';

const SOURCE_DIRS = ['api', 'lib', 'js'];
const TEST_DIR = 'tests';

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walk(full));
    else if (/\.(js|mjs)$/i.test(entry.name)) results.push(full);
  }
  return results;
}

function analyzeFile(filePath) {
  const src = fs.readFileSync(filePath, 'utf8');
  const lines = src.split(/\r?\n/);

  const longFunctions = [];
  const bareCatches = [];
  const missingJsdocExports = [];

  // Track function blocks heuristically by brace depth
  const fnRegex = /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(|^\s*(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s+)?\([^)]*\)\s*=>\s*\{/;
  let activeFn = null;
  let braceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/\bcatch\s*\{/.test(line)) {
      bareCatches.push(i + 1);
    }

    if (/^\s*export\s+(?:async\s+)?(?:function|const)\s+([A-Za-z0-9_$]+)/.test(line)) {
      const prev = lines.slice(Math.max(0, i - 3), i).join('\n');
      if (!prev.includes('*/')) {
        const name = line.match(/export\s+(?:async\s+)?(?:function|const)\s+([A-Za-z0-9_$]+)/)?.[1];
        if (name) missingJsdocExports.push(`${name} (L${i + 1})`);
      }
    }

    const match = !activeFn ? line.match(fnRegex) : null;
    if (match) {
      activeFn = { name: match[1] || match[2], start: i + 1, startDepth: braceDepth };
    }

    const opens = (line.match(/\{/g) || []).length;
    const closes = (line.match(/\}/g) || []).length;
    braceDepth += opens - closes;

    if (activeFn && braceDepth <= activeFn.startDepth && (opens > 0 || closes > 0)) {
      const length = (i + 1) - activeFn.start + 1;
      if (length > 50) {
        longFunctions.push({ file: filePath, name: activeFn.name, start: activeFn.start, length });
      }
      activeFn = null;
    }
  }

  return { file: filePath, lines: lines.length, longFunctions, bareCatches, missingJsdocExports };
}

const sourceFiles = SOURCE_DIRS.flatMap(walk);
const reports = sourceFiles.map(analyzeFile);

console.log('\n=== 1. TOP LONG FUNCTIONS (>50 lines) ===');
reports
  .flatMap((r) => r.longFunctions)
  .sort((a, b) => b.length - a.length)
  .slice(0, 20)
  .forEach((fn) => console.log(`${String(fn.length).padStart(4)} lines | ${fn.file}:${fn.start} -> ${fn.name}()`));

console.log('\n=== 2. BARE CATCH BLOCKS & UNDOCUMENTED EXPORTS ===');
for (const r of reports) {
  if (r.bareCatches.length || r.missingJsdocExports.length) {
    console.log(`${r.file}: bareCatch=[${r.bareCatches.join(', ')}] | undocumentedExports=${r.missingJsdocExports.length}`);
  }
}

console.log('\n=== 3. TEST STATIC FILE READS (DO NOT BREAK) ===');
for (const testFile of walk(TEST_DIR)) {
  const src = fs.readFileSync(testFile, 'utf8');
  const reads = [...src.matchAll(/readFileSync\(([^)]+)\)/g)].map((m) => m[1].trim());
  if (reads.length) console.log(`${testFile}: ${reads.join(' | ')}`);
}