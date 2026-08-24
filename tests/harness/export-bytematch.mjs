#!/usr/bin/env node
// Round C self-verification harness (byte-match).
//
// Reproduces exactly what Screen 4 + Screen 5 do for the accepted candidates and
// checks the produced Accepted Candidate C byte-matches tests/fixtures/
// expected-output/<set>.accepted.c, and that its sha256 matches the fixture
// report.output.content_hash.
//
// Pipeline mirrored:
//   - Accept set is chosen the way the UI allows it (D-004/D-005):
//       sample_sensor  : cand-001 + cand-002 (no conflict)  -> both accepted
//       sample_conflict: cand-001 only (cand-002 conflicts) -> cand-001 accepted
//   - Accepted Candidate C = applyHunks(source.content, accepted hunks)  [@core]
//   - Also runs the STATE_MODEL §6 export checks the UI runs.
//
// This uses the SAME @c-repair/core applyHunks/candidatesConflict/markers that
// the web UI imports via the "@core" alias, so a pass here is evidence the web
// export is byte-identical.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  applyHunks,
  candidatesConflict,
  MARKER_START,
  MARKER_END,
} from '@c-repair/core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const FIX = join(ROOT, 'tests', 'fixtures');

const sha256 = (t) =>
  'sha256:' + createHash('sha256').update(Buffer.from(t, 'utf8')).digest('hex');
const readText = (p) => readFileSync(p, 'utf8');
const readJson = (p) => JSON.parse(readText(p));

// The accept sets the UI would produce (mirrors the shipped selection fixtures).
const CASES = [
  { set: 'sample_sensor', accept: ['cand-001', 'cand-002'] },
  { set: 'sample_conflict', accept: ['cand-001'] },
];

const MARKER_FRAGMENTS = [
  MARKER_START,
  MARKER_END,
  'C Repair inferred context',
  '===== Original source =====',
];

let failed = 0;

for (const { set, accept } of CASES) {
  const src = readText(join(FIX, 'source', `${set}.c`));
  const candidates = readJson(join(FIX, 'repair-candidates', `${set}.candidates.json`));
  const expected = readText(join(FIX, 'expected-output', `${set}.accepted.c`));
  const report = readJson(join(FIX, 'expected-output', `${set}.report.json`));

  const accepted = candidates.filter((c) => accept.includes(c.candidate_id));

  // STATE_MODEL §6 checks (same as the web verifyExport).
  const srcHash = sha256(src);
  const checks = [];
  for (const c of accepted) {
    if (c.original_hash !== srcHash) checks.push(`original_hash ${c.candidate_id}`);
  }
  for (let i = 0; i < accepted.length; i++)
    for (let j = i + 1; j < accepted.length; j++)
      if (candidatesConflict(accepted[i], accepted[j]))
        checks.push(`conflict ${accepted[i].candidate_id}/${accepted[j].candidate_id}`);

  const produced = applyHunks(
    src,
    accepted.flatMap((c) => c.hunks),
  );
  for (const frag of MARKER_FRAGMENTS)
    if (produced.includes(frag)) checks.push(`marker "${frag}"`);

  const producedHash = sha256(produced);
  const byteMatch = produced === expected;
  const hashMatch = producedHash === report.output.content_hash;

  const ok = byteMatch && hashMatch && checks.length === 0;
  if (!ok) failed += 1;

  console.log(`\n[${set}] accepted = [${accept.join(', ')}]`);
  console.log(`  verify checks failed : ${checks.length ? checks.join('; ') : 'none'}`);
  console.log(`  byte-match expected.c : ${byteMatch ? 'PASS' : 'FAIL'}`);
  console.log(`  produced sha256       : ${producedHash}`);
  console.log(`  report content_hash   : ${report.output.content_hash}`);
  console.log(`  hash-match            : ${hashMatch ? 'PASS' : 'FAIL'}`);
}

if (failed > 0) {
  console.error(`\n${failed} case(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll byte-match cases PASSED.');
process.exit(0);
