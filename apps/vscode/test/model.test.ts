// Unit tests for the pure view-model derivation: finding -> diagnostic
// descriptor (severity / message / 0-index range) and function -> aggregate
// status / counts (VSCODE_V1B_DESIGN §4/§7).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  aggregateStatus,
  findingMessage,
  findingSeverity,
  findingToDiagnostic,
  findingToRange,
  scanCounts,
  candidateBadge,
  candidateBadgeLabel,
  candidateLabel,
  candidateTooltip,
  candidateHasDiff,
  badgeAcceptable,
  badgeRequiresWarning,
  gateClass,
  failingGatesByClass,
  acceptWarningMessage,
  acceptWarningPickItems,
  truncateDetail,
  CONCERN_DETAIL_MAX,
  validationDescriptor,
  validationMark,
  buildValidationLensTitles,
  JUDGMENT_FAIL_GUIDANCE,
  JUDGMENT_FAIL_GUIDANCE_LENS,
  STALE_RESULTS_MESSAGE,
  LENS_DETAIL_MAX,
  hunkToEditRange,
  hunkLineDelta,
  lineOffsetForStart,
  candidateToEditRanges,
  evaluateAcceptGuard,
} from '../src/ui/model';
import { applyHunks } from '@c-repair/core';
import type {
  Finding,
  ScanFunction,
  RepairCandidate,
  Validation,
  Hunk,
} from '@c-repair/contract';

function violation(overrides: Partial<Finding> = {}): Finding {
  return {
    finding_id: 'f-1',
    kind: 'violation',
    rule_id: 'INT32-C',
    rule_summary: 'Ensure that operations on signed integers do not overflow',
    explanation: 'a + b may overflow',
    location: { start_line: 10, end_line: 12 },
    assumption_dependent: false,
    ...overrides,
  };
}

function uncertain(overrides: Partial<Finding> = {}): Finding {
  return {
    finding_id: 'f-2',
    kind: 'uncertain',
    rule_summary: 'possible issue',
    explanation: 'Cannot determine the bound of n.\nSecond line ignored.',
    location: { start_line: 5, end_line: 5 },
    assumption_dependent: false,
    ...overrides,
  };
}

function fn(findings: Finding[]): ScanFunction {
  return {
    function_id: 'fn-1',
    name: 'average_two',
    original_range: { start_line: 8, end_line: 14 },
    findings,
  };
}

test('findingToRange converts 1-indexed inclusive to 0-indexed', () => {
  const r = findingToRange(violation());
  assert.equal(r.startLine, 9); // 10 -> 9
  assert.equal(r.startChar, 0);
  assert.equal(r.endLine, 11); // 12 -> 11
  assert.ok(r.endChar > 0);
});

test('findingToRange clamps a degenerate range so end >= start', () => {
  const r = findingToRange(violation({ location: { start_line: 1, end_line: 0 } }));
  assert.equal(r.startLine, 0);
  assert.equal(r.endLine, 0);
});

test('violation message = <rule_id>: <rule_summary> (no double-print)', () => {
  assert.equal(
    findingMessage(violation()),
    'INT32-C: Ensure that operations on signed integers do not overflow',
  );
});

test('violation without rule_id drops the prefix', () => {
  assert.equal(
    findingMessage(violation({ rule_id: undefined })),
    'Ensure that operations on signed integers do not overflow',
  );
});

test('uncertain message = [uncertain] first line of explanation', () => {
  assert.equal(findingMessage(uncertain()), '[uncertain] Cannot determine the bound of n.');
});

test('assumption_dependent appends the suffix', () => {
  assert.equal(
    findingMessage(violation({ assumption_dependent: true })),
    'INT32-C: Ensure that operations on signed integers do not overflow (assumption-dependent)',
  );
});

// D-039 legal kill-switch: when the bridge is run with CREPAIR_RULE_TITLES=off the
// scan finding's rule_summary is empty. The message must render the rule ID alone,
// with no dangling `STR31-C: ` separator.
test('empty rule_summary renders the rule id alone (IDs-only fallback)', () => {
  assert.equal(findingMessage(violation({ rule_summary: '' })), 'INT32-C');
  // Whitespace-only is also treated as empty (trimmed) -> id alone.
  assert.equal(findingMessage(violation({ rule_summary: '   ' })), 'INT32-C');
});

