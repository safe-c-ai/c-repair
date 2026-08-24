// Pure (VS Code API independent) view-model derivation for the C Repair result
// UI: finding -> diagnostic descriptor and function -> aggregate status. Kept
// free of the `vscode` module so it is unit testable under plain Node
// (VSCODE_V1B_DESIGN.md §4 / §7). The thin adapters in diagnostics.ts / tree.ts
// map these descriptors onto real vscode.* objects.

import type {
  Finding,
  ScanFunction,
  RepairCandidate,
  Validation,
  Hunk,
} from '@c-repair/contract';
import { hunkRange, candidatesConflict } from '@c-repair/core';

/** Severity as a stable string; diagnostics.ts maps it to vscode.DiagnosticSeverity. */
export type DiagSeverity = 'warning' | 'information';

/** A finding rendered to a diagnostic, with a 0-indexed range (VS Code basis). */
export interface DiagnosticDescriptor {
  /** 0-indexed line/character range converted from the finding's 1-indexed location. */
  range: {
    startLine: number;
    startChar: number;
    endLine: number;
    endChar: number;
  };
  severity: DiagSeverity;
  message: string;
  source: 'C Repair';
  /** rule_id when present (violation), else undefined. */
  code?: string;
}

/**
 * Convert a finding's 1-indexed, both-ends-inclusive Original C location
 * (CONTRACT.md §1) to a 0-indexed VS Code range covering whole lines.
 *
 * Line n (1-indexed) -> line n-1 (0-indexed). The end is the *inclusive* last
 * line, so it maps to the start of the line after it (VS Code ranges are
 * end-exclusive) — but to stay whole-line without knowing column widths we use
 * (endLine-1, LARGE) which VS Code clamps to the true end of the line.
 */
export function findingToRange(f: Finding): DiagnosticDescriptor['range'] {
  const startLine = Math.max(0, f.location.start_line - 1);
  const endLine = Math.max(startLine, f.location.end_line - 1);
  return {
    startLine,
    startChar: 0,
    endLine,
    // Number.MAX_SAFE_INTEGER as the end character; VS Code clamps to line end.
    endChar: Number.MAX_SAFE_INTEGER,
  };
}

/**
 * Build the diagnostic / tree message for a finding (VSCODE_V1B_DESIGN.md §4,
 * V1c-UX): a single, non-duplicated form.
 * - violation: `<rule_id>: <rule_summary>` (or just `<rule_summary>` when there
 *   is no rule_id). The old `[rule_id] CERT-C rule_id.` double-print is gone —
 *   rule_summary now carries the human rule title from the catalog.
 *   When the title is empty (D-039 legal kill-switch: bridge run with
 *   CREPAIR_RULE_TITLES=off), the separator is dropped so it renders as the rule
 *   ID alone (`STR31-C`) rather than a dangling `STR31-C: `.
 * - uncertain: `[uncertain] <first line of explanation>` (rule_id may be absent)
 * assumption_dependent findings get a ` (assumption-dependent)` suffix.
 */
export function findingMessage(f: Finding): string {
  let base: string;
  if (f.kind === 'violation') {
    const title = f.rule_summary.trim();
    if (f.rule_id) {
      // `id: title` when a title is present; the id alone when it is empty.
      base = title ? `${f.rule_id}: ${title}` : f.rule_id;
    } else {
      base = title;
    }
  } else {
    base = `[uncertain] ${firstLine(f.explanation) || f.rule_summary}`.trim();
  }
  if (f.assumption_dependent) base += ' (assumption-dependent)';
  return base;
}

function firstLine(s: string): string {
  const nl = s.indexOf('\n');
  return (nl === -1 ? s : s.slice(0, nl)).trim();
}

export function findingSeverity(f: Finding): DiagSeverity {
  return f.kind === 'violation' ? 'warning' : 'information';
}

/** Full descriptor for one finding. code = rule_id when present. */
export function findingToDiagnostic(f: Finding): DiagnosticDescriptor {
  return {
    range: findingToRange(f),
    severity: findingSeverity(f),
    message: findingMessage(f),
    source: 'C Repair',
    code: f.rule_id,
  };
}

