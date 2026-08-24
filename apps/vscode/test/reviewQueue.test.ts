// Unit tests for the pure review-queue derivation (D-024): violation queue order
// (start_line ascending, diffable only), the auto-repair limit guard, the
// "next pending diffable" selection (skips accepted/rejected), and the tally.
// All pure — no `vscode` — so they run under plain Node.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  violationTargetsInOrder,
  planAutoRepair,
  diffableQueue,
  nextPendingDiffable,
  firstPendingDiffable,
  reviewTally,
} from '../src/session/reviewQueue';
import type {
  Finding,
  ScanFunction,
  FunctionScanResult,
  RepairCandidate,
  Hunk,
  Validation,
} from '@c-repair/contract';

// --- fixtures ---------------------------------------------------------------

function violation(findingId: string, startLine: number): Finding {
  return {
    finding_id: findingId,
    kind: 'violation',
    rule_id: 'INT32-C',
    rule_summary: 'no overflow',
    explanation: 'x',
    location: { start_line: startLine, end_line: startLine },
    assumption_dependent: false,
  };
}

function uncertain(findingId: string, startLine: number): Finding {
  return {
    finding_id: findingId,
    kind: 'uncertain',
    rule_summary: 'maybe',
    explanation: 'x',
    location: { start_line: startLine, end_line: startLine },
    assumption_dependent: false,
  };
}

function fn(name: string, functionId: string, findings: Finding[]): ScanFunction {
  return {
    function_id: functionId,
    name,
    original_range: { start_line: findings[0]?.location.start_line ?? 1, end_line: 99 },
    findings,
  };
}

function scan(functions: ScanFunction[]): FunctionScanResult {
  return {
    scan_id: 's1',
    source_id: 'src1',
    original_hash: 'sha256:0',
    context_revision_id: 'ctx1',
    rule_profile: { id: 'p', version: '1' },
    adapter: { id: 'a', version: '1' },
    harness: { id: 'h', version: '1' },
    functions,
  };
}

const HUNK: Hunk = {
  hunk_id: 'h1',
  start_line: 5,
  line_count: 1,
  replacement_text: 'fixed;',
};

/** A repair_ready (diffable) candidate for a finding. */
function readyCandidate(candidateId: string, findingId: string): RepairCandidate {
  const validations: Validation[] = [
    { name: 'format', status: 'pass' },
    { name: 'compile', status: 'pass' },
  ];
  return {
    candidate_id: candidateId,
    finding_id: findingId,
    function_id: 'fn',
    source_id: 'src1',
    original_hash: 'sha256:0',
    context_revision_id: 'ctx1',
    status: 'repair_ready',
    repair_explanation: 'fix',
    hunks: [HUNK],
    validations,
  };
}

/** A repair_failed (no-diff) candidate: no hunks -> not diffable. */
function noFixCandidate(candidateId: string, findingId: string): RepairCandidate {
  return {
    ...readyCandidate(candidateId, findingId),
    status: 'repair_failed',
    hunks: [],
  };
}

// --- violationTargetsInOrder ------------------------------------------------

test('violationTargetsInOrder returns violations by ascending start_line', () => {
  // Functions are deliberately out of line order; findings must sort by start_line.
  const s = scan([
    fn('copy_label', 'fn-copy', [violation('f-copy', 26)]),
    fn('scale_reading', 'fn-scale', [violation('f-scale', 5)]),
  ]);
  const targets = violationTargetsInOrder(s);
  assert.deepEqual(
    targets.map((t) => t.finding.finding_id),
    ['f-scale', 'f-copy'],
  );
});

test('violationTargetsInOrder skips uncertain findings', () => {
  const s = scan([
    fn('a', 'fn-a', [violation('v1', 10)]),
    fn('b', 'fn-b', [uncertain('u1', 3)]),
    fn('c', 'fn-c', [violation('v2', 20)]),
  ]);
  const targets = violationTargetsInOrder(s);
  assert.deepEqual(
    targets.map((t) => t.finding.finding_id),
    ['v1', 'v2'],
  );
});

test('violationTargetsInOrder keeps function order on a start_line tie (stable)', () => {
  const s = scan([
    fn('first', 'fn-1', [violation('v-first', 7)]),
    fn('second', 'fn-2', [violation('v-second', 7)]),
  ]);
  const targets = violationTargetsInOrder(s);
  assert.deepEqual(
    targets.map((t) => t.finding.finding_id),
    ['v-first', 'v-second'],
  );
});

test('violationTargetsInOrder pairs each finding with its owning function', () => {
  const s = scan([fn('scale', 'fn-scale', [violation('v', 5)])]);
  const targets = violationTargetsInOrder(s);
  assert.equal(targets[0].fn.function_id, 'fn-scale');
  assert.equal(targets[0].finding.finding_id, 'v');
});

// --- planAutoRepair (limit guard) -------------------------------------------

test('planAutoRepair off when autoRepair disabled', () => {
  assert.deepEqual(planAutoRepair(false, 3, 5), { kind: 'off' });
});