test('empty rule_summary keeps the assumption-dependent suffix on the id alone', () => {
  assert.equal(
    findingMessage(violation({ rule_summary: '', assumption_dependent: true })),
    'INT32-C (assumption-dependent)',
  );
});

test('severity: violation -> warning, uncertain -> information', () => {
  assert.equal(findingSeverity(violation()), 'warning');
  assert.equal(findingSeverity(uncertain()), 'information');
});

test('findingToDiagnostic carries source + code=rule_id', () => {
  const d = findingToDiagnostic(violation());
  assert.equal(d.source, 'C Repair');
  assert.equal(d.code, 'INT32-C');
  const u = findingToDiagnostic(uncertain());
  assert.equal(u.code, undefined);
});

test('aggregateStatus: violation wins over uncertain wins over clean', () => {
  assert.equal(aggregateStatus(fn([])), 'CLEAN');
  assert.equal(aggregateStatus(fn([uncertain()])), 'UNCERTAIN');
  assert.equal(aggregateStatus(fn([violation()])), 'VIOLATION_FOUND');
  assert.equal(aggregateStatus(fn([uncertain(), violation()])), 'VIOLATION_FOUND');
});

test('scanCounts counts findings across functions', () => {
  const c = scanCounts([
    fn([violation()]),
    fn([uncertain()]),
    fn([]),
  ]);
  assert.deepEqual(c, { functions: 3, violations: 1, uncertain: 1 });
});

// --- candidate badge derivation (V1b-2, D-017c) -----------------------------

function val(status: Validation['status'], name = 'compile', detail?: string): Validation {
  return detail === undefined ? { name, status } : { name, status, detail };
}

function candidate(overrides: Partial<RepairCandidate> = {}): RepairCandidate {
  return {
    candidate_id: 'cand-1',
    finding_id: 'f-1',
    function_id: 'fn-1',
    source_id: 'src-1',
    original_hash: 'sha256:' + '0'.repeat(64),
    context_revision_id: 'rev-1',
    status: 'repair_ready',
    repair_explanation: 'guard the multiply',
    hunks: [{ hunk_id: 'h1', start_line: 5, line_count: 1, replacement_text: 'x' }],
    validations: [val('pass', 'parse'), val('pass', 'compile')],
    ...overrides,
  };
}

test('candidateBadge: all pass -> repair_ready', () => {
  assert.equal(candidateBadge(candidate()), 'repair_ready');
  assert.equal(candidateBadgeLabel(candidateBadge(candidate())), '[repair_ready]');
});

test('candidateBadge: any skipped/not_run (no fail) -> insufficient_evidence (D-017c)', () => {
  const c1 = candidate({ validations: [val('pass', 'parse'), val('skipped', 'compile')] });
  assert.equal(candidateBadge(c1), 'insufficient_evidence');
  assert.equal(candidateBadgeLabel(candidateBadge(c1)), '[insufficient evidence]');
  const c2 = candidate({ validations: [val('pass', 'parse'), val('not_run', 'behavior')] });
  assert.equal(candidateBadge(c2), 'insufficient_evidence');
});

test('candidateBadge: any fail -> validation_failed (overrides skipped)', () => {
  const c = candidate({
    status: 'validation_failed',
    validations: [val('fail', 'compile'), val('skipped', 'behavior')],
  });
  assert.equal(candidateBadge(c), 'validation_failed');
  assert.equal(candidateBadgeLabel(candidateBadge(c)), '[validation_failed]');
});

test('candidateBadge: repair_failed / no hunks -> no_fix', () => {
  assert.equal(candidateBadge(candidate({ status: 'repair_failed', hunks: [] })), 'no_fix');
  // Empty hunks even with a non-failed status => no diff to show.
  assert.equal(candidateBadge(candidate({ hunks: [] })), 'no_fix');
  assert.equal(candidateBadgeLabel('no_fix'), '[no fix]');
});

// --- gate classification + judgment fail (D-023) ----------------------------

test('gateClass: format/compile are mechanical; semantic/violation_removal/regression are judgment', () => {
  assert.equal(gateClass('format'), 'mechanical');
  assert.equal(gateClass('compile'), 'mechanical');
  assert.equal(gateClass('semantic'), 'judgment');
  assert.equal(gateClass('violation_removal'), 'judgment');
  assert.equal(gateClass('regression'), 'judgment');
  // Unknown gate names default to mechanical (safe: blocks Accept).
  assert.equal(gateClass('something_new'), 'mechanical');
});

