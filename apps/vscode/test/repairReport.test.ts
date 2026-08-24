// Unit tests for the Export Repair Report builder (session/repairReport.ts):
// each of the 6 sections (identity / scope / disposition table / overrides /
// evidence / disclaimer), the table's completeness (accepted + rejected +
// unrepaired all appear), the override section, the unified-diff accuracy, the
// disclaimer text, and the Codex noise guard (no cost / token / prompt strings).
// Pure Node — no `vscode` module.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  buildRepairReport,
  dispositionRows,
  findingState,
  findingRuleLabel,
  cleanFunctionCount,
  hunkUnifiedDiff,
  candidateUnifiedDiff,
  unresolvedReason,
  proposedSummaryLine,
  REPORT_DISCLAIMER,
  DETECTION_SCOPE_NOTE,
  REJECTED_REFERENCE_WARNING,
  type RepairReportInput,
  type CandidateDisposition,
} from '../src/session/repairReport';
import type {
  FunctionScanResult,
  ScanFunction,
  Finding,
  RepairCandidate,
  Validation,
  Hunk,
} from '@c-repair/contract';

// A 12-line Original C so line numbers in hunks/diffs are exercisable.
const ORIGINAL = [
  '#include <stdio.h>',
  '',
  'int add(int a, int b) {',
  '  int c = a + b;',
  '  return c;',
  '}',
  '',
  'int scale(int x) {',
  '  int r = x * 2;',
  '  return r;',
  '}',
  '',
].join('\n');

function sha(content: string): string {
  return 'sha256:' + createHash('sha256').update(content, 'utf8').digest('hex');
}

function val(name: string, status: Validation['status'], detail?: string): Validation {
  return detail ? { name, status, detail } : { name, status };
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    finding_id: 'f-1',
    kind: 'violation',
    rule_id: 'INT32-C',
    rule_summary: 'Ensure that operations on signed integers do not result in overflow',
    explanation: 'a + b may overflow',
    location: { start_line: 4, end_line: 4 },
    assumption_dependent: false,
    ...overrides,
  };
}

function candidate(overrides: Partial<RepairCandidate> = {}): RepairCandidate {
  return {
    candidate_id: 'cand-1',
    finding_id: 'f-1',
    function_id: 'fn-1',
    source_id: 'src-1',
    original_hash: sha(ORIGINAL),
    context_revision_id: 'rev-1',
    status: 'repair_ready',
    repair_explanation: 'Use a checked addition.',
    hunks: [
      { hunk_id: 'h1', start_line: 4, line_count: 1, replacement_text: '  int c;\n  if (__builtin_add_overflow(a, b, &c)) return -1;' },
    ],
    validations: [val('format', 'pass'), val('compile', 'pass'), val('semantic', 'pass')],
    model_identity: 'deepseek/deepseek-v4-flash-0731',
    ...overrides,
  };
}

function makeInput(
  functions: ScanFunction[],
  cands: RepairCandidate[],
  dispos: Record<string, CandidateDisposition>,
  overrides: Partial<RepairReportInput> = {},
): RepairReportInput {
  const scan: FunctionScanResult = {
    scan_id: 'scan-1',
    source_id: 'src-1',
    original_hash: sha(ORIGINAL),
    context_revision_id: 'rev-1',
    rule_profile: { id: 'cert-c', version: '1' },
    adapter: { id: 'certfix-inprocess', version: '0.1.0' },
    harness: { id: 'certfix', version: '0.4.1' },
    functions,
  };
  const byFinding = new Map<string, RepairCandidate>();
  for (const c of cands) byFinding.set(c.finding_id, c);
  const byCand = new Map<string, CandidateDisposition>(Object.entries(dispos));
  return {
    generatedAtIso: '2026-08-24T00:00:00.000Z',
    filename: 'sample.c',
    originalHash: sha(ORIGINAL),
    expectedHash: sha(ORIGINAL),
    extensionVersion: '0.1.0',
    ruleProfile: scan.rule_profile,
    model: { model: 'deepseek/deepseek-v4-flash-0731', mode: 'Preset' },
    scan,
    contextStillMissing: undefined,
    contextProvenance: [],
    candidateForFinding: (id) => byFinding.get(id),
    dispositionForCandidate: (id) =>
      byCand.get(id) ?? { decision: 'pending', overrode: false },
    includeRejectedProposals: false,
    ...overrides,
  };
}

function fn(name: string, id: string, findings: Finding[], range = { start_line: 3, end_line: 6 }): ScanFunction {
  return { function_id: id, name, original_range: range, findings };
}

// --- §1 identity ------------------------------------------------------------

