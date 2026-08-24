// Unit tests for the reject-reason feedback feature (feature B minimal):
//   (1) the reject-reason catalog (codes + labels + report prose);
//   (2) ScanSession records / discards the reject reason (stale/discard semantics);
//   (3) the repair report §4/§5 reflect the reason (or the legacy wording);
//   (4) the source-free Feedback Data JSON builder (versioned shape + required keys)
//       and its SOURCE-FREE guard (no gate detail / source / absolute path leaks);
//   (5) the crepair.exportFeedbackData command + menu wiring (package.json).
// Pure Node — no `vscode` module.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  REJECT_REASONS,
  REJECT_REASON_PLACEHOLDER,
  rejectReasonLabel,
  rejectReasonReportText,
  type RejectReason,
  type RejectReasonCode,
} from '../src/session/rejectReason';
import { ScanSession } from '../src/session/ScanSession';
import { buildRepairReport, type CandidateDisposition } from '../src/session/repairReport';
import {
  buildFeedbackData,
  FEEDBACK_FORMAT,
  FEEDBACK_VERSION,
  type FeedbackDataInput,
} from '../src/session/feedbackData';
import type {
  FunctionScanResult,
  ScanFunction,
  Finding,
  RepairCandidate,
  Validation,
  SourceDocument,
  ContextAugmentationSet,
} from '@c-repair/contract';

const ORIGINAL = [
  'int add(int a, int b) {',
  '  int c = a + b;',
  '  return c;',
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
    location: { start_line: 2, end_line: 2 },
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
      { hunk_id: 'h1', start_line: 2, line_count: 1, replacement_text: '  int c;\n  if (__builtin_add_overflow(a, b, &c)) return -1;' },
    ],
    validations: [val('format', 'pass'), val('compile', 'pass'), val('semantic', 'pass')],
    model_identity: 'deepseek/deepseek-v4-flash-0731',
    ...overrides,
  };
}

function fn(name: string, id: string, findings: Finding[]): ScanFunction {
  return { function_id: id, name, original_range: { start_line: 1, end_line: 4 }, findings };
}

function scanResult(functions: ScanFunction[]): FunctionScanResult {
  return {
    scan_id: 'scan-1',
    source_id: 'src-1',
    original_hash: sha(ORIGINAL),
    context_revision_id: 'rev-1',
    rule_profile: { id: 'cert-c', version: 'certfix-0.4.1-bundled' },
    adapter: { id: 'certfix-inprocess', version: '0.1.0' },
    harness: { id: 'certfix', version: '0.4.1' },
    functions,
  };
}

// --- (1) catalog -------------------------------------------------------------

test('catalog: the five codes are present in display order with the approved labels', () => {
  const codes = REJECT_REASONS.map((r) => r.code);
  assert.deepEqual(codes, [
    'false_positive',
    'incorrect_or_unsafe_fix',
    'excessive_or_api_change',
    'insufficient_context_or_evidence',
    'other',
  ]);
  assert.equal(rejectReasonLabel('false_positive'), 'False positive — this is not a real violation');
  assert.equal(rejectReasonLabel('other'), 'Other…');
});

test('catalog: placeholder mentions optional + stored-locally-only', () => {
  assert.match(REJECT_REASON_PLACEHOLDER, /optional/i);
  assert.match(REJECT_REASON_PLACEHOLDER, /stored locally only/i);
});

test('rejectReasonReportText: lower-cases the label, drops the ellipsis, appends comment', () => {
  assert.equal(
    rejectReasonReportText({ code: 'false_positive' }),
    'false positive — this is not a real violation',
  );
  assert.equal(
    rejectReasonReportText({ code: 'other', comment: 'duplicate suppression' }),
    'other — duplicate suppression',
  );
  // `other` with no comment: the ellipsis is stripped, no dangling separator.
  assert.equal(rejectReasonReportText({ code: 'other' }), 'other');
});

// --- (2) ScanSession recording + discard semantics ---------------------------

function makeSession(scan?: FunctionScanResult): ScanSession {
  const s = scan ?? scanResult([]);
  const source: SourceDocument = {
    source_id: 'src-1',
    filename: 'a.c',
    language: 'c',
    content: ORIGINAL,
    content_hash: sha(ORIGINAL),
    size_bytes: Buffer.byteLength(ORIGINAL, 'utf8'),
    origin: 'vscode_document',
  };
  const confirmed: ContextAugmentationSet = {
    set_id: 'set-1',
    source_id: 'src-1',
    original_hash: sha(ORIGINAL),
    status: 'confirmed',
    context_revision_id: 'rev-1',
    prelude_line_count: 0,
    items: [],
  };
  return new ScanSession(
    ScanSession.makeSnapshot('file:///a.c', 'a.c', ORIGINAL),
    'rev-1',
    s,
    source,
    confirmed,
  );
}