test('failingGatesByClass splits failing validations by class (ignores non-fail)', () => {
  const c = candidate({
    validations: [
      val('fail', 'compile'),
      val('pass', 'format'),
      val('fail', 'semantic', 'behaviour changed'),
      val('fail', 'regression', 'may regress'),
      val('skipped', 'violation_removal'),
    ],
  });
  const { mechanical, judgment } = failingGatesByClass(c);
  assert.deepEqual(mechanical.map((v) => v.name), ['compile']);
  assert.deepEqual(judgment.map((v) => v.name), ['semantic', 'regression']);
});

test('candidateBadge: only judgment fail(s) -> review_required (D-023)', () => {
  const c = candidate({
    status: 'validation_failed',
    validations: [val('pass', 'compile'), val('fail', 'semantic', 'behaviour changed')],
  });
  assert.equal(candidateBadge(c), 'review_required');
  assert.equal(candidateBadgeLabel('review_required'), '[review required]');
  assert.equal(candidateLabel('review_required'), 'Proposed fix [review required]');
});

test('candidateBadge: mechanical fail outranks a judgment fail (D-023 precedence)', () => {
  // Both a compile (mechanical) and a semantic (judgment) gate fail -> the
  // objective mechanical fault wins and Accept stays blocked.
  const c = candidate({
    status: 'validation_failed',
    validations: [val('fail', 'compile'), val('fail', 'semantic', 'behaviour changed')],
  });
  assert.equal(candidateBadge(c), 'validation_failed');
});

test('candidateBadge: judgment fail outranks skipped (D-023 precedence)', () => {
  const c = candidate({
    validations: [val('fail', 'violation_removal', 'still present'), val('skipped', 'compile')],
  });
  assert.equal(candidateBadge(c), 'review_required');
});

test('candidateLabel: "Proposed fix <badge>" leads the row (V1c-UX)', () => {
  assert.equal(candidateLabel('repair_ready'), 'Proposed fix [repair_ready]');
  assert.equal(candidateLabel('insufficient_evidence'), 'Proposed fix [insufficient evidence]');
  assert.equal(candidateLabel('validation_failed'), 'Proposed fix [validation_failed]');
  assert.equal(candidateLabel('no_fix'), 'Proposed fix [no fix]');
});

test('candidateTooltip: explanation + candidate_id + model in the tooltip', () => {
  const t = candidateTooltip(candidate({ model_identity: 'deepseek/x' }));
  assert.match(t, /guard the multiply/); // repair_explanation
  assert.match(t, /candidate_id: cand-1/);
  assert.match(t, /model: deepseek\/x/);
});

test('candidateTooltip: omits the model line when model_identity is absent', () => {
  const t = candidateTooltip(candidate({ model_identity: undefined }));
  assert.match(t, /candidate_id: cand-1/);
  assert.doesNotMatch(t, /model:/);
});

test('badgeAcceptable: repair_ready + insufficient_evidence + review_required yes; validation_failed + no_fix no', () => {
  assert.equal(badgeAcceptable('repair_ready'), true);
  assert.equal(badgeAcceptable('insufficient_evidence'), true); // D-017c: acceptable but flagged
  assert.equal(badgeAcceptable('review_required'), true); // D-023: acceptable with a warning
  assert.equal(badgeAcceptable('validation_failed'), false);
  assert.equal(badgeAcceptable('no_fix'), false);
});

test('badgeRequiresWarning: only review_required needs a warning (D-023)', () => {
  assert.equal(badgeRequiresWarning('review_required'), true);
  assert.equal(badgeRequiresWarning('repair_ready'), false);
  assert.equal(badgeRequiresWarning('insufficient_evidence'), false);
  assert.equal(badgeRequiresWarning('validation_failed'), false);
  assert.equal(badgeRequiresWarning('no_fix'), false);
});

test('acceptWarningMessage: "starting point" framing + each concern + responsibility (D-023)', () => {
  const msg = acceptWarningMessage([
    val('fail', 'semantic', 'behaviour changed for raw==0'),
    val('fail', 'regression'),
  ]);
  assert.match(msg, /Accept this candidate as a starting point\?/);
  assert.match(msg, /Judgment gates flagged it:/);
  assert.match(msg, /semantic: behaviour changed for raw==0/);
  assert.match(msg, /regression: \(no detail\)/);
  // The responsibility + verify step is stated.
  assert.match(msg, /remain responsible for completing any wider changes/);
  assert.match(msg, /re-scan to verify/);
});