/** Aggregate status of a function, shown as a TreeView badge. */
export type FunctionStatus = 'CLEAN' | 'VIOLATION_FOUND' | 'UNCERTAIN';

/**
 * Derive a function's aggregate status from its findings (V1: 0..1 finding, but
 * the schema permits more so we aggregate defensively):
 * - any violation finding => VIOLATION_FOUND
 * - else any uncertain finding => UNCERTAIN
 * - else CLEAN
 */
export function aggregateStatus(fn: ScanFunction): FunctionStatus {
  if (fn.findings.some((f) => f.kind === 'violation')) return 'VIOLATION_FOUND';
  if (fn.findings.some((f) => f.kind === 'uncertain')) return 'UNCERTAIN';
  return 'CLEAN';
}

export interface ScanCounts {
  functions: number;
  violations: number;
  uncertain: number;
}

/** Top-level counts for the file summary node. Counts findings, not functions. */
export function scanCounts(functions: ScanFunction[]): ScanCounts {
  let violations = 0;
  let uncertain = 0;
  for (const fn of functions) {
    for (const f of fn.findings) {
      if (f.kind === 'violation') violations += 1;
      else if (f.kind === 'uncertain') uncertain += 1;
    }
  }
  return { functions: functions.length, violations, uncertain };
}

// --- gate classification (D-023) --------------------------------------------

/**
 * The two gate classes (D-023). MECHANICAL gates are objective, deterministic
 * failures (a broken build / malformed output): a fail is a hard fault and blocks
 * Accept. JUDGMENT gates are the model's opinion on behaviour / rule removal /
 * regression: a fail is evidence, not a verdict — Accept is still permitted with
 * a warning, because the human is the final authority (D-013/D-014).
 */
export type GateClass = 'mechanical' | 'judgment';

const JUDGMENT_GATES = new Set(['semantic', 'violation_removal', 'regression']);

/**
 * Classify a validation gate by name (D-023). Judgment gates are the enumerated
 * LLM-opinion gates; everything else (format / compile, and any unrecognised gate)
 * is mechanical — the safe default, since an unrecognised gate failing should
 * block Accept rather than silently permit a warned override.
 */
export function gateClass(name: string): GateClass {
  return JUDGMENT_GATES.has(name) ? 'judgment' : 'mechanical';
}

/** The failing validations, split by gate class (D-023). */
export function failingGatesByClass(c: RepairCandidate): {
  mechanical: Validation[];
  judgment: Validation[];
} {
  const mechanical: Validation[] = [];
  const judgment: Validation[] = [];
  for (const v of c.validations) {
    if (v.status !== 'fail') continue;
    if (gateClass(v.name) === 'judgment') judgment.push(v);
    else mechanical.push(v);
  }
  return { mechanical, judgment };
}

// --- candidate view-model (V1b-2, D-023) ------------------------------------

/**
 * The badge shown on a candidate node (VSCODE_V1B_DESIGN.md §4, D-017c, D-023).
 * Derived purely from the candidate's status + validations:
 * - status=repair_failed              -> 'no_fix'             (no hunks / diff / Accept)
 * - any MECHANICAL fail (format/compile) -> 'validation_failed' (Accept disabled)
 * - only JUDGMENT fail(s) (semantic/…)   -> 'review_required'    (Accept w/ warning, D-023)
 * - no fail, some skipped/not_run       -> 'insufficient_evidence' (Accept allowed, D-017c)
 * - all pass                            -> 'repair_ready'
 * Precedence: no_fix > mechanical fail > judgment fail > skipped > all pass.
 */
export type CandidateBadge =
  | 'repair_ready'
  | 'insufficient_evidence'
  | 'review_required'
  | 'validation_failed'
  | 'no_fix';

export function candidateBadge(c: RepairCandidate): CandidateBadge {
  if (c.status === 'repair_failed' || c.hunks.length === 0) return 'no_fix';
  const { mechanical, judgment } = failingGatesByClass(c);
  // Mechanical fail (objective故障) blocks Accept (unchanged behaviour).
  if (mechanical.length > 0) return 'validation_failed';
  // Only judgment gate(s) failed -> Accept permitted with a warning (D-023).
  if (judgment.length > 0) return 'review_required';
  if (c.validations.some((v) => v.status === 'skipped' || v.status === 'not_run')) {
    return 'insufficient_evidence';
  }
  return 'repair_ready';
}