test('session: setRejectReason records and dispositionFor surfaces it for a rejected candidate', () => {
  const s = makeSession();
  s.setDecision('cand-1', 'rejected');
  const reason: RejectReason = { code: 'false_positive' };
  s.setRejectReason('cand-1', reason);
  assert.deepEqual(s.rejectReasonFor('cand-1'), reason);
  assert.deepEqual(s.dispositionFor('cand-1'), {
    decision: 'rejected',
    overrode: false,
    rejectReason: reason,
  });
});

test('session: a reason-less reject leaves no rejectReason on the disposition', () => {
  const s = makeSession();
  s.setDecision('cand-1', 'rejected');
  assert.equal(s.rejectReasonFor('cand-1'), undefined);
  // dispositionFor omits the key entirely (deepEqual to the bare shape).
  assert.deepEqual(s.dispositionFor('cand-1'), { decision: 'rejected', overrode: false });
});

test('session: re-deciding away from rejected clears the reject reason (discard semantics)', () => {
  const s = makeSession();
  s.setDecision('cand-1', 'rejected');
  s.setRejectReason('cand-1', { code: 'incorrect_or_unsafe_fix' });
  s.setDecision('cand-1', 'accepted'); // flip
  assert.equal(s.rejectReasonFor('cand-1'), undefined);
  assert.deepEqual(s.dispositionFor('cand-1'), { decision: 'accepted', overrode: false });
});

test('session: setting decision back to pending clears the reject reason', () => {
  const s = makeSession();
  s.setDecision('cand-1', 'rejected');
  s.setRejectReason('cand-1', { code: 'other', comment: 'note' });
  s.setDecision('cand-1', 'pending');
  assert.equal(s.rejectReasonFor('cand-1'), undefined);
});

test('session: regenerate (replaceCandidateForFinding) drops the reject reason', () => {
  const s = makeSession();
  const c = candidate();
  s.setCandidate(c);
  s.setDecision(c.candidate_id, 'rejected');
  s.setRejectReason(c.candidate_id, { code: 'false_positive' });
  // A regenerated candidate for the same finding must not inherit the old reason.
  s.replaceCandidateForFinding(c.finding_id, candidate({ candidate_id: 'cand-2' }));
  assert.equal(s.rejectReasonFor(c.candidate_id), undefined);
});

// --- (3) report §4 / §5 reflection -------------------------------------------

function reportInput(
  functions: ScanFunction[],
  cands: RepairCandidate[],
  dispos: Record<string, CandidateDisposition>,
): Parameters<typeof buildRepairReport>[0] {
  const byFinding = new Map<string, RepairCandidate>();
  for (const c of cands) byFinding.set(c.finding_id, c);
  const byCand = new Map<string, CandidateDisposition>(Object.entries(dispos));
  return {
    generatedAtIso: '2026-08-24T00:00:00.000Z',
    filename: 'a.c',
    originalHash: sha(ORIGINAL),
    expectedHash: sha(ORIGINAL),
    extensionVersion: '0.1.0',
    ruleProfile: { id: 'cert-c', version: '1' },
    model: { model: 'deepseek/deepseek-v4-flash-0731', mode: 'Preset' },
    scan: scanResult(functions),
    contextStillMissing: undefined,
    contextProvenance: [],
    candidateForFinding: (id) => byFinding.get(id),
    dispositionForCandidate: (id) => byCand.get(id) ?? { decision: 'pending', overrode: false },
    includeRejectedProposals: false,
  };
}

test('§4/§5: a reject reason is reflected in both the unresolved line and the evidence entry', () => {
  const f = finding();
  const c = candidate();
  const md = buildRepairReport(
    reportInput([fn('add', 'fn-1', [f])], [c], {
      'cand-1': {
        decision: 'rejected',
        overrode: false,
        rejectReason: { code: 'false_positive' },
      },
    }),
    ORIGINAL,
  );
  // §4 unresolved line carries the reason instead of the legacy wording.
  assert.match(md, /\(REJECTED\): false positive — this is not a real violation/);
  assert.doesNotMatch(md, /rejected by the reviewer/);
  // §5 evidence entry carries a one-line Rejected note.
  assert.match(md, /_Rejected: false positive — this is not a real violation\._/);
});

