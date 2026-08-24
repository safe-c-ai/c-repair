// Unit tests for Accept all reviewed (V1c, D-014): the reviewed tracking (V1
// definition: showing the diff marks a candidate reviewed), the selection
// (eligible per D-005 ∧ reviewed, candidate ID ascending), the D-014 tally
// line, the order-safety/equivalence of the sequential batch with single
// accepts, and the conflict-skip via the shared accept guard. Pure Node — no
// `vscode` module.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { ScanSession } from '../src/session/ScanSession';
import { selectAcceptAllReviewed, acceptAllSummary } from '../src/session/reviewQueue';
import { candidateToEditRanges, evaluateAcceptGuard } from '../src/ui/model';
import type {
  RepairCandidate,
  Validation,
  FunctionScanResult,
  SourceDocument,
  ContextAugmentationSet,
} from '@c-repair/contract';

const SAMPLE = 'int main(void) { return 0; }\n';

function sha(content: string): string {
  return 'sha256:' + createHash('sha256').update(content, 'utf8').digest('hex');
}

function val(status: Validation['status'], name: string): Validation {
  return { name, status };
}

function candidate(overrides: Partial<RepairCandidate> = {}): RepairCandidate {
  return {
    candidate_id: 'cand-1',
    finding_id: 'f-1',
    function_id: 'fn-1',
    source_id: 'src-1',
    original_hash: sha(SAMPLE),
    context_revision_id: 'rev-1',
    status: 'repair_ready',
    repair_explanation: 'fix',
    hunks: [{ hunk_id: 'h1', start_line: 5, line_count: 1, replacement_text: 'fixed;' }],
    validations: [val('pass', 'compile'), val('pass', 'semantic')],
    ...overrides,
  };
}

function makeSession(): ScanSession {
  const scan: FunctionScanResult = {
    scan_id: 'scan-1',
    source_id: 'src-1',
    original_hash: sha(SAMPLE),
    context_revision_id: 'rev-1',
    rule_profile: { id: 'cert-c', version: '1' },
    adapter: { id: 'a', version: '1' },
    harness: { id: 'certfix', version: '0.4.1' },
    functions: [],
  };
  const source: SourceDocument = {
    source_id: 'src-1',
    filename: 'a.c',
    language: 'c',
    content: SAMPLE,
    content_hash: sha(SAMPLE),
    size_bytes: Buffer.byteLength(SAMPLE, 'utf8'),
    origin: 'vscode_document',
  };
  const confirmed: ContextAugmentationSet = {
    set_id: 'set-1',
    source_id: 'src-1',
    original_hash: sha(SAMPLE),
    status: 'confirmed',
    context_revision_id: 'rev-1',
    prelude_line_count: 0,
    items: [],
  };
  return new ScanSession(
    ScanSession.makeSnapshot('file:///a.c', 'a.c', SAMPLE),
    'rev-1',
    scan,
    source,
    confirmed,
  );
}

// --- reviewed tracking (D-014) ------------------------------------------------

test('markReviewed / wasReviewed: displaying the diff is what reviewed means', () => {
  const s = makeSession();
  assert.equal(s.wasReviewed('cand-1'), false);
  s.markReviewed('cand-1');
  assert.equal(s.wasReviewed('cand-1'), true);
  // Idempotent.
  s.markReviewed('cand-1');
  assert.equal(s.wasReviewed('cand-1'), true);
});

test('reviewed is session state: a fresh session (rescan / D-006) starts empty', () => {
  const s1 = makeSession();
  s1.markReviewed('cand-1');
  const s2 = makeSession(); // a rescan replaces the session object entirely
  assert.equal(s2.wasReviewed('cand-1'), false);
});

// --- selection (eligible ∧ reviewed, candidate ID ascending) ------------------

test('selectAcceptAllReviewed orders by candidate ID ascending (D-014)', () => {
  const cB = candidate({ candidate_id: 'cand-b', finding_id: 'f-b' });
  const cA = candidate({ candidate_id: 'cand-a', finding_id: 'f-a' });
  const cC = candidate({ candidate_id: 'cand-c', finding_id: 'f-c' });
  const sel = selectAcceptAllReviewed(
    [cB, cC, cA], // queue order differs from ID order on purpose
    () => true,
    () => true,
  );
  assert.deepEqual(
    sel.toAccept.map((c) => c.candidate_id),
    ['cand-a', 'cand-b', 'cand-c'],
  );
  assert.deepEqual(sel.notReviewed, []);
});

test('selection filters non-pending / hunkless / non-acceptable candidates', () => {
  const ok = candidate({ candidate_id: 'cand-ok' });
  const decided = candidate({ candidate_id: 'cand-done' });
  const noHunks = candidate({ candidate_id: 'cand-nohunks', hunks: [] });
  const failed = candidate({
    candidate_id: 'cand-badgate',
    validations: [val('fail', 'compile')], // machine-gate fail -> not acceptable
  });
  const sel = selectAcceptAllReviewed(
    [ok, decided, noHunks, failed],
    (id) => id !== 'cand-done',
    () => true,
  );
  assert.deepEqual(
    sel.toAccept.map((c) => c.candidate_id),
    ['cand-ok'],
  );
});