/** The bracketed label form of a badge, e.g. `[repair_ready]`. */
export function candidateBadgeLabel(badge: CandidateBadge): string {
  switch (badge) {
    case 'repair_ready':
      return '[repair_ready]';
    case 'insufficient_evidence':
      return '[insufficient evidence]';
    case 'review_required':
      return '[review required]';
    case 'validation_failed':
      return '[validation_failed]';
    case 'no_fix':
      return '[no fix]';
  }
}

/**
 * The primary candidate row label (V1c-UX): a human "Proposed fix" phrase with
 * the badge, e.g. `Proposed fix [insufficient evidence]`. The internal
 * candidate_id and model_identity move to the tooltip (candidateTooltip), so the
 * row is readable at a glance instead of leading with an opaque id.
 */
export function candidateLabel(badge: CandidateBadge): string {
  return `Proposed fix ${candidateBadgeLabel(badge)}`;
}

/**
 * The candidate row tooltip (V1c-UX): the repair explanation followed by the
 * internal identifiers (candidate_id, model_identity) that no longer clutter the
 * label. model_identity is optional in the contract.
 */
export function candidateTooltip(c: RepairCandidate): string {
  const lines = [c.repair_explanation, '', `candidate_id: ${c.candidate_id}`];
  if (c.model_identity) lines.push(`model: ${c.model_identity}`);
  return lines.join('\n');
}

/** True when this candidate can be shown as a diff (it has at least one hunk). */
export function candidateHasDiff(c: RepairCandidate): boolean {
  return candidateBadge(c) !== 'no_fix';
}

/**
 * Whether Accept is structurally permitted for this candidate's badge (ignoring
 * stale / conflict, which are runtime guards). validation_failed (a mechanical
 * gate fault) and no_fix are never acceptable. insufficient_evidence IS
 * acceptable (D-017c) though flagged; review_required IS acceptable but requires
 * an explicit warning confirmation before applying (D-023).
 */
export function badgeAcceptable(badge: CandidateBadge): boolean {
  return (
    badge === 'repair_ready' ||
    badge === 'insufficient_evidence' ||
    badge === 'review_required'
  );
}

/**
 * Whether accepting this badge requires an explicit "apply anyway" warning
 * confirmation (D-023): true only for `review_required` (a judgment gate failed).
 * repair_ready / insufficient_evidence apply without a confirmation.
 */
export function badgeRequiresWarning(badge: CandidateBadge): boolean {
  return badge === 'review_required';
}

/** A validation rendered for the TreeView: an icon glyph, a mark, and text. */
export interface ValidationDescriptor {
  /** 'pass' | 'skipped' | 'not_run' | 'fail' — drives the icon in tree.ts. */
  status: Validation['status'];
  /** Leading glyph used in the plain-text label (✓ / ⚠ / ✗ / ·). */
  mark: string;
  /** Full label, e.g. `✓ compile: pass` or `⚠ compile: skipped — <detail>`. */
  label: string;
}

export function validationMark(status: Validation['status']): string {
  switch (status) {
    case 'pass':
      return '✓';
    case 'fail':
      return '✗';
    case 'skipped':
      return '⚠';
    case 'not_run':
      return '·';
  }
}

export function validationDescriptor(v: Validation): ValidationDescriptor {
  const mark = validationMark(v.status);
  const detail = v.detail ? ` — ${v.detail}` : '';
  return {
    status: v.status,
    mark,
    label: `${mark} ${v.name}: ${v.status}${detail}`,
  };
}

// --- stale results messaging (D-006) ----------------------------------------
//
// A scan's results (findings / candidates / diffs) describe the document AS IT WAS at
// scan time — a snapshot. Editing the document invalidates that snapshot (D-006: a
// context/document change discards downstream scan/candidate/decision state), so the
// results must be re-derived by scanning again. The user-facing wording states the
// REASON (results are a snapshot of the previous contents) and the NEXT STEP (finish
// editing, then scan again), so "stale" is not just a warning glyph but an instruction.