test('truncateDetail leaves short strings intact', () => {
  assert.equal(truncateDetail('short', 10), 'short');
  assert.equal(truncateDetail('exactlyten', 10), 'exactlyten');
});

test('truncateDetail cuts long strings and appends an ellipsis', () => {
  const long = 'x'.repeat(200);
  const out = truncateDetail(long, 10);
  assert.equal(out.length, 10);
  assert.ok(out.endsWith('…'));
  assert.ok(!out.includes('xxxxxxxxxxx')); // 11 xs would exceed the cut
});

test('acceptWarningPickItems: concern rows + Accept-as-starting-point + Cancel, in order (D-023)', () => {
  const items = acceptWarningPickItems([
    val('fail', 'semantic', 'behaviour changed for raw==0'),
    val('fail', 'regression'),
  ]);
  // two concern rows, then Apply, then Cancel.
  assert.deepEqual(
    items.map((i) => i.action),
    ['concern', 'concern', 'apply', 'cancel'],
  );
  assert.match(items[0].label, /semantic/);
  assert.equal(items[0].detail, 'behaviour changed for raw==0');
  assert.equal(items[1].detail, '(no detail)'); // missing detail placeholder
  assert.match(items[2].label, /Accept as a starting point/);
  assert.match(items[2].detail ?? '', /complete any wider changes/);
  assert.match(items[2].detail ?? '', /re-scan/);
  assert.match(items[3].label, /Cancel/);
});

test('acceptWarningPickItems: no concerns -> just the two actions', () => {
  const items = acceptWarningPickItems([]);
  assert.deepEqual(
    items.map((i) => i.action),
    ['apply', 'cancel'],
  );
});

test('acceptWarningPickItems: over-long detail is truncated and Apply points to Output', () => {
  const detail = 'y'.repeat(CONCERN_DETAIL_MAX + 50);
  const items = acceptWarningPickItems([val('fail', 'semantic', detail)]);
  const concern = items.find((i) => i.action === 'concern')!;
  assert.ok((concern.detail ?? '').length <= CONCERN_DETAIL_MAX);
  assert.ok((concern.detail ?? '').endsWith('…'));
  const apply = items.find((i) => i.action === 'apply')!;
  assert.match(apply.detail ?? '', /Output channel/);
});

test('candidateHasDiff: false only for no_fix', () => {
  assert.equal(candidateHasDiff(candidate()), true);
  assert.equal(candidateHasDiff(candidate({ status: 'repair_failed', hunks: [] })), false);
});

// --- validation descriptor --------------------------------------------------

test('validationMark maps status to glyph', () => {
  assert.equal(validationMark('pass'), '✓');
  assert.equal(validationMark('fail'), '✗');
  assert.equal(validationMark('skipped'), '⚠');
  assert.equal(validationMark('not_run'), '·');
});

test('validationDescriptor renders `✓ name: status` and appends detail', () => {
  assert.equal(validationDescriptor(val('pass', 'compile')).label, '✓ compile: pass');
  assert.equal(
    validationDescriptor(val('skipped', 'compile', 'compiler not found')).label,
    '⚠ compile: skipped — compiler not found',
  );
  assert.equal(validationDescriptor(val('fail', 'semantic')).label, '✗ semantic: fail');
});

// --- hunk -> EditRange + offset correction (V1b-2, offset-correction method) --

const H_REPLACE: Hunk = { hunk_id: 'h', start_line: 5, line_count: 1, replacement_text: 'A\nB' };
const H_INSERT: Hunk = { hunk_id: 'i', start_line: 3, line_count: 0, replacement_text: 'NEW' };
const H_DELETE: Hunk = { hunk_id: 'd', start_line: 8, line_count: 2, replacement_text: '' };

test('hunkToEditRange: replace covers whole lines end-exclusive with trailing newline', () => {
  const r = hunkToEditRange(H_REPLACE);
  // line 5 (1-indexed) -> row 4; replace 1 line => end row 5.
  assert.deepEqual(
    { s: r.startLine, sc: r.startChar, e: r.endLine, ec: r.endChar, insert: r.insert },
    { s: 4, sc: 0, e: 5, ec: 0, insert: false },
  );
  assert.equal(r.text, 'A\nB\n');
});

