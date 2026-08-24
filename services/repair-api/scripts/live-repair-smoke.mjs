// Live repair smoke (opt-in; requires a running bridge and OPENROUTER_API_KEY on
// the bridge side). Full flow over HTTP: infer -> (if items) show items + kinds
// -> confirm (marking every item confirmed=true) -> /context/check (report
// compiles + still-missing) -> scan -> pick the first violation finding ->
// /repair -> apply returned hunks with the shared @c-repair/core applyHunks and
// verify no prelude marker leaks into the result.
//
// The infer step now returns inferred external declarations for context-poor .c
// (V2a): with a compiler on the bridge side, missing types/functions/macros/
// globals come back as draft items. Files that are self-contained still infer 0
// items and the flow behaves exactly as before.
//
// Usage: node scripts/live-repair-smoke.mjs <file.c> [base-url] [token]
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const core = await import(join(here, '../../../packages/core/src/index.js'));

const file = process.argv[2];
const BASE = process.argv[3] ?? 'http://127.0.0.1:8787';
const TOKEN = process.argv[4] ?? process.env.CREPAIR_BRIDGE_TOKEN ?? '';
if (!file) { console.error('usage: live-repair-smoke.mjs <file.c> [base-url] [token]'); process.exit(2); }

const content = readFileSync(file, 'utf8');
const hash = 'sha256:' + createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');
const source_document = {
  source_id: 'src-live-repair-smoke', filename: 'live.c', language: 'c',
  content, content_hash: hash, size_bytes: Buffer.byteLength(content, 'utf8'), origin: 'web_upload',
};

const headers = { 'Content-Type': 'application/json', ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) };
const post = async (path, body) => {
  const t = Date.now();
  const r = await fetch(BASE + path, { method: 'POST', headers, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) { console.error(`${path} -> ${r.status}`, JSON.stringify(j).slice(0, 300)); process.exit(1); }
  return { s: (Date.now() - t) / 1000, j };
};

const inf = await post('/context/infer', { source_document });
const inferSet = inf.j;
const items = inferSet.items ?? [];
console.log(`infer: ${inf.s.toFixed(1)}s, ${items.length} item(s)`);
for (const it of items) {
  console.log(`  item ${it.item_id} [${it.kind}] (${it.provenance}): ${it.current_text.replace(/\n/g, ' ')}`);
}

// Review path: mark every inferred item confirmed=true (as "Confirm & Scan"
// would) so the confirmed set is not assumption-dependent. Items 0 -> unchanged.
const confirmedSet = { ...inferSet, items: items.map((it) => ({ ...it, confirmed: true })) };
const conf = await post('/context/confirm', { context_augmentation_set: confirmedSet });

// Context check: does the composed Augmented C compile with the confirmed context?
const check = await post('/context/check', {
  source_document, context_augmentation_set: conf.j,
});
if (check.j.compiles) {
  console.log('context/check: compiles ✓');
} else {
  const miss = check.j.missing_symbols ?? [];
  console.log(`context/check: still missing: ${miss.length ? miss.join(', ') : '(compile skipped — no compiler)'}`);
}

const scan = await post('/scan', { source_document, context_augmentation_set: conf.j });
console.log(`scan: ${scan.s.toFixed(1)}s, ${scan.j.functions.length} functions`);

const target = scan.j.functions.find((f) => f.findings[0]?.kind === 'violation');
if (!target) { console.error('no violation finding to repair'); process.exit(1); }
const finding = target.findings[0];
console.log(`repair target: ${target.name} ${finding.rule_id} @L${finding.location.start_line}`);

const rep = await post('/repair', {
  source_document, context_augmentation_set: conf.j,
  function_id: target.function_id, finding,
});
const cand = rep.j;
console.log(`repair: ${rep.s.toFixed(1)}s status=${cand.status} hunks=${cand.hunks.length} model=${cand.model_identity}`);
for (const v of cand.validations) console.log(`  validation ${v.name}: ${v.status}${v.detail ? ' — ' + v.detail : ''}`);
for (const h of cand.hunks) console.log(`  hunk L${h.start_line} count=${h.line_count}`);

if (cand.hunks.length > 0) {
  const applied = core.applyHunks(content, cand.hunks);
  const markerFree = !applied.includes('C Repair inferred context') && !applied.includes('===== Original source =====');
  console.log(`applyHunks: ok, markerFree=${markerFree ? 'PASS' : 'FAIL'}`);
  console.log('--- applied (target function region) ---');
  const lines = applied.split('\n');
  console.log(lines.slice(Math.max(0, finding.location.start_line - 3), finding.location.start_line + 8).join('\n'));
  if (!markerFree) process.exit(1);
}
console.log('LIVE REPAIR SMOKE: DONE');