test('§4/§5: the `other` comment is appended', () => {
  const f = finding();
  const c = candidate();
  const md = buildRepairReport(
    reportInput([fn('add', 'fn-1', [f])], [c], {
      'cand-1': {
        decision: 'rejected',
        overrode: false,
        rejectReason: { code: 'other', comment: 'duplicate of an existing suppression' },
      },
    }),
    ORIGINAL,
  );
  assert.match(md, /other — duplicate of an existing suppression/);
});

test('§4/§5: a reason-less reject keeps the legacy "rejected by the reviewer" wording', () => {
  const f = finding();
  const c = candidate();
  const md = buildRepairReport(
    reportInput([fn('add', 'fn-1', [f])], [c], {
      'cand-1': { decision: 'rejected', overrode: false },
    }),
    ORIGINAL,
  );
  assert.match(md, /\(REJECTED\): rejected by the reviewer/);
  assert.match(md, /_Rejected: rejected by the reviewer\._/);
});

// --- (4) feedback JSON builder + source-free guard ---------------------------

const SENTINEL_DETAIL = 'SECRETSOURCE_int c = a + b; /path/to/secret/file.c';

function feedbackInput(
  functions: ScanFunction[],
  cands: RepairCandidate[],
  dispos: Record<string, CandidateDisposition>,
): FeedbackDataInput {
  const byFinding = new Map<string, RepairCandidate>();
  for (const c of cands) byFinding.set(c.finding_id, c);
  const byCand = new Map<string, CandidateDisposition>(Object.entries(dispos));
  return {
    generatedAtIso: '2026-08-24T00:00:00.000Z',
    filename: 'a.c',
    originalHash: sha(ORIGINAL),
    extensionVersion: '0.1.0',
    ruleProfile: { id: 'cert-c', version: 'certfix-0.4.1-bundled' },
    model: 'deepseek/deepseek-v4-flash-0731',
    mode: 'Preset',
    scan: scanResult(functions),
    candidateForFinding: (id) => byFinding.get(id),
    dispositionForCandidate: (id) => byCand.get(id) ?? { decision: 'pending', overrode: false },
  };
}

test('feedback JSON: versioned envelope + required identity keys', () => {
  const data = buildFeedbackData(feedbackInput([], [], {}));
  assert.equal(data.format, FEEDBACK_FORMAT);
  assert.equal(data.format, 'c-repair-feedback');
  assert.equal(data.version, FEEDBACK_VERSION);
  assert.equal(data.version, 1);
  assert.equal(data.filename, 'a.c');
  assert.equal(data.extension_version, '0.1.0');
  assert.deepEqual(data.rule_set, { id: 'cert-c', version: 'certfix-0.4.1-bundled' });
  assert.deepEqual(data.model, { id: 'deepseek/deepseek-v4-flash-0731', mode: 'Preset' });
  assert.deepEqual(data.integrity, { original_hash: sha(ORIGINAL) });
  assert.ok(Array.isArray(data.findings));
});

test('feedback JSON: a rejected finding records status, gates, disposition, reason, hunk hashes', () => {
  const f = finding();
  const c = candidate();
  const data = buildFeedbackData(
    feedbackInput([fn('add', 'fn-1', [f])], [c], {
      'cand-1': {
        decision: 'rejected',
        overrode: false,
        rejectReason: { code: 'incorrect_or_unsafe_fix' },
      },
    }),
  );
  assert.equal(data.findings.length, 1);
  const rec = data.findings[0];
  assert.equal(rec.kind, 'violation');
  assert.equal(rec.rule_id, 'INT32-C');
  assert.equal(rec.function_name, 'add');
  assert.equal(rec.candidate_status, 'repair_ready');
  assert.deepEqual(
    rec.gates,
    [
      { name: 'format', status: 'pass' },
      { name: 'compile', status: 'pass' },
      { name: 'semantic', status: 'pass' },
    ],
  );
  assert.deepEqual(rec.disposition, { state: 'REJECTED', decision: 'rejected', overrode: false });
  assert.deepEqual(rec.reject_reason, { code: 'incorrect_or_unsafe_fix' });
  // Per-hunk hashes present, prefixed, and NOT the hunk text.
  assert.equal(rec.candidate_hunk_hashes.length, 1);
  assert.match(rec.candidate_hunk_hashes[0], /^sha256:[0-9a-f]{64}$/);
});