test('hunkToEditRange: insert is zero-width at the start of the line', () => {
  const r = hunkToEditRange(H_INSERT);
  assert.deepEqual(
    { s: r.startLine, e: r.endLine, ec: r.endChar, insert: r.insert },
    { s: 2, e: 2, ec: 0, insert: true },
  );
  assert.equal(r.text, 'NEW\n');
});

test('hunkToEditRange applies a positive lineOffset to the row', () => {
  const r = hunkToEditRange(H_REPLACE, 3);
  assert.equal(r.startLine, 7); // (5-1) + 3
  assert.equal(r.endLine, 8);
});

test('hunkLineDelta: insert adds repl lines; replace adds (repl - n); delete removes n', () => {
  assert.equal(hunkLineDelta(H_INSERT), 1); // 'NEW' => 1 line inserted
  assert.equal(hunkLineDelta(H_REPLACE), 1); // 2 repl lines - 1 replaced = +1
  assert.equal(hunkLineDelta(H_DELETE), -2); // empty repl, delete 2 lines => -2
});

test('lineOffsetForStart sums deltas of accepted hunks strictly above the start', () => {
  // An accepted replace at line 5 that nets +2 lines; a pending hunk at line 26
  // shifts down by 2, but a pending hunk at line 5 (same start) does NOT shift.
  const accepted: Hunk[] = [
    { hunk_id: 'a', start_line: 5, line_count: 1, replacement_text: 'x\ny\nz' }, // +2
  ];
  assert.equal(lineOffsetForStart(26, accepted), 2);
  assert.equal(lineOffsetForStart(5, accepted), 0); // not strictly above
  assert.equal(lineOffsetForStart(1, accepted), 0); // above the accepted hunk
});

// The load-bearing property: accepting cand-001 then cand-002 (the real
// sample_sensor fixtures) via offset-corrected EditRanges equals applyHunks of
// both hunks together. We simulate the WorkspaceEdit by splicing lines.
const SENSOR_SRC = [
  '#include <stddef.h>',
  '#include <string.h>',
  '',
  'int scale_reading(int raw) {',
  '    int scaled = raw * 1000;',
  '    return scaled;',
  '}',
  '',
  'int average_two(int a, int b) {',
  '    return (a + b) / 2;',
  '}',
  '',
  'VehicleState next_state(VehicleState current) {',
  '    if (current == STATE_IDLE) {',
  '        return STATE_ACTIVE;',
  '    }',
  '    return current;',
  '}',
  '',
  'int over_threshold(void) {',
  '    int v = read_sensor(0);',
  '    return v > threshold;',
  '}',
  '',
  'void copy_label(char *dst, const char *src) {',
  '    strcpy(dst, src);',
  '}',
  '',
  'int sample_index(int i) {',
  '    int buf[8];',
  '    return buf[i];',
  '}',
  '',
].join('\n');

const CAND_001: RepairCandidate = candidate({
  candidate_id: 'cand-001',
  finding_id: 'find-scale-int32',
  hunks: [
    {
      hunk_id: 'hunk-scale-1',
      start_line: 5,
      line_count: 1,
      replacement_text:
        '    if (raw > INT_MAX / 1000 || raw < INT_MIN / 1000) {\n        return -1;\n    }\n    int scaled = raw * 1000;',
    },
  ],
});

const CAND_002: RepairCandidate = candidate({
  candidate_id: 'cand-002',
  finding_id: 'find-copy-str31',
  hunks: [
    {
      hunk_id: 'hunk-copy-1',
      start_line: 26,
      line_count: 1,
      replacement_text: '    size_t n = strlen(src);\n    memcpy(dst, src, n + 1);',
    },
  ],
});

/** Apply pure EditRanges to a text by whole-line splicing (mimics WorkspaceEdit). */
function applyEditRanges(text: string, ranges: ReturnType<typeof candidateToEditRanges>): string {
  const lines = text.split('\n');
  // Apply in descending start order so earlier splices don't shift later ones.
  const sorted = [...ranges].sort((a, b) => b.startLine - a.startLine);
  for (const r of sorted) {
    const count = r.insert ? 0 : r.endLine - r.startLine;
    // r.text ends in '\n'; splitting drops the trailing '' so we insert whole lines.
    const inserted = r.text.slice(0, -1).split('\n');
    lines.splice(r.startLine, count, ...inserted);
  }
  return lines.join('\n');
}