/** The reason + next-step shown wherever results are stale (D-006). One source of truth. */
export const STALE_RESULTS_MESSAGE =
  'Results describe the previous document contents. Finish your edits, then scan again.';

// --- judgment-gate guidance (workflow context) ------------------------------
//
// A judgment gate failing (semantic / violation_removal / regression) does not mean
// the candidate is wrong — it means the model flagged something the human must judge
// (D-013/D-014/D-023). Some CERT fixes cannot be completed by editing one function in
// isolation: the fix may change the function's public API (callers must be updated) or
// depend on facts outside the file (e.g. STR31-C, where the destination buffer's
// capacity is unknown here). The bridge's per-gate `detail` (certfix-derived) is shown
// verbatim; THIS text is the extension-side workflow context layered on top of it, so
// the reviewer sees their options at the moment of judgment. General to all judgment
// fails — there is no signature-change-specific detection.

/**
 * The workflow guidance shown for a candidate whose judgment gate(s) failed: the fix
 * may need wider changes, and here are the options. Phrased around "accept as a
 * starting point" (D-013: the human is the final authority; a candidate is a proposal,
 * not a verdict). Kept as one constant so the diff lens, the override dialog, and the
 * tests share a single source of truth.
 */
export const JUDGMENT_FAIL_GUIDANCE =
  'This fix may change the function’s public API or need changes beyond this ' +
  'function — callers may have to be updated. Your options: accept it as a starting ' +
  'point and complete the wider changes yourself, reject it, or write a different ' +
  'repair by hand. After editing, re-scan to verify.';

/** The one-line lens form of the judgment guidance (diff right pane). */
export const JUDGMENT_FAIL_GUIDANCE_LENS = `$(info) ${JUDGMENT_FAIL_GUIDANCE}`;

// --- validation CodeLens titles (candidate diff right pane) -----------------

/** Max length of a single validation detail shown inline in a diff lens title. */
export const LENS_DETAIL_MAX = 120;

/**
 * One CodeLens to render on the candidate diff's right pane: a `title` string and
 * the gate it describes (undefined only for the all-pass summary, which has no
 * single gate). The `validation` rides along so the lens can wire the
 * showValidationDetail command (Output full text) to the right gate.
 */
export interface ValidationLensItem {
  title: string;
  validation: Validation | undefined;
}

/** Collapse a multi-line detail to its first line (whitespace-tidied, truncated). */
function oneLineLensDetail(detail: string): string {
  const nl = detail.indexOf('\n');
  const first = (nl === -1 ? detail : detail.slice(0, nl)).trim();
  return truncateDetail(first, LENS_DETAIL_MAX);
}

/**
 * Build the diff-right-pane lens titles for a candidate's validations (pure — no
 * `vscode`, so unit tested under plain Node). Order:
 *   1. every failing gate      -> `✗ <gate>: <detail 1-lined/truncated>`
 *   2. every skipped/not_run   -> `⚠ <gate>: <status> — <detail same treatment>`
 *   3. ONLY when neither exists -> a single `✓ <N>/<N> validation gates passed`.
 *   4. when a JUDGMENT gate failed -> a trailing `$(info) …` workflow-guidance lens
 *      (JUDGMENT_FAIL_GUIDANCE): the fix may need wider changes; here are the options.
 * A failing/skipped gate with no detail renders just the head. The passed-summary
 * is emitted alone, so a diff with any concern leads with the concern rather than
 * a reassuring "all passed" line. The guidance lens is context, not a gate, so it
 * carries no `validation` (non-clickable), and appears only when the concern is a
 * judgment call the human must resolve — never on an all-pass diff.
 */