test('§1 identity is the six-line trim: file/generated/tool/rule set/model/integrity', () => {
  const md = buildRepairReport(makeInput([], [], {}), ORIGINAL);
  assert.match(md, /## 1\. Report identity & integrity/);
  assert.match(md, /\*\*File:\*\* sample\.c/);
  assert.match(md, /\*\*Tool:\*\* C Repair 0\.1\.0/);
  // cert-c is spelled out as "CERT C" with the catalog version, so a reviewer
  // can tell which rule-set edition judged the file without decoding raw ids.
  assert.match(md, /\*\*Rule set:\*\* CERT C — catalog `1` \(the rule set bundled with this harness release\)/);
  assert.match(md, /\*\*Model:\*\* deepseek\/deepseek-v4-flash-0731 \(mode: Preset\)/);
  assert.match(md, new RegExp('Integrity:\\*\\* original SHA-256 `' + sha(ORIGINAL).replace(/[/]/g, '\\/') + '`'));
  // Cut as non-evidence (user + Codex trim): harness/adapter/extension-version
  // lines and the visible internal ids. The scan id survives only as an
  // invisible, schema-versioned support comment.
  assert.ok(!/\*\*Harness:\*\*/.test(md));
  assert.ok(!/\*\*Adapter:\*\*/.test(md));
  assert.ok(!/\*\*Extension version:\*\*/.test(md));
  assert.ok(!/\*\*Scan id:\*\*/.test(md));
  assert.ok(!/\*\*Context revision:\*\*/.test(md));
  assert.match(md, /<!-- c-repair-support: scan-id=scan-1 -->/);
});

test('§1 applied-result hash reads "unchanged" when nothing accepted', () => {
  const md = buildRepairReport(makeInput([], [], {}), ORIGINAL);
  assert.match(md, /applied-result unchanged \(no repairs accepted\)/);
});

test('§1 applied-result hash shows the post-accept hash when repairs accepted', () => {
  const post = sha(ORIGINAL + 'x');
  const md = buildRepairReport(makeInput([], [], {}, { expectedHash: post }), ORIGINAL);
  assert.ok(md.includes(post), 'the post-accept expected hash is printed verbatim');
  assert.doesNotMatch(md, /applied-result unchanged/);
});

// --- §2 scope ---------------------------------------------------------------

test('§2 scope states single translation unit + self-contained context', () => {
  const md = buildRepairReport(makeInput([], [], {}), ORIGINAL);
  assert.match(md, /## 2\. Scope & limitations/);
  assert.match(md, /single translation unit/);
  assert.match(md, /out of scope/);
  assert.match(md, /self-contained input/);
});

test('§2 scope reports confirmed-context provenance breakdown', () => {
  const md = buildRepairReport(
    makeInput([], [], {}, {
      contextProvenance: [
        { provenance: 'llm_inferred', count: 2 },
        { provenance: 'derived_from_usage', count: 1 },
      ],
    }),
    ORIGINAL,
  );
  assert.match(md, /3 inferred declaration\(s\) were confirmed/);
  assert.match(md, /2 llm_inferred/);
  assert.match(md, /1 derived_from_usage/);
});

test('§2 scope flags still-missing symbols with the detection-gap caveat (D-032)', () => {
  const md = buildRepairReport(makeInput([], [], {}, { contextStillMissing: 5 }), ORIGINAL);
  assert.match(md, /Context incomplete:\*\* 5 symbol\(s\) remained/);
  assert.match(md, /\*\*0 violations is not a safety guarantee\*\*/);
});

test('§2 scope notes a skipped compile gate on an accepted candidate', () => {
  const f = finding();
  const c = candidate({
    validations: [val('format', 'pass'), val('compile', 'skipped', 'no include paths')],
  });
  const md = buildRepairReport(
    makeInput([fn('add', 'fn-1', [f])], [c], { 'cand-1': { decision: 'accepted', overrode: false } }),
    ORIGINAL,
  );
  assert.match(md, /Compile gate was \*\*skipped\*\*/);
});

// --- §3 disposition table completeness --------------------------------------

test('§3 table lists accepted + rejected + unrepaired findings, one row each', () => {
  const fRepaired = finding({ finding_id: 'f-r', rule_id: 'INT32-C', location: { start_line: 4, end_line: 4 } });
  const fRejected = finding({ finding_id: 'f-x', rule_id: 'EXP34-C', rule_summary: 'Do not dereference null pointers', location: { start_line: 9, end_line: 9 } });
  const fUncertain = finding({ finding_id: 'f-u', kind: 'uncertain', rule_id: undefined, rule_summary: 'possible issue', location: { start_line: 5, end_line: 5 } });

  const cR = candidate({ candidate_id: 'c-r', finding_id: 'f-r' });
  const cX = candidate({ candidate_id: 'c-x', finding_id: 'f-x' });

  const input = makeInput(
    [
      fn('add', 'fn-1', [fRepaired]),
      fn('scale', 'fn-2', [fRejected]),
      fn('probe', 'fn-3', [fUncertain]),
      fn('helper', 'fn-4', []), // CLEAN
    ],
    [cR, cX],
    {
      'c-r': { decision: 'accepted', overrode: false },
      'c-x': { decision: 'rejected', overrode: false },
    },
  );
  const rows = dispositionRows(input);
  assert.equal(rows.length, 3, 'CLEAN function contributes no row');
  const byFn = Object.fromEntries(rows.map((r) => [r.functionName, r.state]));
  assert.equal(byFn['add'], 'REPAIRED');
  assert.equal(byFn['scale'], 'REJECTED');
  assert.equal(byFn['probe'], 'UNREPAIRED'); // uncertain is never repairable

  const md = buildRepairReport(input, ORIGINAL);
  assert.match(md, /## 3\. Finding disposition/);
  assert.match(md, /\| add \| INT32-C:.*\| REPAIRED \|/);
  assert.match(md, /\| scale \| EXP34-C:.*\| REJECTED \|/);
  assert.match(md, /\| probe \| possible issue \| UNREPAIRED \|/);
  assert.match(md, /Clean functions \(no findings\): 1 of 4 scanned/);
});

test('cleanFunctionCount counts only functions with no findings', () => {
  const functions = [
    fn('a', 'fn-1', [finding()]),
    fn('b', 'fn-2', []),
    fn('c', 'fn-3', []),
  ];
  assert.equal(cleanFunctionCount(functions), 2);
});

test('findingRuleLabel: violation with id, violation without id, uncertain', () => {
  assert.equal(findingRuleLabel(finding()), 'INT32-C: Ensure that operations on signed integers do not result in overflow');
  assert.equal(
    findingRuleLabel(finding({ rule_id: undefined, rule_summary: 'bare summary' })),
    'bare summary',
  );
});

// D-039 legal kill-switch: with CREPAIR_RULE_TITLES=off the finding's rule_summary
// is empty, so the Repair Report §3 table / §4 / §5 label must be the rule ID alone.
test('findingRuleLabel: empty rule_summary renders the rule id alone (IDs-only)', () => {
  assert.equal(findingRuleLabel(finding({ rule_summary: '' })), 'INT32-C');
  assert.equal(findingRuleLabel(finding({ rule_summary: '   ' })), 'INT32-C');
});

test('findingState maps decision + override correctly', () => {
  const f = finding();
  const c = candidate();
  assert.deepEqual(findingState(f, c, { decision: 'accepted', overrode: true }), {
    state: 'REPAIRED',
    overrode: true,
  });
  assert.deepEqual(findingState(f, c, { decision: 'rejected', overrode: false }), {
    state: 'REJECTED',
    overrode: false,
  });
  // Pending + diffable candidate -> PROPOSED (awaiting review), not UNREPAIRED.
  assert.deepEqual(findingState(f, c, { decision: 'pending', overrode: false }), {
    state: 'PROPOSED',
    overrode: false,
  });
  // No candidate / uncertain -> UNREPAIRED, override never leaks.
  assert.deepEqual(findingState(f, undefined, undefined), { state: 'UNREPAIRED', overrode: false });
  assert.deepEqual(
    findingState(finding({ kind: 'uncertain', rule_id: undefined }), c, {
      decision: 'accepted',
      overrode: true,
    }),
    { state: 'UNREPAIRED', overrode: false },
  );
});

test('findingState: pending PROPOSED needs a diffable candidate (hunks>0, not repair_failed)', () => {
  const f = finding();
  const pending = { decision: 'pending' as const, overrode: false };
  // repair_failed / hunkless pending candidates offer nothing to review.
  assert.deepEqual(
    findingState(f, candidate({ hunks: [], status: 'repair_failed' }), pending),
    { state: 'UNREPAIRED', overrode: false },
  );
  assert.deepEqual(
    findingState(f, candidate({ hunks: [] }), pending),
    { state: 'UNREPAIRED', overrode: false },
  );
  // A validation_failed candidate with hunks IS proposed (its status is shown in §5).
  assert.deepEqual(
    findingState(f, candidate({ status: 'validation_failed' }), pending),
    { state: 'PROPOSED', overrode: false },
  );
});

// --- §4 overrides & unresolved risks ----------------------------------------

test('§4 lists a judgment-override accept with the gate name + fail reason', () => {
  const f = finding();
  const c = candidate({
    status: 'validation_failed',
    validations: [
      val('format', 'pass'),
      val('compile', 'pass'),
      val('semantic', 'fail', 'The fixed code changes the return contract for callers.'),
    ],
  });
  const md = buildRepairReport(
    makeInput([fn('add', 'fn-1', [f])], [c], { 'cand-1': { decision: 'accepted', overrode: true } }),
    ORIGINAL,
  );
  assert.match(md, /## 4\. Overrides & unresolved risks/);
  assert.match(md, /Accepted over a judgment-gate warning/);
  assert.match(md, /`semantic`: The fixed code changes the return contract/);
  // The §3 table override column shows the override too.
  assert.match(md, /\| add \|.*\| REPAIRED \| yes \(judgment gate\) \|/);
});

test('§4 lists unresolved (rejected + unrepaired) violations with reasons', () => {
  const fRej = finding({ finding_id: 'f-x', rule_id: 'EXP34-C', location: { start_line: 9, end_line: 9 } });
  const fNone = finding({ finding_id: 'f-none', rule_id: 'STR31-C', rule_summary: 'Bound string copies', location: { start_line: 5, end_line: 5 } });
  const cX = candidate({ candidate_id: 'c-x', finding_id: 'f-x' });
  const md = buildRepairReport(
    makeInput(
      [fn('scale', 'fn-2', [fRej]), fn('add', 'fn-1', [fNone])],
      [cX],
      { 'c-x': { decision: 'rejected', overrode: false } },
    ),
    ORIGINAL,
  );
  assert.match(md, /Unresolved violations/);
  assert.match(md, /scale — EXP34-C.*\(REJECTED\): rejected by the reviewer/);
  assert.match(md, /add — STR31-C.*\(UNREPAIRED\): no repair was generated/);
});

test('§4 says none when there are no overrides and no unresolved violations', () => {
  const f = finding();
  const c = candidate();
  const md = buildRepairReport(
    makeInput([fn('add', 'fn-1', [f])], [c], { 'cand-1': { decision: 'accepted', overrode: false } }),
    ORIGINAL,
  );
  assert.match(md, /No overrides and no unresolved violations/);
});

test('unresolvedReason distinguishes reject / no candidate / no fix / blocked / pending', () => {
  const base = { functionName: 'f', rule: 'R', overrode: false, finding: finding(), disposition: undefined };
  assert.match(unresolvedReason({ ...base, state: 'REJECTED', candidate: candidate() }), /rejected by the reviewer/);
  assert.match(unresolvedReason({ ...base, state: 'UNREPAIRED', candidate: undefined }), /no repair was generated/);
  assert.match(
    unresolvedReason({ ...base, state: 'UNREPAIRED', candidate: candidate({ hunks: [], status: 'repair_failed' }) }),
    /no fix could be produced/,
  );
  assert.match(
    unresolvedReason({
      ...base,
      state: 'UNREPAIRED',
      candidate: candidate({ validations: [val('compile', 'fail', 'undeclared identifier')] }),
    }),
    /blocked by a failing gate — compile: undeclared identifier/,
  );
  assert.match(
    unresolvedReason({ ...base, state: 'UNREPAIRED', candidate: candidate() }),
    /left pending/,
  );
});

// --- §5 evidence + unified diff accuracy ------------------------------------

test('hunkUnifiedDiff: replace produces correct -/+ lines with 3 lines context', () => {
  // Replace line 4 ("  int c = a + b;") with two lines.
  const h: Hunk = {
    hunk_id: 'h1',
    start_line: 4,
    line_count: 1,
    replacement_text: '  int c;\n  c = checked(a, b);',
  };
  const diff = hunkUnifiedDiff(ORIGINAL, h, 3);
  // Removed line is the original line 4.
  assert.match(diff, /^-  int c = a \+ b;$/m);
  // Added lines are the replacement.
  assert.match(diff, /^\+  int c;$/m);
  assert.match(diff, /^\+  c = checked\(a, b\);$/m);
  // Context (unchanged) lines are prefixed with a space, not removed/added.
  assert.match(diff, /^ int add\(int a, int b\) \{$/m); // line 3, context before
  assert.match(diff, /^   return c;$/m); // line 5, context after (leading space + "  return c;")
  // Header present with Original-based numbers.
  assert.match(diff, /^@@ -\d+,\d+ \+\d+,\d+ @@$/m);
});

test('hunkUnifiedDiff: insertion (line_count=0) removes nothing, adds before start', () => {
  const h: Hunk = { hunk_id: 'h1', start_line: 3, line_count: 0, replacement_text: '/* comment */' };
  const diff = hunkUnifiedDiff(ORIGINAL, h, 2);
  assert.match(diff, /^\+\/\* comment \*\/$/m);
  // No removal line for a pure insertion.
  assert.doesNotMatch(diff, /^-/m);
  // The line at start (line 3) appears as context (added before it).
  assert.match(diff, /^ int add\(int a, int b\) \{$/m);
});

test('hunkUnifiedDiff: pure deletion (empty replacement, n>0) removes only', () => {
  const h: Hunk = { hunk_id: 'h1', start_line: 4, line_count: 1, replacement_text: '' };
  const diff = hunkUnifiedDiff(ORIGINAL, h, 1);
  assert.match(diff, /^-  int c = a \+ b;$/m);
  assert.doesNotMatch(diff, /^\+/m);
});

test('candidateUnifiedDiff joins every hunk', () => {
  const c = candidate({
    hunks: [
      { hunk_id: 'h1', start_line: 4, line_count: 1, replacement_text: '  int c = 0;' },
      { hunk_id: 'h2', start_line: 9, line_count: 1, replacement_text: '  int r = 0;' },
    ],
  });
  const diff = candidateUnifiedDiff(ORIGINAL, c, 1);
  assert.match(diff, /-  int c = a \+ b;/);
  assert.match(diff, /-  int r = x \* 2;/);
});

test('§5 puts overrides/unresolved before plain accepted, and only accepted get a diff', () => {
  const fOver = finding({ finding_id: 'f-over', rule_id: 'INT32-C', location: { start_line: 4, end_line: 4 } });
  const fPlain = finding({ finding_id: 'f-plain', rule_id: 'STR31-C', rule_summary: 'Bound copies', location: { start_line: 9, end_line: 9 } });
  const fRej = finding({ finding_id: 'f-rej', rule_id: 'EXP34-C', rule_summary: 'Null deref', location: { start_line: 5, end_line: 5 } });

  const cOver = candidate({ candidate_id: 'c-over', finding_id: 'f-over', validations: [val('semantic', 'fail', 'wider change needed')] });
  const cPlain = candidate({ candidate_id: 'c-plain', finding_id: 'f-plain', hunks: [{ hunk_id: 'hp', start_line: 9, line_count: 1, replacement_text: '  int r = safe(x);' }] });
  const cRej = candidate({ candidate_id: 'c-rej', finding_id: 'f-rej' });

  const md = buildRepairReport(
    makeInput(
      [fn('add', 'fn-1', [fOver]), fn('scale', 'fn-2', [fPlain]), fn('probe', 'fn-3', [fRej])],
      [cOver, cPlain, cRej],
      {
        'c-over': { decision: 'accepted', overrode: true },
        'c-plain': { decision: 'accepted', overrode: false },
        'c-rej': { decision: 'rejected', overrode: false },
      },
    ),
    ORIGINAL,
  );

  // Anchor to §5 (the evidence appendix) so we don't pick up §3/§4 mentions.
  const evidence = md.slice(md.indexOf('## 5. Per-finding evidence'));
  const idxOver = evidence.indexOf('add — INT32-C');
  const idxRej = evidence.indexOf('probe — EXP34-C');
  const idxPlain = evidence.indexOf('scale — STR31-C');
  assert.ok(idxOver >= 0 && idxRej >= 0 && idxPlain >= 0);
  // override + unresolved appear before the plain accepted candidate.
  assert.ok(idxOver < idxPlain, 'override before plain accepted');
  assert.ok(idxRej < idxPlain, 'rejected before plain accepted');

  // Only accepted candidates render a diff; the rejected one does not (D-004).
  // The rejected candidate's evidence section spans from its heading to the next.
  const rejSection = evidence.slice(idxRej, idxPlain);
  assert.doesNotMatch(rejSection, /```diff/);
  // The plain accepted candidate DOES carry its diff.
  const plainSection = evidence.slice(idxPlain);
  assert.match(plainSection, /```diff/);
  assert.match(plainSection, /-  int r = x \* 2;/);
});

test('§5 gate evidence: passes as ✓ list, fail with full detail, skipped noted', () => {
  const f = finding();
  const c = candidate({
    validations: [
      val('format', 'pass'),
      val('compile', 'skipped', 'no include paths supplied'),
      val('semantic', 'fail', 'The reviewer must confirm the return-value contract.'),
    ],
  });
  const md = buildRepairReport(
    makeInput([fn('add', 'fn-1', [f])], [c], { 'cand-1': { decision: 'accepted', overrode: true } }),
    ORIGINAL,
  );
  assert.match(md, /✓ passed: format/);
  assert.match(md, /`compile`: skipped — no include paths supplied/);
  assert.match(md, /`semantic`: fail — The reviewer must confirm the return-value contract/);
});

// --- PROPOSED (review-pending candidates, user feedback round) ---------------

test('§3 an undecided diffable candidate renders as PROPOSED with Override "—"', () => {
  const f = finding();
  const c = candidate(); // no disposition recorded -> pending
  const md = buildRepairReport(makeInput([fn('add', 'fn-1', [f])], [c], {}), ORIGINAL);
  assert.match(md, /\| add \| INT32-C:.*\| PROPOSED \| — \|/);
  assert.doesNotMatch(md, /\| add \|.*\| UNREPAIRED \|/);
});

test('headline counts proposed fixes (plural / singular) and vanishes when all decided', () => {
  const f1 = finding({ finding_id: 'f-1' });
  const f2 = finding({ finding_id: 'f-2', rule_id: 'EXP34-C', location: { start_line: 9, end_line: 9 } });
  const c1 = candidate({ candidate_id: 'c-1', finding_id: 'f-1' });
  const c2 = candidate({ candidate_id: 'c-2', finding_id: 'f-2' });

  // Two undecided -> plural headline.
  const mdTwo = buildRepairReport(
    makeInput([fn('add', 'fn-1', [f1]), fn('scale', 'fn-2', [f2])], [c1, c2], {}),
    ORIGINAL,
  );
  assert.match(mdTwo, /\*\*2 proposed fixes awaiting review\*\*/);
  assert.match(mdTwo, /review-in-progress digest/);

  // One undecided -> singular.
  const mdOne = buildRepairReport(
    makeInput([fn('add', 'fn-1', [f1]), fn('scale', 'fn-2', [f2])], [c1, c2], {
      'c-1': { decision: 'accepted', overrode: false },
    }),
    ORIGINAL,
  );
  assert.match(mdOne, /\*\*1 proposed fix awaiting review\*\*/);

  // All decided -> the headline (and the NOT-applied marker) disappear entirely.
  const mdDone = buildRepairReport(
    makeInput([fn('add', 'fn-1', [f1]), fn('scale', 'fn-2', [f2])], [c1, c2], {
      'c-1': { decision: 'accepted', overrode: false },
      'c-2': { decision: 'rejected', overrode: false },
    }),
    ORIGINAL,
  );
  assert.doesNotMatch(mdDone, /awaiting review/);
  assert.doesNotMatch(mdDone, /NOT applied/);
  assert.doesNotMatch(mdDone, /PROPOSED/);
});

test('proposedSummaryLine is undefined when no rows are PROPOSED', () => {
  const f = finding();
  const c = candidate();
  const input = makeInput([fn('add', 'fn-1', [f])], [c], {
    'cand-1': { decision: 'accepted', overrode: false },
  });
  assert.equal(proposedSummaryLine(dispositionRows(input)), undefined);
});

test('§4 excludes PROPOSED (pending work is not an unresolved risk)', () => {
  const f = finding();
  const c = candidate(); // undecided -> PROPOSED
  const md = buildRepairReport(makeInput([fn('add', 'fn-1', [f])], [c], {}), ORIGINAL);
  assert.match(md, /No overrides and no unresolved violations/);
  const risks = md.slice(md.indexOf('## 4.'), md.indexOf('## 5.'));
  assert.doesNotMatch(risks, /PROPOSED/);
});

test('§5 orders PROPOSED first, then override/unresolved, then plain accepted', () => {
  const fProp = finding({ finding_id: 'f-prop', rule_id: 'ERR34-C', rule_summary: 'Detect conversion errors', location: { start_line: 5, end_line: 5 } });
  const fOver = finding({ finding_id: 'f-over', rule_id: 'INT32-C', location: { start_line: 4, end_line: 4 } });
  const fRej = finding({ finding_id: 'f-rej', rule_id: 'EXP34-C', rule_summary: 'Null deref', location: { start_line: 10, end_line: 10 } });
  const fPlain = finding({ finding_id: 'f-plain', rule_id: 'STR31-C', rule_summary: 'Bound copies', location: { start_line: 9, end_line: 9 } });

  const cProp = candidate({ candidate_id: 'c-prop', finding_id: 'f-prop' });
  const cOver = candidate({ candidate_id: 'c-over', finding_id: 'f-over', validations: [val('semantic', 'fail', 'wider change needed')] });
  const cRej = candidate({ candidate_id: 'c-rej', finding_id: 'f-rej' });
  const cPlain = candidate({ candidate_id: 'c-plain', finding_id: 'f-plain', hunks: [{ hunk_id: 'hp', start_line: 9, line_count: 1, replacement_text: '  int r = safe(x);' }] });

  const md = buildRepairReport(
    makeInput(
      [
        fn('parse', 'fn-0', [fProp]),
        fn('add', 'fn-1', [fOver]),
        fn('probe', 'fn-3', [fRej]),
        fn('scale', 'fn-2', [fPlain]),
      ],
      [cProp, cOver, cRej, cPlain],
      {
        'c-over': { decision: 'accepted', overrode: true },
        'c-rej': { decision: 'rejected', overrode: false },
        'c-plain': { decision: 'accepted', overrode: false },
      },
    ),
    ORIGINAL,
  );

  const evidence = md.slice(md.indexOf('## 5. Per-finding evidence'));
  const idxProp = evidence.indexOf('parse — ERR34-C');
  const idxOver = evidence.indexOf('add — INT32-C');
  const idxRej = evidence.indexOf('probe — EXP34-C');
  const idxPlain = evidence.indexOf('scale — STR31-C');
  assert.ok(idxProp >= 0 && idxOver >= 0 && idxRej >= 0 && idxPlain >= 0);
  assert.ok(idxProp < idxOver, 'proposed leads the appendix (action items first)');
  assert.ok(idxOver < idxPlain, 'override before plain accepted');
  assert.ok(idxRej < idxPlain, 'rejected before plain accepted');
});

test('§5 a PROPOSED candidate carries the NOT-applied heading, its status, and the diff', () => {
  const f = finding();
  const c = candidate({ status: 'validation_failed', validations: [val('compile', 'fail', 'undeclared identifier')] });
  const md = buildRepairReport(makeInput([fn('add', 'fn-1', [f])], [c], {}), ORIGINAL);

  const evidence = md.slice(md.indexOf('## 5. Per-finding evidence'));
  assert.match(evidence, /\[PROPOSED\]/);
  assert.match(evidence, /_Candidate status: validation_failed — no decision recorded yet\._/);
  assert.match(
    evidence,
    /\*\*Proposed change \(NOT applied — review pending, unified diff, Original C basis\):\*\*/,
  );
  // The diff content is present, under the proposed heading — never the accepted one.
  assert.match(evidence, /-  int c = a \+ b;/);
  assert.doesNotMatch(evidence, /\*\*Accepted change/);
});

test('PROPOSED disappears once a decision is recorded (accept -> Accepted heading; reject -> no diff)', () => {
  const f = finding();
  const c = candidate();
  const base = [fn('add', 'fn-1', [f])] as ScanFunction[];

  const accepted = buildRepairReport(
    makeInput(base, [c], { 'cand-1': { decision: 'accepted', overrode: false } }),
    ORIGINAL,
  );
  assert.doesNotMatch(accepted, /PROPOSED/);
  assert.doesNotMatch(accepted, /NOT applied/);
  assert.match(accepted, /\*\*Accepted change \(unified diff, Original C basis\):\*\*/);

  const rejected = buildRepairReport(
    makeInput(base, [c], { 'cand-1': { decision: 'rejected', overrode: false } }),
    ORIGINAL,
  );
  assert.doesNotMatch(rejected, /PROPOSED/);
  assert.doesNotMatch(rejected, /```diff/); // rejected: no diff, unchanged policy
});

// --- §6 trademark/status notice ---------------------------------------------

test('§6 is the compact trademark/status notice, not a full disclaimer', () => {
  const md = buildRepairReport(makeInput([], [], {}), ORIGINAL);
  assert.match(md, /## 6\. Trademark and status notice/);
  assert.ok(md.includes(REPORT_DISCLAIMER));
  assert.match(md, /CERT® is a registered trademark of Carnegie Mellon University/);
  assert.match(md, /not affiliated with or endorsed by/);
  assert.match(md, /does not constitute certification of CERT C conformance/);
  // The epistemic caveats live in §2 only (user + Codex: a full disclaimer
  // paragraph on a change report is excessive) — keep §6 free of them.
  assert.ok(!/point-in-time review aid/.test(md));
  assert.ok(!md.includes('no other violations exist'));
});

// --- noise guard (Codex ruling): no cost / token / prompt strings -----------

test('report never contains cost, token, or prompt strings (Codex noise ruling)', () => {
  const f = finding();
  const c = candidate();
  const md = buildRepairReport(
    makeInput([fn('add', 'fn-1', [f])], [c], { 'cand-1': { decision: 'accepted', overrode: false } }),
    ORIGINAL,
  ).toLowerCase();
  // The ONE sanctioned use of "prompt" is the §2 methodology bullet
  // (DETECTION_SCOPE_NOTE — "the bundled catalog as prompt context"), which
  // describes how detection works and is not prompt text. Assert it appears
  // exactly once, then scrub it so the banned-substring sweep still guards
  // against any OTHER cost/token/prompt leakage.
  const note = DETECTION_SCOPE_NOTE.toLowerCase();
  assert.equal(md.split(note).length - 1, 1, 'the §2 methodology bullet appears exactly once');
  const scrubbed = md.replace(note, '');
  for (const banned of ['cost', 'token', 'prompt', '$', 'usd', 'cents', 'reasoning tokens']) {
    assert.ok(!scrubbed.includes(banned), `report must not mention "${banned}"`);
  }
});

test('report is deterministic for the same input', () => {
  const f = finding();
  const c = candidate();
  const mk = () =>
    buildRepairReport(
      makeInput([fn('add', 'fn-1', [f])], [c], { 'cand-1': { decision: 'accepted', overrode: false } }),
      ORIGINAL,
    );
  assert.equal(mk(), mk());
});

// --- §1 rule count + §2 detection-scope bullet (user + Codex round) ----------

test('§1 Rule set line carries the rule count as "context to detection" when known', () => {
  const md = buildRepairReport(makeInput([], [], {}, { ruleCount: 115 }), ORIGINAL);
  assert.match(
    md,
    /\*\*Rule set:\*\* CERT C — `1`: \*\*115-rule ID\/title catalog supplied as context to detection\*\* \(bundled with this harness release\)/,
  );
});

test('§1 Rule set line degrades to the count-less form when ruleCount is absent', () => {
  const md = buildRepairReport(makeInput([], [], {}), ORIGINAL);
  assert.match(
    md,
    /\*\*Rule set:\*\* CERT C — catalog `1` \(the rule set bundled with this harness release\)/,
  );
  assert.doesNotMatch(md, /-rule ID\/title catalog/);
});

test('§2 carries the LLM-detection methodology bullet (no exhaustive-coverage reading)', () => {
  const md = buildRepairReport(makeInput([], [], {}), ORIGINAL);
  assert.ok(md.includes(`- ${DETECTION_SCOPE_NOTE}`));
  assert.match(md, /does not perform exhaustive per-rule analysis/);
});

// --- rejected-reference diffs (crepair.report.includeRejectedProposals) ------

/** Every reject-reason shape: the five codes + a reason-less reject. */
const ALL_REJECT_SHAPES: (CandidateDisposition['rejectReason'] | undefined)[] = [
  undefined, // reason-less (Esc on the picker)
  { code: 'false_positive' },
  { code: 'incorrect_or_unsafe_fix' },
  { code: 'excessive_or_api_change' },
  { code: 'insufficient_context_or_evidence' },
  { code: 'other', comment: 'hand-rolled fix preferred' },
];

test('toggle off (default): rejected candidates get no diff, whatever the reason', () => {
  for (const rejectReason of ALL_REJECT_SHAPES) {
    const f = finding();
    const c = candidate();
    const md = buildRepairReport(
      makeInput([fn('add', 'fn-1', [f])], [c], {
        'cand-1': { decision: 'rejected', overrode: false, ...(rejectReason ? { rejectReason } : {}) },
      }),
      ORIGINAL,
    );
    const label = rejectReason?.code ?? '(no reason)';
    assert.doesNotMatch(md, /```diff/, `no diff for rejected [${label}] with the toggle off`);
    assert.doesNotMatch(md, /Rejected proposal/, `no reference heading for [${label}]`);
    // The lean record still carries the gate evidence + reason note.
    assert.match(md, /_Rejected: /);
  }
});

test('toggle on: EVERY rejected candidate with hunks gets the reference block (no category filtering)', () => {
  for (const rejectReason of ALL_REJECT_SHAPES) {
    const f = finding();
    const c = candidate();
    const md = buildRepairReport(
      makeInput(
        [fn('add', 'fn-1', [f])],
        [c],
        { 'cand-1': { decision: 'rejected', overrode: false, ...(rejectReason ? { rejectReason } : {}) } },
        { includeRejectedProposals: true },
      ),
      ORIGINAL,
    );
    const label = rejectReason?.code ?? '(no reason)';
    assert.match(md, /\*\*Rejected proposal \(NOT applied\) — reference only:\*\*/, `reference heading for [${label}]`);
    assert.ok(md.includes(REJECTED_REFERENCE_WARNING), `do-not-apply warning for [${label}]`);
    assert.match(md, /-  int c = a \+ b;/, `rejected diff content for [${label}]`);
  }
});

test('toggle on: the reason line sits directly above the heading; the warning directly below the diff', () => {
  const f = finding();
  const c = candidate();
  const md = buildRepairReport(
    makeInput(
      [fn('add', 'fn-1', [f])],
      [c],
      {
        'cand-1': {
          decision: 'rejected',
          overrode: false,
          rejectReason: { code: 'excessive_or_api_change' },
        },
      },
      { includeRejectedProposals: true },
    ),
    ORIGINAL,
  );
  // reason line -> blank -> heading -> blank -> ```diff ... ``` -> blank -> warning
  assert.match(
    md,
    /_Rejected: excessive change \/ unwanted api change\._\n\n\*\*Rejected proposal \(NOT applied\) — reference only:\*\*\n\n```diff\n/,
  );
  assert.match(md, /```\n\n_Do not apply without independent review and adaptation\._/);
});

test('toggle on: rejected-reference entries close the appendix, after plain accepted', () => {
  const fAcc = finding({ finding_id: 'f-acc', rule_id: 'INT32-C', location: { start_line: 4, end_line: 4 } });
  const fRej = finding({ finding_id: 'f-rej', rule_id: 'EXP34-C', rule_summary: 'Null deref', location: { start_line: 9, end_line: 9 } });
  const cAcc = candidate({ candidate_id: 'c-acc', finding_id: 'f-acc' });
  const cRej = candidate({
    candidate_id: 'c-rej',
    finding_id: 'f-rej',
    hunks: [{ hunk_id: 'hr', start_line: 9, line_count: 1, replacement_text: '  int r = safe(x);' }],
  });
  const md = buildRepairReport(
    makeInput(
      [fn('scale', 'fn-2', [fRej]), fn('add', 'fn-1', [fAcc])], // scan order: rejected first
      [cAcc, cRej],
      {
        'c-acc': { decision: 'accepted', overrode: false },
        'c-rej': { decision: 'rejected', overrode: false },
      },
      { includeRejectedProposals: true },
    ),
    ORIGINAL,
  );
  const evidence = md.slice(md.indexOf('## 5. Per-finding evidence'));
  const idxAcc = evidence.indexOf('add — INT32-C');
  const idxRej = evidence.indexOf('scale — EXP34-C');
  assert.ok(idxAcc >= 0 && idxRej >= 0);
  assert.ok(idxAcc < idxRej, 'rejected-reference renders after plain accepted, despite scan order');
});

test('toggle on: a hunkless rejected candidate still gets no diff (nothing to show)', () => {
  const f = finding();
  const c = candidate({ hunks: [], status: 'repair_failed' });
  const md = buildRepairReport(
    makeInput(
      [fn('add', 'fn-1', [f])],
      [c],
      { 'cand-1': { decision: 'rejected', overrode: false } },
      { includeRejectedProposals: true },
    ),
    ORIGINAL,
  );
  assert.doesNotMatch(md, /```diff/);
  assert.doesNotMatch(md, /Rejected proposal/);
});