test('feedback JSON: the `other` comment is the ONLY free text carried', () => {
  const f = finding();
  const c = candidate();
  const data = buildFeedbackData(
    feedbackInput([fn('add', 'fn-1', [f])], [c], {
      'cand-1': {
        decision: 'rejected',
        overrode: false,
        rejectReason: { code: 'other', comment: 'my own note' },
      },
    }),
  );
  assert.deepEqual(data.findings[0].reject_reason, { code: 'other', comment: 'my own note' });
});

test('feedback JSON: an uncertain finding has null rule_id and no candidate', () => {
  const f = finding({ finding_id: 'f-u', kind: 'uncertain', rule_id: undefined, rule_summary: 'maybe' });
  const data = buildFeedbackData(feedbackInput([fn('probe', 'fn-2', [f])], [], {}));
  const rec = data.findings[0];
  assert.equal(rec.rule_id, null);
  assert.equal(rec.candidate_status, null);
  assert.deepEqual(rec.gates, []);
  assert.deepEqual(rec.candidate_hunk_hashes, []);
  assert.equal(rec.reject_reason, null);
  assert.deepEqual(rec.disposition, { state: 'UNREPAIRED', decision: 'pending', overrode: false });
});

test('SOURCE-FREE GUARD: gate detail, source fragments, and absolute paths never leak', () => {
  // A candidate whose gate details AND repair_explanation embed sentinels that must
  // NOT reach the JSON: a source fragment, an absolute path, and free prose.
  const f = finding();
  const c = candidate({
    repair_explanation: 'EXPLANATION_SENTINEL should not appear in the JSON export.',
    validations: [
      val('compile', 'fail', SENTINEL_DETAIL),
      val('semantic', 'fail', 'SEMANTIC_DETAIL_SENTINEL with code int x = 1;'),
    ],
    hunks: [
      { hunk_id: 'h1', start_line: 2, line_count: 1, replacement_text: 'HUNK_TEXT_SENTINEL int c = safe_add(a, b);' },
    ],
  });
  const json = JSON.stringify(
    buildFeedbackData(
      feedbackInput([fn('add', 'fn-1', [f])], [c], {
        'cand-1': {
          decision: 'rejected',
          overrode: false,
          rejectReason: { code: 'false_positive' },
        },
      }),
    ),
  );
  for (const banned of [
    'SECRETSOURCE',
    'int c = a + b',
    '/path/to/secret',
    'SEMANTIC_DETAIL_SENTINEL',
    'HUNK_TEXT_SENTINEL',
    'EXPLANATION_SENTINEL',
    'safe_add',
  ]) {
    assert.ok(!json.includes(banned), `feedback JSON must not contain "${banned}"`);
  }
  // Sanity: the gate NAMES + statuses still made it (name/status are allowed).
  assert.match(json, /"name":"compile"/);
  assert.match(json, /"status":"fail"/);
});

// --- (5) command + menu wiring (package.json) --------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as {
  contributes: {
    commands: { command: string; title: string; category?: string }[];
    menus: {
      'view/title': { command: string; when: string }[];
      commandPalette: { command: string; when: string }[];
    };
  };
};

test('crepair.exportFeedbackData command is declared under the "C Repair" category', () => {
  const cmd = pkg.contributes.commands.find((c) => c.command === 'crepair.exportFeedbackData');
  assert.ok(cmd, 'the exportFeedbackData command is declared');
  assert.equal(cmd?.category, 'C Repair');
  assert.equal(cmd?.title, 'Export Feedback Data (JSON)');
});

test('crepair.exportFeedbackData is wired into the TreeView view/title', () => {
  const inTitle = pkg.contributes.menus['view/title'].some(
    (m) => m.command === 'crepair.exportFeedbackData' && m.when === 'view == crepairResults',
  );
  assert.ok(inTitle, 'the feedback-export command appears in the Scan Results view title');
});

// The codes are exhaustive over the RejectReasonCode union (compile-time guard):
// each catalog code is assignable to the union type.
test('RejectReasonCode union is covered by the catalog', () => {
  const seen = new Set<RejectReasonCode>(REJECT_REASONS.map((r) => r.code));
  const all: RejectReasonCode[] = [
    'false_positive',
    'incorrect_or_unsafe_fix',
    'excessive_or_api_change',
    'insufficient_context_or_evidence',
    'other',
  ];
  for (const code of all) assert.ok(seen.has(code), `catalog covers ${code}`);
});