export function buildValidationLensTitles(candidate: RepairCandidate): ValidationLensItem[] {
  const items: ValidationLensItem[] = [];

  const fails = candidate.validations.filter((v) => v.status === 'fail');
  const skipped = candidate.validations.filter(
    (v) => v.status === 'skipped' || v.status === 'not_run',
  );

  for (const v of fails) {
    const detail = v.detail ? `: ${oneLineLensDetail(v.detail)}` : '';
    items.push({ title: `${validationMark('fail')} ${v.name}${detail}`, validation: v });
  }
  for (const v of skipped) {
    const detail = v.detail ? ` — ${oneLineLensDetail(v.detail)}` : '';
    items.push({
      title: `${validationMark(v.status)} ${v.name}: ${v.status}${detail}`,
      validation: v,
    });
  }

  if (items.length === 0) {
    const n = candidate.validations.length;
    items.push({
      title: `${validationMark('pass')} ${n}/${n} validation gates passed`,
      validation: undefined,
    });
  }

  // A judgment gate failing is a call the human must make: layer the workflow
  // guidance under the concern lens(es) so the options are visible at the diff.
  if (fails.some((v) => gateClass(v.name) === 'judgment')) {
    items.push({ title: JUDGMENT_FAIL_GUIDANCE_LENS, validation: undefined });
  }
  return items;
}

// --- hunk -> document Range conversion + offset correction (V1b-2) ----------

/**
 * A 0-indexed, end-exclusive text range plus the replacement text — the pure
 * description a WorkspaceEdit replace is built from (the adapter in
 * apply/acceptCandidate.ts turns this into a vscode.Range).
 *
 * A hunk on Original C coordinates (1-indexed, both-ends-inclusive) maps to:
 * - replace n lines (line_count=n>0): [start_line-1, 0) .. [start_line-1+n, 0)
 *   i.e. delete whole lines start_line..start_line+n-1 and insert replacement.
 * - insert (line_count=0): a zero-width range at the start of line start_line-1.
 * The replacement text carries no trailing newline; whole-line semantics are
 * expressed by including the line break inside the covered range.
 */
export interface EditRange {
  /** 0-indexed start line. */
  startLine: number;
  /** 0-indexed start character (0 for whole-line ops). */
  startChar: number;
  /** 0-indexed end line (exclusive of endChar's line for multi-line spans). */
  endLine: number;
  /** 0-indexed end character. */
  endChar: number;
  /** The text to write into the range. */
  text: string;
  /** True for an insertion (line_count=0): the range is zero-width. */
  insert: boolean;
}

/**
 * Convert one hunk (Original C coords) to an EditRange on a document whose lines
 * are shifted by `lineOffset` relative to the snapshot (0 when applying against
 * the pristine snapshot). The offset accounts for earlier accepted hunks that
 * grew/shrank the document above this hunk (see lineOffsetForStart).
 *
 * Replace (line_count=n): covers lines [start_line .. start_line+n-1] fully,
 * from (row, 0) to (row+n, 0), so the trailing newline is consumed and the
 * replacement (which has no trailing newline) slots in exactly.
 * Insert (line_count=0): a zero-width range at (row, 0); text gets a trailing
 * newline appended so the inserted lines precede the existing line.
 */
export function hunkToEditRange(h: Hunk, lineOffset = 0): EditRange {
  const row = h.start_line - 1 + lineOffset;
  if (h.line_count === 0) {
    return {
      startLine: row,
      startChar: 0,
      endLine: row,
      endChar: 0,
      // Insert full lines before `row`: append a newline so existing line moves down.
      text: h.replacement_text + '\n',
      insert: true,
    };
  }
  return {
    startLine: row,
    startChar: 0,
    endLine: row + h.line_count,
    endChar: 0,
    text: h.replacement_text + '\n',
    insert: false,
  };
}

/**
 * The net change in line count a hunk introduces when applied. Used to compute
 * the running offset for subsequently-accepted candidates.
 *
 * new lines contributed by the replacement text:
 *   - insert (line_count=0): the replacement's line count (added before start).
 *   - replace (n): replacement line count - n.
 * replacement line count = replacement_text.split('\n').length, except an empty
 * replacement with n>0 is a pure deletion contributing 0 new lines.
 */
export function hunkLineDelta(h: Hunk): number {
  const replLines =
    h.replacement_text === '' && h.line_count > 0 ? 0 : h.replacement_text.split('\n').length;
  if (h.line_count === 0) return replLines; // pure insertion
  return replLines - h.line_count;
}

