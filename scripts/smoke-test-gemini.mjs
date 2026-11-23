/**
 * @fileoverview Zero-dependency Gemini API Model Catalogue Inspector & Live Generation Smoke Test.
 * Usage (PowerShell):
 *   $env:GEMINI_API_KEY="your_key_here"
 *   $env:GEMINI_MODEL_ID="gemini-2.5-flash"
 *   npm run smoke:gemini
 */

const apiKey = (process.env.GEMINI_API_KEY || '').trim();
const configuredModel = (process.env.GEMINI_MODEL_ID || 'gemini-2.5-flash').trim().replace(/^models\//i, '');

if (!apiKey) {
  console.error('ERROR: Set GEMINI_API_KEY in your shell environment before running this smoke test.');
  process.exit(1);
}

console.log('1) Inspecting accessible Gemini models for this API key via GET /v1beta/models...');
const listRes = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
  headers: { 'x-goog-api-key': apiKey }
});

if (!listRes.ok) {
  const errBody = await listRes.json().catch(() => ({}));
  console.error(`FAILED to list models: HTTP ${listRes.status} — ${errBody?.error?.status || ''} ${errBody?.error?.message || ''}`);
  process.exit(1);
}

const listJson = await listRes.json();
const genModels = (listJson.models || [])
  .filter((m) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
  .map((m) => ({
    id: String(m.name || '').replace(/^models\//, ''),
    displayName: m.displayName || '',
    inputLimit: m.inputTokenLimit ?? '—',
    outputLimit: m.outputTokenLimit ?? '—'
  }));

console.log(`Found ${genModels.length} generateContent-capable models on your key. Top Flash/Pro candidates:`);
genModels
  .filter((m) => /gemini/i.test(m.id))
  .slice(0, 12)
  .forEach((m) => console.log(`  - ${m.id} (${m.displayName}) [in: ${m.inputLimit}, out: ${m.outputLimit}]`));

const hasConfigured = genModels.some((m) => m.id === configuredModel);
if (!hasConfigured) {
  console.warn(`\nWARNING: Configured GEMINI_MODEL_ID="${configuredModel}" is NOT in your project's available list above!`);
  console.warn('Pick one of the exact IDs listed above and set GEMINI_MODEL_ID in Vercel Environment Variables.\n');
}

console.log(`\n2) Running real generation smoke test against model: ${configuredModel}`);
const started = Date.now();
const genRes = await fetch(
  `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(configuredModel)}:generateContent`,
  {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey
    },
    body: JSON.stringify({
      contents: [{
        role: 'user',
        parts: [{ text: 'Return a valid JSON object containing status: connected and message: VayuShield AI Coach is operational.' }]
      }],
      generationConfig: {
        maxOutputTokens: 512,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          required: ['status', 'message'],
          properties: {
            status: { type: 'STRING' },
            message: { type: 'STRING' }
          }
        }
      }
    })
  }
);

const latencyMs = Date.now() - started;
const genJson = await genRes.json().catch(() => null);

if (!genRes.ok) {
  console.error(`SMOKE TEST FAILED: HTTP ${genRes.status} (${latencyMs} ms) — ${genJson?.error?.status || ''}: ${genJson?.error?.message || ''}`);
  process.exit(1);
}

const rawText = genJson?.candidates?.[0]?.content?.parts?.[0]?.text || '';
const parsed = JSON.parse(rawText);
console.log('SMOKE TEST PASSED:', {
  model: configuredModel,
  latencyMs,
  status: parsed.status,
  message: parsed.message,
  tokenUsage: genJson?.usageMetadata || null
});