test('planAutoRepair none when zero violations', () => {
  assert.deepEqual(planAutoRepair(true, 0, 5), { kind: 'none' });
});

test('planAutoRepair all when count <= limit', () => {
  assert.deepEqual(planAutoRepair(true, 5, 5), { kind: 'all', count: 5 });
  assert.deepEqual(planAutoRepair(true, 2, 5), { kind: 'all', count: 2 });
});

test('planAutoRepair confirm when count > limit', () => {
  assert.deepEqual(planAutoRepair(true, 6, 5), { kind: 'confirm', count: 6, limit: 5 });
});

test('planAutoRepair with limit 0 confirms for any violations', () => {
  assert.deepEqual(planAutoRepair(true, 1, 0), { kind: 'confirm', count: 1, limit: 0 });
  assert.deepEqual(planAutoRepair(true, 0, 0), { kind: 'none' });
});

// --- diffableQueue ----------------------------------------------------------

test('diffableQueue keeps only diffable candidates in queue order', () => {
  const s = scan([
    fn('scale', 'fn-scale', [violation('v-scale', 5)]),
    fn('mid', 'fn-mid', [violation('v-mid', 10)]),
    fn('copy', 'fn-copy', [violation('v-copy', 26)]),
  ]);
  const targets = violationTargetsInOrder(s);
  const byFinding: Record<string, RepairCandidate> = {
    'v-scale': readyCandidate('c-scale', 'v-scale'),
    // v-mid: repair_failed -> not diffable (tree only).
    'v-mid': noFixCandidate('c-mid', 'v-mid'),
    'v-copy': readyCandidate('c-copy', 'v-copy'),
  };
  const queue = diffableQueue(targets, (id) => byFinding[id]);
  assert.deepEqual(
    queue.map((c) => c.candidate_id),
    ['c-scale', 'c-copy'],
  );
});

test('diffableQueue omits findings with no candidate yet', () => {
  const s = scan([
    fn('scale', 'fn-scale', [violation('v-scale', 5)]),
    fn('copy', 'fn-copy', [violation('v-copy', 26)]),
  ]);
  const targets = violationTargetsInOrder(s);
  // Only v-scale generated so far.
  const byFinding: Record<string, RepairCandidate | undefined> = {
    'v-scale': readyCandidate('c-scale', 'v-scale'),
  };
  const queue = diffableQueue(targets, (id) => byFinding[id]);
  assert.deepEqual(
    queue.map((c) => c.candidate_id),
    ['c-scale'],
  );
});

// --- nextPendingDiffable / firstPendingDiffable -----------------------------

function threeQueue(): RepairCandidate[] {
  return [
    readyCandidate('c1', 'f1'),
    readyCandidate('c2', 'f2'),
    readyCandidate('c3', 'f3'),
  ];
}

test('firstPendingDiffable returns the first when all pending', () => {
  const q = threeQueue();
  const next = firstPendingDiffable(q, () => true);
  assert.equal(next?.candidate_id, 'c1');
});

test('nextPendingDiffable from undefined = first pending', () => {
  const q = threeQueue();
  const next = nextPendingDiffable(q, undefined, () => true);
  assert.equal(next?.candidate_id, 'c1');
});

test('nextPendingDiffable advances strictly after current', () => {
  const q = threeQueue();
  const next = nextPendingDiffable(q, 'c1', () => true);
  assert.equal(next?.candidate_id, 'c2');
});

test('nextPendingDiffable skips accepted/rejected candidates', () => {
  const q = threeQueue();
  // c2 is already decided (not pending); after c1 we jump to c3.
  const decided = new Set(['c2']);
  const next = nextPendingDiffable(q, 'c1', (id) => !decided.has(id));
  assert.equal(next?.candidate_id, 'c3');
});

test('nextPendingDiffable returns undefined when nothing pending after current', () => {
  const q = threeQueue();
  const decided = new Set(['c2', 'c3']);
  const next = nextPendingDiffable(q, 'c1', (id) => !decided.has(id));
  assert.equal(next, undefined);
});

test('nextPendingDiffable with an unknown current id searches from the start', () => {
  const q = threeQueue();
  const next = nextPendingDiffable(q, 'nope', () => true);
  assert.equal(next?.candidate_id, 'c1');
});

test('firstPendingDiffable skips leading decided candidates', () => {
  const q = threeQueue();
  const decided = new Set(['c1']);
  const next = firstPendingDiffable(q, (id) => !decided.has(id));
  assert.equal(next?.candidate_id, 'c2');
});

// --- reviewTally ------------------------------------------------------------

test('reviewTally counts accepted / rejected / pending', () => {
  const q = threeQueue();
  const decisions: Record<string, string> = { c1: 'accepted', c2: 'rejected', c3: 'pending' };
  assert.deepEqual(reviewTally(q, (id) => decisions[id] ?? 'pending'), {
    accepted: 1,
    rejected: 1,
    pending: 1,
  });
});

test('reviewTally treats unknown decisions as pending', () => {
  const q = threeQueue();
  assert.deepEqual(reviewTally(q, () => 'pending'), {
    accepted: 0,
    rejected: 0,
    pending: 3,
  });
});