/**
 * Compute the line offset to apply to a hunk starting at Original line
 * `startLine`, given the set of hunks from ALREADY-accepted candidates (all in
 * Original C coordinates). Only accepted hunks strictly ABOVE this start
 * contribute (accepted hunks are guaranteed non-conflicting, D-004, so they
 * never overlap the pending hunk). Deterministic: sums hunkLineDelta of every
 * accepted hunk whose occupied range ends before `startLine`.
 */
export function lineOffsetForStart(startLine: number, acceptedHunks: Hunk[]): number {
  let offset = 0;
  for (const h of acceptedHunks) {
    const r = hunkRange(h);
    // An accepted hunk contributes offset if it lies wholly above `startLine`.
    // Insertions at exactly startLine count as "above" (they precede this line).
    if (r.insert) {
      if (r.start <= startLine) offset += hunkLineDelta(h);
    } else if (r.end < startLine) {
      offset += hunkLineDelta(h);
    }
  }
  return offset;
}

/**
 * Convert all hunks of a candidate to EditRanges against a document already
 * carrying `acceptedHunks` (from prior accepts). Each hunk's offset is computed
 * independently from its own Original start line, so the ordering of returned
 * ranges does not matter to correctness (they are non-overlapping by D-004).
 */
export function candidateToEditRanges(c: RepairCandidate, acceptedHunks: Hunk[]): EditRange[] {
  return c.hunks.map((h) => hunkToEditRange(h, lineOffsetForStart(h.start_line, acceptedHunks)));
}

// --- Accept guard (V1b-2, VSCODE_V1B_DESIGN.md §5) --------------------------

export type AcceptGuard =
  | { ok: true }
  | { ok: true; warn: 'judgment'; concerns: Validation[]; message: string }
  | { ok: false; reason: 'stale'; message: string }
  | { ok: false; reason: 'not_acceptable'; message: string }
  | { ok: false; reason: 'conflict'; conflictId: string; message: string };

/**
 * Build the full-text warning body for an acceptWithWarning accept (D-023): the
 * "accept as a starting point" framing (D-013 — the human is the final authority),
 * one line per failing judgment gate ("<gate>: <detail>"), then the responsibility
 * note. Logged verbatim to the Output channel (the QuickPick rows are truncated), so
 * the reviewer sees exactly what was flagged and what accepting commits them to.
 */
export function acceptWarningMessage(concerns: Validation[]): string {
  const lines = concerns.map((v) => `${v.name}: ${v.detail ?? '(no detail)'}`);
  return (
    `Accept this candidate as a starting point? Judgment gates flagged it:\n` +
    `${lines.join('\n')}\n\n` +
    `You remain responsible for completing any wider changes (e.g. updating callers) ` +
    `— edit freely afterwards and re-scan to verify.`
  );
}

/**
 * A `vscode.QuickPickItem`-shaped plain object (label / optional description /
 * detail), plus an `action` discriminator identifying what the item does. Kept
 * free of the `vscode` module so the accept-warning list is unit tested under
 * plain Node (the extension casts these onto real QuickPickItems). The field is
 * `action`, not `kind`, because `QuickPickItem.kind` is a reserved numeric enum.
 *
 * - `action: 'concern'`   — a non-selectable line describing one failing gate.
 * - `action: 'apply'`     — the "Accept as a starting point" action.
 * - `action: 'cancel'`    — the "Cancel" action.
 */
export interface AcceptWarningPickItem {
  action: 'concern' | 'apply' | 'cancel';
  label: string;
  description?: string;
  detail?: string;
}

/**
 * Max length of a single concern detail shown inline in the QuickPick before it
 * is truncated (the full text stays in the Output channel). Long model rationales
 * would otherwise overflow the pick row.
 */
export const CONCERN_DETAIL_MAX = 160;