test('candidateToEditRanges: single accept equals applyHunks (cand-001)', () => {
  const ranges = candidateToEditRanges(CAND_001, []);
  const got = applyEditRanges(SENSOR_SRC, ranges);
  assert.equal(got, applyHunks(SENSOR_SRC, CAND_001.hunks));
});

test('candidateToEditRanges: sequential accepts with offset correction equal applyHunks of both', () => {
  // Accept cand-001 first (offset 0), then cand-002 against the edited doc.
  // The offset baseline is the accepted candidates' HUNKS (as acceptCandidate.ts
  // supplies via acceptedCandidates.flatMap(c => c.hunks)).
  const doc1 = applyEditRanges(SENSOR_SRC, candidateToEditRanges(CAND_001, []));
  const doc2 = applyEditRanges(doc1, candidateToEditRanges(CAND_002, CAND_001.hunks));
  // Order-independent oracle: applyHunks of both hunks on the pristine source.
  const oracle = applyHunks(SENSOR_SRC, [...CAND_001.hunks, ...CAND_002.hunks]);
  assert.equal(doc2, oracle);
});

test('candidateToEditRanges: accepting in the OTHER order also matches the oracle', () => {
  // cand-002 is below cand-001, so accepting it first needs no offset for cand-001.
  const doc1 = applyEditRanges(SENSOR_SRC, candidateToEditRanges(CAND_002, []));
  const doc2 = applyEditRanges(doc1, candidateToEditRanges(CAND_001, CAND_002.hunks));
  const oracle = applyHunks(SENSOR_SRC, [...CAND_001.hunks, ...CAND_002.hunks]);
  assert.equal(doc2, oracle);
});

// --- Accept guard (V1b-2, VSCODE_V1B_DESIGN.md §5) --------------------------

const HASH_A = 'sha256:' + 'a'.repeat(64);
const HASH_B = 'sha256:' + 'b'.repeat(64);

test('evaluateAcceptGuard: ok when hashes match, badge acceptable, no conflict', () => {
  const g = evaluateAcceptGuard(candidate(), HASH_A, HASH_A, []);
  assert.deepEqual(g, { ok: true });
});

test('evaluateAcceptGuard: stale when current hash != expected hash', () => {
  const g = evaluateAcceptGuard(candidate(), HASH_B, HASH_A, []);
  assert.equal(g.ok, false);
  if (!g.ok) assert.equal(g.reason, 'stale');
});

test('evaluateAcceptGuard: not_acceptable for validation_failed', () => {
  const c = candidate({
    status: 'validation_failed',
    validations: [val('fail', 'compile')],
  });
  const g = evaluateAcceptGuard(c, HASH_A, HASH_A, []);
  assert.equal(g.ok, false);
  if (!g.ok) assert.equal(g.reason, 'not_acceptable');
});

test('evaluateAcceptGuard: not_acceptable for no_fix (empty hunks)', () => {
  const g = evaluateAcceptGuard(candidate({ hunks: [] }), HASH_A, HASH_A, []);
  assert.equal(g.ok, false);
  if (!g.ok) assert.equal(g.reason, 'not_acceptable');
});

test('evaluateAcceptGuard: insufficient_evidence is still acceptable (D-017c)', () => {
  const c = candidate({ validations: [val('pass', 'parse'), val('skipped', 'compile')] });
  const g = evaluateAcceptGuard(c, HASH_A, HASH_A, []);
  assert.deepEqual(g, { ok: true });
});

test('evaluateAcceptGuard: judgment-only fail -> ok with a judgment warning (D-023)', () => {
  const c = candidate({
    status: 'validation_failed',
    validations: [val('pass', 'compile'), val('fail', 'semantic', 'behaviour changed')],
  });
  const g = evaluateAcceptGuard(c, HASH_A, HASH_A, []);
  assert.equal(g.ok, true);
  if (g.ok && 'warn' in g) {
    assert.equal(g.warn, 'judgment');
    assert.deepEqual(g.concerns.map((v) => v.name), ['semantic']);
    assert.match(g.message, /Accept this candidate as a starting point\?/);
    assert.match(g.message, /semantic: behaviour changed/);
  } else {
    assert.fail('expected an acceptWithWarning guard');
  }
});