test('selection partitions by reviewed-ness (unreviewed are skipped, not accepted)', () => {
  const cA = candidate({ candidate_id: 'cand-a' });
  const cB = candidate({ candidate_id: 'cand-b' });
  const sel = selectAcceptAllReviewed([cA, cB], () => true, (id) => id === 'cand-a');
  assert.deepEqual(
    sel.toAccept.map((c) => c.candidate_id),
    ['cand-a'],
  );
  assert.deepEqual(
    sel.notReviewed.map((c) => c.candidate_id),
    ['cand-b'],
  );
});

// --- tally line (D-014 format) ------------------------------------------------

test('acceptAllSummary always carries the fixed D-014 core', () => {
  const line = acceptAllSummary({
    accepted: 2,
    conflict: 1,
    notReviewed: 3,
    needsConfirmation: 0,
    failed: 0,
    dedupedIncludes: 0,
  });
  assert.equal(line, '2 accepted / 1 skipped (conflict) / 3 skipped (not reviewed)');
});

test('acceptAllSummary appends optional buckets only when non-zero', () => {
  const line = acceptAllSummary({
    accepted: 1,
    conflict: 0,
    notReviewed: 0,
    needsConfirmation: 2,
    failed: 1,
    dedupedIncludes: 1,
  });
  assert.match(line, /^1 accepted \/ 0 skipped \(conflict\) \/ 0 skipped \(not reviewed\)/);
  assert.match(line, /2 skipped \(needs per-candidate confirmation\)/);
  assert.match(line, /1 failed to apply/);
  assert.match(line, /1 duplicate #include line skipped$/);
});

// --- batch == sequential single accepts (order safety) ------------------------

test('batch edit ranges equal the sequential single-accept ranges, offsets applied', () => {
  // c1 inserts 2 lines at line 3; c2 replaces line 10. Accepting c1 first must
  // shift c2's range down by 2 — exactly what a human doing two single accepts
  // gets, because the batch calls the same functions in the same order.
  const c1 = candidate({
    candidate_id: 'cand-a',
    hunks: [{ hunk_id: 'h1', start_line: 3, line_count: 0, replacement_text: 'a;\nb;' }],
  });
  const c2 = candidate({
    candidate_id: 'cand-b',
    hunks: [{ hunk_id: 'h2', start_line: 10, line_count: 1, replacement_text: 'c;' }],
  });

  // Sequential single accepts (the proven path).
  const single1 = candidateToEditRanges(c1, []);
  const single2 = candidateToEditRanges(c2, c1.hunks);

  // The batch loop computes the identical calls in ID order.
  const batch: ReturnType<typeof candidateToEditRanges>[] = [];
  const acceptedHunks: RepairCandidate['hunks'] = [];
  for (const c of [c1, c2]) {
    batch.push(candidateToEditRanges(c, [...acceptedHunks]));
    acceptedHunks.push(...c.hunks);
  }
  assert.deepEqual(batch[0], single1);
  assert.deepEqual(batch[1], single2);

  // Order safety is real: c2's range moved down by c1's 2 inserted lines.
  const unshifted = candidateToEditRanges(c2, []);
  assert.equal(batch[1][0].startLine, unshifted[0].startLine + 2);

  // No marker text is fabricated anywhere: the applied texts are the hunks'
  // replacement_texts verbatim (plus the insertion newline handling).
  for (const ranges of batch) {
    for (const r of ranges) {
      assert.ok(!r.text.includes('C Repair inferred context'));
      assert.ok(!r.text.includes('Original source'));
    }
  }
});

test('conflicting candidate is skipped by the shared accept guard', () => {
  // c1 and c2 overlap on line 5 -> after accepting c1, the guard reports
  // conflict for c2; the batch counts it and moves on (D-014 skip 方式).
  const c1 = candidate({ candidate_id: 'cand-a' }); // line 5 replace
  const c2 = candidate({
    candidate_id: 'cand-b',
    hunks: [{ hunk_id: 'h2', start_line: 5, line_count: 2, replacement_text: 'x;\ny;' }],
  });
  const currentHash = sha(SAMPLE);
  const guard = evaluateAcceptGuard(c2, currentHash, currentHash, [c1]);
  assert.equal(guard.ok, false);
  if (!guard.ok) assert.equal(guard.reason, 'conflict');

  // And the tally line reports it in the fixed D-014 shape.
  const line = acceptAllSummary({
    accepted: 1,
    conflict: 1,
    notReviewed: 0,
    needsConfirmation: 0,
    failed: 0,
    dedupedIncludes: 0,
  });
  assert.equal(line, '1 accepted / 1 skipped (conflict) / 0 skipped (not reviewed)');
});