/** Truncate `s` to at most `max` chars, appending an ellipsis when cut. */
export function truncateDetail(s: string, max = CONCERN_DETAIL_MAX): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Build the QuickPick items for an acceptWithWarning Accept (D-023). Replaces the
 * OS-native modal (which made Windows chime) with a QuickPick: the failing
 * judgment gates are listed as non-selectable `concern` rows at the top, followed
 * by the two actions ("Accept as a starting point" / "Cancel"). Long details are
 * truncated (`truncateDetail`); the full text remains in the Output channel.
 *
 * The apply action is framed as "Accept as a starting point" (D-013 — the human is
 * the final authority; a flagged candidate is a proposal to build on, not a verdict),
 * with a detail that states the responsibility (complete wider changes, re-scan).
 *
 * Pure so the items are unit tested without the `vscode` module.
 */
export function acceptWarningPickItems(concerns: Validation[]): AcceptWarningPickItem[] {
  const truncated = concerns.some((v) => (v.detail ?? '').length > CONCERN_DETAIL_MAX);
  const concernItems: AcceptWarningPickItem[] = concerns.map((v) => ({
    action: 'concern',
    label: `$(warning) ${v.name}`,
    detail: truncateDetail(v.detail ?? '(no detail)'),
  }));
  return [
    ...concernItems,
    {
      action: 'apply',
      label: '$(check) Accept as a starting point',
      detail: truncated
        ? 'Apply it, then complete any wider changes (e.g. update callers) and re-scan — full details in the C Repair Output channel.'
        : 'Apply it, then complete any wider changes (e.g. update callers) and re-scan.',
    },
    {
      action: 'cancel',
      label: '$(close) Cancel',
      detail: 'Keep the fix unapplied.',
    },
  ];
}

/**
 * Pure Accept guard (VSCODE_V1B_DESIGN.md §5, D-023). Decides whether a candidate
 * may be accepted given: the current document hash vs the expected hash (stale
 * chain, D-006), the candidate's badge, and the set of already-accepted
 * candidates (hunk-range conflict, D-004).
 *
 * Outcomes:
 * - stale / conflict / not_acceptable (mechanical fail or no_fix) -> blocked.
 *   Stale and conflict take precedence over the badge (they are runtime guards).
 * - `review_required` (only JUDGMENT gate(s) failed) -> `{ ok: true, warn:
 *   'judgment', concerns }`: Accept is permitted but the caller must show an
 *   "apply anyway?" QuickPick listing the concerns first (D-023).
 * - otherwise -> `{ ok: true }` (apply directly).
 *
 * @param candidate         the candidate being accepted
 * @param currentHash       hash of the document's current text
 * @param expectedHash      hash the document is expected to have (snapshot hash,
 *                          or the post-accept expected hash in the offset chain)
 * @param acceptedCandidates candidates already accepted this scan
 */
export function evaluateAcceptGuard(
  candidate: RepairCandidate,
  currentHash: string,
  expectedHash: string,
  acceptedCandidates: RepairCandidate[],
): AcceptGuard {
  if (currentHash !== expectedHash) {
    return {
      ok: false,
      reason: 'stale',
      message: STALE_RESULTS_MESSAGE,
    };
  }
  const badge = candidateBadge(candidate);
  if (!badgeAcceptable(badge)) {
    const why =
      badge === 'validation_failed'
        ? 'a validation gate failed'
        : 'no fix was produced (no hunks)';
    return {
      ok: false,
      reason: 'not_acceptable',
      message: `This candidate cannot be accepted: ${why}.`,
    };
  }
  // Conflict is a runtime guard that outranks the judgment warning: never warn
  // about applying a candidate that cannot be applied at all.
  for (const accepted of acceptedCandidates) {
    if (accepted.candidate_id === candidate.candidate_id) continue;
    // D-004: all hunks are Original C based; overlapping ranges = conflict.
    if (candidatesConflict(candidate, accepted)) {
      return {
        ok: false,
        reason: 'conflict',
        conflictId: accepted.candidate_id,
        message: `This candidate conflicts with an already-accepted candidate (${accepted.candidate_id}).`,
      };
    }
  }
  // Only judgment gate(s) failed -> acceptable, but with a warning (D-023).
  if (badgeRequiresWarning(badge)) {
    const concerns = failingGatesByClass(candidate).judgment;
    return {
      ok: true,
      warn: 'judgment',
      concerns,
      message: acceptWarningMessage(concerns),
    };
  }
  return { ok: true };
}