test('evaluateAcceptGuard: mechanical fail stays not_acceptable even with a judgment fail (D-023)', () => {
  const c = candidate({
    status: 'validation_failed',
    validations: [val('fail', 'compile'), val('fail', 'semantic', 'behaviour changed')],
  });
  const g = evaluateAcceptGuard(c, HASH_A, HASH_A, []);
  assert.equal(g.ok, false);
  if (!g.ok) assert.equal(g.reason, 'not_acceptable');
});

test('evaluateAcceptGuard: stale outranks the judgment warning (D-023)', () => {
  const c = candidate({
    status: 'validation_failed',
    validations: [val('pass', 'compile'), val('fail', 'semantic', 'behaviour changed')],
  });
  const g = evaluateAcceptGuard(c, HASH_B, HASH_A, []);
  assert.equal(g.ok, false);
  if (!g.ok) assert.equal(g.reason, 'stale');
});

test('evaluateAcceptGuard: conflict outranks the judgment warning (D-023)', () => {
  const first = candidate({
    candidate_id: 'cand-A',
    hunks: [{ hunk_id: 'ha', start_line: 5, line_count: 2, replacement_text: 'x' }],
  });
  const second = candidate({
    candidate_id: 'cand-B',
    status: 'validation_failed',
    validations: [val('pass', 'compile'), val('fail', 'semantic', 'behaviour changed')],
    hunks: [{ hunk_id: 'hb', start_line: 6, line_count: 1, replacement_text: 'y' }],
  });
  const g = evaluateAcceptGuard(second, HASH_A, HASH_A, [first]);
  assert.equal(g.ok, false);
  if (!g.ok) assert.equal(g.reason, 'conflict');
});

test('evaluateAcceptGuard: conflict with an already-accepted overlapping candidate', () => {
  const first = candidate({
    candidate_id: 'cand-A',
    hunks: [{ hunk_id: 'ha', start_line: 5, line_count: 2, replacement_text: 'x' }],
  });
  const second = candidate({
    candidate_id: 'cand-B',
    hunks: [{ hunk_id: 'hb', start_line: 6, line_count: 1, replacement_text: 'y' }], // overlaps line 6
  });
  const g = evaluateAcceptGuard(second, HASH_A, HASH_A, [first]);
  assert.equal(g.ok, false);
  if (!g.ok && g.reason === 'conflict') assert.equal(g.conflictId, 'cand-A');
  else assert.fail('expected conflict');
});

test('evaluateAcceptGuard: non-overlapping accepted candidate is not a conflict', () => {
  const first = candidate({
    candidate_id: 'cand-A',
    hunks: [{ hunk_id: 'ha', start_line: 5, line_count: 1, replacement_text: 'x' }],
  });
  const second = candidate({
    candidate_id: 'cand-B',
    hunks: [{ hunk_id: 'hb', start_line: 26, line_count: 1, replacement_text: 'y' }],
  });
  assert.deepEqual(evaluateAcceptGuard(second, HASH_A, HASH_A, [first]), { ok: true });
});

// --- validation CodeLens titles (candidate diff right pane) ------------------

test('buildValidationLensTitles: all pass -> single ✓ N/N summary (no per-gate lens)', () => {
  const c = candidate({ validations: [val('pass', 'parse'), val('pass', 'compile')] });
  const items = buildValidationLensTitles(c);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, '✓ 2/2 validation gates passed');
  // The summary lens has no single gate to open the full detail for.
  assert.equal(items[0].validation, undefined);
});

test('buildValidationLensTitles: a failing gate -> ✗ <gate>: <detail>, no pass summary', () => {
  const c = candidate({
    validations: [val('pass', 'compile'), val('fail', 'semantic', 'behaviour changed')],
  });
  const items = buildValidationLensTitles(c);
  // The concern, then the judgment-fail workflow guidance lens (no all-pass summary).
  assert.equal(items.length, 2);
  assert.equal(items[0].title, '✗ semantic: behaviour changed');
  assert.equal(items[0].validation?.name, 'semantic');
  assert.equal(items[1].title, JUDGMENT_FAIL_GUIDANCE_LENS);
  assert.equal(items[1].validation, undefined);
});

test('buildValidationLensTitles: skipped/not_run -> ⚠ <gate>: <status> — <detail>', () => {
  const c = candidate({
    validations: [
      val('pass', 'compile'),
      val('skipped', 'behavior_check', 'No behavioral oracle in fixtures.'),
      val('not_run', 'regression'),
    ],
  });
  const items = buildValidationLensTitles(c);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, '⚠ behavior_check: skipped — No behavioral oracle in fixtures.');
  // A skipped gate with no detail renders just the head (no trailing dash).
  assert.equal(items[1].title, '· regression: not_run');
});

test('buildValidationLensTitles: mixed -> fails first, then skipped (never a pass summary)', () => {
  const c = candidate({
    validations: [
      val('pass', 'format'),
      val('skipped', 'behavior_check', 'no oracle'),
      val('fail', 'semantic', 'signature changed'),
      val('fail', 'regression', 'still present'),
    ],
  });
  const items = buildValidationLensTitles(c);
  const titles = items.map((i) => i.title);
  assert.deepEqual(titles, [
    '✗ semantic: signature changed',
    '✗ regression: still present',
    '⚠ behavior_check: skipped — no oracle',
    // A judgment gate failed -> the workflow-guidance lens trails the concerns.
    JUDGMENT_FAIL_GUIDANCE_LENS,
  ]);
});

test('buildValidationLensTitles: long fail detail is 1-lined and truncated', () => {
  const longDetail = 'Function signature of copy_label changed. ' + 'x'.repeat(300);
  const c = candidate({ validations: [val('fail', 'semantic', longDetail)] });
  const items = buildValidationLensTitles(c);
  // The concern lens + the trailing judgment-fail guidance lens.
  assert.equal(items.length, 2);
  const title = items[0].title;
  assert.ok(title.startsWith('✗ semantic: Function signature of copy_label changed.'));
  // Ellipsis + capped to the detail max (title = "✗ semantic: " + <=LENS_DETAIL_MAX).
  assert.ok(title.endsWith('…'), 'expected an ellipsis on truncation');
  assert.ok(title.length <= '✗ semantic: '.length + LENS_DETAIL_MAX);
});

test('buildValidationLensTitles: multi-line fail detail collapses to first line', () => {
  const c = candidate({
    validations: [val('fail', 'semantic', 'first line reason\nsecond line ignored\nthird')],
  });
  const items = buildValidationLensTitles(c);
  assert.equal(items[0].title, '✗ semantic: first line reason');
});

test('buildValidationLensTitles: a MECHANICAL-only fail gets NO judgment guidance lens', () => {
  // compile is mechanical (blocks Accept); guidance is only for judgment calls.
  const c = candidate({ validations: [val('fail', 'compile', 'undefined reference')] });
  const items = buildValidationLensTitles(c);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, '✗ compile: undefined reference');
  assert.ok(
    !items.some((i) => i.title === JUDGMENT_FAIL_GUIDANCE_LENS),
    'no workflow-guidance lens for a mechanical-only fail',
  );
});

test('buildValidationLensTitles: judgment guidance lens is non-clickable context text', () => {
  const c = candidate({ validations: [val('fail', 'violation_removal', 'still present')] });
  const items = buildValidationLensTitles(c);
  const guidance = items.find((i) => i.title === JUDGMENT_FAIL_GUIDANCE_LENS);
  assert.ok(guidance, 'a violation_removal (judgment) fail appends the guidance lens');
  // Context text, not a gate: it opens no validation detail (undefined validation).
  assert.equal(guidance!.validation, undefined);
});

test('JUDGMENT_FAIL_GUIDANCE states the options and the re-scan step', () => {
  // The workflow context layered on top of the certfix-derived per-gate detail.
  assert.match(JUDGMENT_FAIL_GUIDANCE, /starting point/);
  assert.match(JUDGMENT_FAIL_GUIDANCE, /callers/);
  assert.match(JUDGMENT_FAIL_GUIDANCE, /re-scan/);
  // The lens form is the guidance behind an info glyph.
  assert.ok(JUDGMENT_FAIL_GUIDANCE_LENS.endsWith(JUDGMENT_FAIL_GUIDANCE));
});

test('STALE_RESULTS_MESSAGE states the reason and the next step (D-006)', () => {
  assert.match(STALE_RESULTS_MESSAGE, /previous document contents/);
  assert.match(STALE_RESULTS_MESSAGE, /scan again/);
});
