// Pure (VS Code API independent) builder for the "Export Repair Report"
// Markdown (D-004 / D-006 / D-023 / D-032 / D-039). Given a snapshot of the
// current ScanSession plus the resolved identity fields (extension version,
// harness/adapter/model identity from /health or the scan result), it assembles
// a human-readable review report and returns it as a Markdown string. The
// extension.ts command is a thin adapter that gathers the inputs, calls
// buildRepairReport, and opens the result as an untitled markdown document.
//
// Design basis (user-approved, Codex-reviewed): "evidence sufficient for a
// review" — neither exhaustive nor sparse. The report's value is the CHAIN
//   rule → location → accepted fix → gate evidence/override → hunk → result hash,
// not the diff itself. So the report leads with identity + integrity, states its
// scope and limits (D-032 still-missing symbols, compile skipped), tabulates
// every finding's disposition, calls out overrides and unresolved risks, then
// appends per-finding evidence (gate results + the accepted hunks' unified diff).
//
// The report is also usable MID-REVIEW (user feedback): undecided candidates
// (hunks > 0, no decision) appear as PROPOSED — counted in a headline line,
// leading the §5 appendix with their diffs under an unmistakable "NOT applied —
// review pending" heading. Once every candidate is decided, all PROPOSED
// artifacts disappear and the report is a pure record again.
//
// Rejected diffs are opt-in (`crepair.report.includeRejectedProposals`, default
// off): on, they close the §5 appendix as explicitly-marked reference-only
// material for hand-written fixes (see isRejectedReference for the history).
//
// Deliberately EXCLUDED (Codex ruling: noise): cost, token counts, prompt text.
// Kept `vscode`-free so every section is unit tested under plain Node.

import type {
  FunctionScanResult,
  ScanFunction,
  Finding,
  RepairCandidate,
  Validation,
  Hunk,
  IdVersion,
  Decision,
} from '@c-repair/contract';
import { gateClass } from '../ui/model';
import { rejectReasonReportText, type RejectReason } from './rejectReason';

// --- inputs -----------------------------------------------------------------

/**
 * The per-candidate disposition the extension resolves from the session: the
 * decision, and — for an `accepted` candidate — whether it was accepted over a
 * failing judgment gate (D-023 override). `overrode` is only meaningful when
 * `decision === 'accepted'`; it is false for every other decision.
 */
export interface CandidateDisposition {
  decision: Decision;
  /** True only for an accepted-over-judgment-warning candidate (D-023). */
  overrode: boolean;
  /**
   * The optional reject-reason feedback (feature B), present only for a `rejected`
   * candidate that carried a reason. Absent = a reason-less reject (the report then
   * uses the legacy "rejected by the reviewer" wording).
   */
  rejectReason?: RejectReason;
}

/** The resolved model identity + mode shown in the identity section. */
export interface ReportModelIdentity {
  /** Effective model id (from /health caps, else the candidate model_identity). */
  model: string | undefined;
  /** The model mode display label (e.g. "Preset" / "Free" / "Custom", D-038). */
  mode: string | undefined;
}

/**
 * Everything buildRepairReport needs, assembled by extension.ts from the live
 * session, the last /health capabilities, and the workspace config. Kept as a
 * plain data bag so the builder is a pure function of its input.
 */
export interface RepairReportInput {
  /** ISO-8601 timestamp of report generation (caller passes new Date().toISOString()). */
  generatedAtIso: string;
  /** The scanned file's display name (session.snapshot.filename). */
  filename: string;
  /** `sha256:<hex>` of the Original C captured at scan time. */
  originalHash: string;
  /**
   * The hash the document is EXPECTED to have now — the head of the D-006 accept
   * chain. Equal to originalHash when nothing has been accepted (rendered as
   * "unchanged"); otherwise the post-accept hash.
   */
  expectedHash: string;
  /** Extension version (context.extension.packageJSON.version). */
  extensionVersion: string;
  /** Rule profile identity (scan result). */
  ruleProfile: IdVersion;
  /**
   * The bundled catalog's rule count (/health capabilities.rules_count, mirrored
   * from the bridge handshake). Used to phrase the §1 Rule set line as "<N>-rule
   * ID/title catalog supplied as context to detection" — stating what the catalog
   * IS (detection context) without implying exhaustive per-rule coverage.
   * `undefined` (no handshake yet) degrades to the count-less wording.
   */
  ruleCount?: number;
  /** Effective model identity + mode. */
  model: ReportModelIdentity;
  /** The full scan result (all functions + findings). */
  scan: FunctionScanResult;
  /**
   * Residual missing-symbol count from the last /context/check before this scan
   * (D-032). `undefined` = no check asserted; `0` = context complete; `> 0` =
   * context was known-incomplete (0 violations is not a safety guarantee).
   */
  contextStillMissing: number | undefined;
  /**
   * The confirmed context items' provenance breakdown, for the scope section:
   * how many inferred declarations the user confirmed and where they came from.
   * Absent items => empty array.
   */
  contextProvenance: ProvenanceCount[];
  /** candidate lookup by finding id (session.candidateForFinding). */
  candidateForFinding: (findingId: string) => RepairCandidate | undefined;
  /** disposition lookup by candidate id (decision + override). */
  dispositionForCandidate: (candidateId: string) => CandidateDisposition;
  /**
   * `crepair.report.includeRejectedProposals` (default false). When true, every
   * rejected candidate with hunks gets its diff appended to the §5 tail as
   * reference-only material ("Rejected proposal (NOT applied) — reference only",
   * with the reject reason above and a do-not-apply warning below). When false
   * (the default) rejected candidates keep the lean record shape: gate evidence
   * + reason, no diff.
   *
   * History: a reject-reason CATEGORY selection was designed first (publish
   * excessive_or_api_change / insufficient_context_or_evidence / other /
   * unrecorded; suppress false_positive / incorrect_or_unsafe_fix as bad-code
   * copy hazards). The user simplified it to this explicit toggle: once the
   * reviewer opts in, the report does not second-guess by category.
   */
  includeRejectedProposals: boolean;
}

/** A confirmed-context provenance tally row for the scope section. */
export interface ProvenanceCount {
  provenance: string;
  count: number;
}

// --- finding disposition (§3) -----------------------------------------------

/**
 * A finding's overall disposition state for the §3 table. A `violation` finding
 * maps by its candidate + decision; an `uncertain` finding is never repairable so
 * it is reported as UNREPAIRED (no candidate exists). CLEAN functions are counted
 * separately (they have no findings) — this enum is per-finding only.
 *
 * PROPOSED = a real (diffable) candidate exists but no decision has been recorded
 * yet: an action item awaiting review, distinct from UNREPAIRED (no candidate /
 * repair_failed — nothing reviewable exists). A report containing PROPOSED
 * findings is a review-in-progress digest, not only a final record; once every
 * candidate is decided, PROPOSED disappears naturally.
 */
export type FindingState = 'REPAIRED' | 'REJECTED' | 'PROPOSED' | 'UNREPAIRED';

/**
 * Resolve a finding's disposition state (§3):
 * - a `violation` whose candidate was accepted -> REPAIRED
 * - a `violation` whose candidate was rejected -> REJECTED
 * - a `violation` with an undecided, diffable candidate (hunks > 0 and not
 *   repair_failed; includes validation_failed) -> PROPOSED (awaiting review)
 * - anything else (no candidate, no_fix, or an `uncertain` finding) -> UNREPAIRED
 * The override flag rides along (true only for an accepted-over-judgment candidate).
 */
export function findingState(
  finding: Finding,
  candidate: RepairCandidate | undefined,
  disposition: CandidateDisposition | undefined,
): { state: FindingState; overrode: boolean } {
  if (finding.kind !== 'violation' || !candidate || !disposition) {
    return { state: 'UNREPAIRED', overrode: false };
  }
  if (disposition.decision === 'accepted') {
    return { state: 'REPAIRED', overrode: disposition.overrode };
  }
  if (disposition.decision === 'rejected') {
    return { state: 'REJECTED', overrode: false };
  }
  // Pending decision: a diffable candidate is PROPOSED (an action item the
  // reviewer has yet to decide); a hunkless / repair_failed candidate offers
  // nothing to review, so it stays UNREPAIRED.
  if (candidate.hunks.length > 0 && candidate.status !== 'repair_failed') {
    return { state: 'PROPOSED', overrode: false };
  }
  return { state: 'UNREPAIRED', overrode: false };
}

/** One row of the §3 finding-disposition table. */
export interface DispositionRow {
  functionName: string;
  /** `<rule_id>: <title>` for a violation; the uncertain summary otherwise. */
  rule: string;
  state: FindingState;
  overrode: boolean;
  /** The finding + its candidate, for the evidence appendix (§5). */
  finding: Finding;
  candidate: RepairCandidate | undefined;
  disposition: CandidateDisposition | undefined;
}

/** The rule label for a finding: `<rule_id>: <title>` or just the summary. */
export function findingRuleLabel(f: Finding): string {
  const title = f.rule_summary.trim();
  if (f.kind === 'violation' && f.rule_id) {
    return title ? `${f.rule_id}: ${title}` : f.rule_id;
  }
  return title || '(unclassified)';
}

/**
 * Build the §3 rows for every finding across all functions, in scan order
 * (function order, then finding order). CLEAN functions contribute no rows (they
 * are counted separately, §3 footer). Deterministic — no sorting beyond scan order.
 */
export function dispositionRows(input: RepairReportInput): DispositionRow[] {
  const rows: DispositionRow[] = [];
  for (const fn of input.scan.functions) {
    for (const finding of fn.findings) {
      const candidate = input.candidateForFinding(finding.finding_id);
      const disposition = candidate
        ? input.dispositionForCandidate(candidate.candidate_id)
        : undefined;
      const { state, overrode } = findingState(finding, candidate, disposition);
      rows.push({
        functionName: fn.name,
        rule: findingRuleLabel(finding),
        state,
        overrode,
        finding,
        candidate,
        disposition,
      });
    }
  }
  return rows;
}

/** The count of CLEAN functions (no findings) for the §3 footer. */
export function cleanFunctionCount(functions: ScanFunction[]): number {
  return functions.filter((fn) => fn.findings.length === 0).length;
}

// --- validation helpers (shared by §4/§5) -----------------------------------

/** The failing judgment gates of a candidate (semantic / violation_removal / regression). */
export function failingJudgmentGates(c: RepairCandidate): Validation[] {
  return c.validations.filter((v) => v.status === 'fail' && gateClass(v.name) === 'judgment');
}

/** All failing gates (any class). */
export function failingGates(c: RepairCandidate): Validation[] {
  return c.validations.filter((v) => v.status === 'fail');
}

/** True when a candidate has a compile gate that was skipped (D-017c / evidence gap). */
export function compileSkipped(c: RepairCandidate): boolean {
  return c.validations.some((v) => v.name === 'compile' && v.status === 'skipped');
}

// --- unified diff of accepted hunks (§5) ------------------------------------

/**
 * Render one hunk as a unified-diff fragment against the Original C, with up to
 * `context` lines of surrounding context (default 3). Coordinates are Original C
 * basis (1-indexed, both ends inclusive — CONTRACT.md §1); the header line numbers
 * are Original-based, matching D-004 ("diff left pane is always Original C").
 *
 * - replace (line_count=n>0): removes lines [start .. start+n-1], adds the
 *   replacement lines.
 * - insert (line_count=0): adds the replacement lines before `start`, removing nothing.
 * A pure deletion (empty replacement, n>0) removes with no additions.
 */
export function hunkUnifiedDiff(original: string, hunk: Hunk, context = 3): string {
  const lines = original.split('\n');
  const total = lines.length;

  // Removed span (1-indexed inclusive). Insert = zero-width before start_line.
  const removeStart = hunk.start_line; // 1-indexed
  const removeCount = hunk.line_count; // 0 = insert
  const addLines =
    hunk.replacement_text === '' && hunk.line_count > 0
      ? []
      : hunk.replacement_text.split('\n');

  // Context window (0-indexed into `lines`).
  const firstAffected0 = removeStart - 1; // where the change begins
  const ctxStart0 = Math.max(0, firstAffected0 - context);
  // For a replace, context after the removed span; for an insert, after start.
  const lastRemoved0 = removeCount > 0 ? removeStart - 1 + removeCount - 1 : firstAffected0 - 1;
  const ctxEnd0 = Math.min(total - 1, (removeCount > 0 ? lastRemoved0 : firstAffected0 - 1) + context);

  const before: string[] = [];
  for (let i = ctxStart0; i < firstAffected0; i += 1) before.push(` ${lines[i]}`);

  const removed: string[] = [];
  if (removeCount > 0) {
    for (let i = removeStart - 1; i < removeStart - 1 + removeCount && i < total; i += 1) {
      removed.push(`-${lines[i]}`);
    }
  }

  const added: string[] = addLines.map((l) => `+${l}`);

  const after: string[] = [];
  const afterStart0 = removeCount > 0 ? lastRemoved0 + 1 : firstAffected0;
  for (let i = afterStart0; i <= ctxEnd0 && i < total; i += 1) after.push(` ${lines[i]}`);

  // Hunk header @@ -oldStart,oldLen +newStart,newLen @@ (Original-based).
  const oldStart = ctxStart0 + 1;
  const oldLen = before.length + removed.length + after.length;
  const newStart = oldStart;
  const newLen = before.length + added.length + after.length;
  const header = `@@ -${oldStart},${oldLen} +${newStart},${newLen} @@`;

  return [header, ...before, ...removed, ...added, ...after].join('\n');
}

/** Render every hunk of a candidate as a fenced unified-diff block (§5). */
export function candidateUnifiedDiff(original: string, candidate: RepairCandidate, context = 3): string {
  return candidate.hunks.map((h) => hunkUnifiedDiff(original, h, context)).join('\n');
}

// --- disclaimer (§6, D-039) -------------------------------------------------

/**
 * §6 trademark/status notice — the legal-hygiene MINIMUM for a document that
 * travels standalone while carrying the CERT® mark and rule titles (D-039).
 * Everything epistemic (point-in-time, single translation unit, possible missed
 * violations, human-reviewed candidates) lives in §2 Scope & limitations and is
 * deliberately NOT repeated here: the owner's design criterion is "sufficient as
 * review evidence, neither too detailed nor too sparse", and a full disclaimer
 * paragraph on a change report read as excessive (user + Codex review agreed).
 */
export const REPORT_DISCLAIMER =
  'CERT® is a registered trademark of Carnegie Mellon University. C Repair is not ' +
  'affiliated with or endorsed by Carnegie Mellon University or its Software ' +
  'Engineering Institute; this report does not constitute certification of CERT C ' +
  'conformance.';

// --- report assembly --------------------------------------------------------

/**
 * Reviewer-friendly rule-set provenance line. The raw contract value is an
 * id+version pair like `cert-c` / `certfix-0.4.1-bundled`; spelled out so a
 * reviewer understands it identifies WHICH rule catalog edition judged the
 * file (a different harness release may bundle a different catalog).
 *
 * With a rule count (user + Codex round: don't let the line read as exhaustive
 * coverage), the wording states the catalog's actual ROLE — an N-rule ID/title
 * catalog supplied as *context to detection* — matching the §2 methodology
 * bullet. Without a count (no /health handshake), it degrades to the count-less
 * form rather than inventing a number.
 */
function ruleSetLine(v: IdVersion, ruleCount: number | undefined): string {
  const standard = v.id === 'cert-c' ? 'CERT C' : v.id;
  if (ruleCount !== undefined && ruleCount > 0) {
    return (
      `${standard} — \`${v.version}\`: **${ruleCount}-rule ID/title catalog supplied ` +
      'as context to detection** (bundled with this harness release)'
    );
  }
  return `${standard} — catalog \`${v.version}\` (the rule set bundled with this harness release)`;
}

/** Escape a value for a Markdown table cell (pipes + newlines). */
function cell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/**
 * Build §1 Report identity & integrity — six visible lines (user + Codex trim,
 * 2026-08-24): File / Generated / Tool / Rule set / Model / one Integrity line
 * stating the input->output hash boundary. Cut as non-evidence: Harness (the
 * rule-set catalog string already embeds the harness release), Adapter
 * (internal plumbing), Context revision (redundant with the original hash).
 * The scan id survives only as an invisible, schema-versioned HTML comment —
 * best-effort support/log correlation, never presented as evidence (it may be
 * stripped by copy/paste or sanitizers, which is acceptable).
 */
function buildIdentitySection(input: RepairReportInput): string {
  const applied =
    input.expectedHash === input.originalHash ? 'unchanged (no repairs accepted)' : input.expectedHash;
  const modelId = input.model.model?.trim() || 'unknown';
  const modelMode = input.model.mode?.trim();
  const modelLine = modelMode ? `${modelId} (mode: ${modelMode})` : modelId;
  const lines = [
    '## 1. Report identity & integrity',
    '',
    `- **File:** ${input.filename}`,
    `- **Generated:** ${input.generatedAtIso}`,
    `- **Tool:** C Repair ${input.extensionVersion}`,
    `- **Rule set:** ${ruleSetLine(input.ruleProfile, input.ruleCount)}`,
    `- **Model:** ${modelLine}`,
    `- **Integrity:** original SHA-256 \`${input.originalHash}\`; applied-result ${applied === 'unchanged (no repairs accepted)' ? applied : `SHA-256 \`${applied}\``}`,
    '',
    `<!-- c-repair-support: scan-id=${input.scan.scan_id} -->`,
  ];
  return lines.join('\n');
}

/**
 * The §2 detection-methodology bullet (user + Codex round with the §1 rule-count
 * wording): states HOW detection uses the bundled catalog — LLM evaluation with
 * the catalog as prompt context — so the N-rule count in §1 cannot be read as a
 * per-rule exhaustive analysis or a coverage guarantee. Exported as one constant
 * so the §2 builder and the noise-guard test (which must except this sanctioned
 * descriptive use of the word "prompt") share a single source of truth.
 */
export const DETECTION_SCOPE_NOTE =
  'Detection is LLM-based and evaluates each function using the bundled catalog ' +
  'as prompt context; it does not perform exhaustive per-rule analysis or ' +
  'guarantee detection coverage for every rule.';

/**
 * Build §2 Scope & limitations. Only states what can be asserted (D-032): single
 * translation unit, the LLM-detection methodology bound, confirmed-context
 * provenance, still-missing symbols (with the detection-gap caveat), and any
 * compile gate skipped. Never touches un-scanned or unsupported rules.
 */
function buildScopeSection(input: RepairReportInput): string {
  const lines: string[] = ['## 2. Scope & limitations', ''];
  lines.push(
    '- Only this single translation unit was inspected. Headers, other source ' +
      'files, and anything reached through linking are **out of scope**.',
  );
  lines.push(`- ${DETECTION_SCOPE_NOTE}`);

  const confirmedTotal = input.contextProvenance.reduce((n, p) => n + p.count, 0);
  if (confirmedTotal > 0) {
    const breakdown = input.contextProvenance
      .filter((p) => p.count > 0)
      .map((p) => `${p.count} ${p.provenance}`)
      .join(', ');
    lines.push(
      `- Context: ${confirmedTotal} inferred declaration(s) were confirmed before ` +
        `scanning (${breakdown}).`,
    );
  } else {
    lines.push('- Context: no inferred declarations were needed (self-contained input).');
  }

  if (input.contextStillMissing !== undefined && input.contextStillMissing > 0) {
    lines.push(
      `- **Context incomplete:** ${input.contextStillMissing} symbol(s) remained ` +
        'unresolved at scan time. Findings may be incomplete — **0 violations is not a ' +
        'safety guarantee** (some violations may go undetected when context is missing).',
    );
  }

  // Compile gate skipped on any accepted candidate = an evidence gap worth stating.
  const anyCompileSkipped = input.scan.functions.some((fn) =>
    fn.findings.some((f) => {
      const c = input.candidateForFinding(f.finding_id);
      return c ? compileSkipped(c) : false;
    }),
  );
  if (anyCompileSkipped) {
    lines.push(
      '- Compile gate was **skipped** for one or more repairs (missing include paths ' +
        'or external dependencies), so compile evidence is unavailable for those.',
    );
  }

  return lines.join('\n');
}

/** Build §3 Finding disposition table. */
function buildDispositionSection(rows: DispositionRow[], functions: ScanFunction[]): string {
  const lines: string[] = ['## 3. Finding disposition', ''];
  if (rows.length === 0) {
    lines.push('_No findings were reported._');
  } else {
    lines.push('| Function | Rule | State | Override |');
    lines.push('| --- | --- | --- | --- |');
    for (const r of rows) {
      const override = r.overrode ? 'yes (judgment gate)' : '—';
      lines.push(`| ${cell(r.functionName)} | ${cell(r.rule)} | ${r.state} | ${override} |`);
    }
  }
  const clean = cleanFunctionCount(functions);
  lines.push('');
  lines.push(`_Clean functions (no findings): ${clean} of ${functions.length} scanned._`);
  return lines.join('\n');
}

/**
 * Build §4 Overrides & unresolved risks. Lists judgment-override accepts (gate name
 * + fail reason + the override fact) and every unresolved violation (rejected or
 * unrepaired), with the reason drawn from the gate detail or the user's rejection.
 * PROPOSED findings are deliberately NOT here: an undecided candidate is pending
 * work (an action item in §5), not a recorded risk.
 */
function buildRisksSection(rows: DispositionRow[]): string {
  const lines: string[] = ['## 4. Overrides & unresolved risks', ''];

  const overrides = rows.filter((r) => r.overrode && r.candidate);
  const unresolved = rows.filter(
    (r) =>
      r.finding.kind === 'violation' &&
      (r.state === 'REJECTED' || r.state === 'UNREPAIRED'),
  );

  if (overrides.length === 0 && unresolved.length === 0) {
    lines.push('_No overrides and no unresolved violations._');
    return lines.join('\n');
  }

  if (overrides.length > 0) {
    lines.push('### Accepted over a judgment-gate warning');
    lines.push('');
    for (const r of overrides) {
      const gates = failingJudgmentGates(r.candidate!);
      lines.push(
        `- **${cell(r.functionName)} — ${cell(r.rule)}** — accepted as a starting point ` +
          'despite the failing judgment gate(s) below (D-023):',
      );
      for (const g of gates) {
        lines.push(`  - \`${g.name}\`: ${g.detail ? cell(g.detail) : '(no detail)'}`);
      }
    }
    lines.push('');
  }

  if (unresolved.length > 0) {
    lines.push('### Unresolved violations');
    lines.push('');
    for (const r of unresolved) {
      const reason = unresolvedReason(r);
      lines.push(`- **${cell(r.functionName)} — ${cell(r.rule)}** (${r.state}): ${cell(reason)}`);
    }
  }

  return lines.join('\n');
}

/** The human reason a violation is unresolved (§4): user reject vs gate detail vs no fix. */
export function unresolvedReason(r: DispositionRow): string {
  if (r.state === 'REJECTED') {
    // Reflect the optional reject-reason feedback (feature B) when one was recorded;
    // otherwise the legacy wording. The §4 line already prefixes "(REJECTED): ", so
    // the reason text reads inline, e.g. "(REJECTED): false positive — this is not a
    // real violation." — with the `other` comment appended when present.
    const reason = r.disposition?.rejectReason;
    const text = reason ? rejectReasonReportText(reason) : undefined;
    return text ? `${text}.` : 'rejected by the reviewer.';
  }
  // UNREPAIRED: no candidate, no fix produced, or a blocking gate fail.
  if (!r.candidate) return 'no repair was generated.';
  if (r.candidate.hunks.length === 0 || r.candidate.status === 'repair_failed') {
    return 'no fix could be produced (no hunks).';
  }
  const fails = failingGates(r.candidate);
  if (fails.length > 0) {
    const detail = fails.map((f) => `${f.name}: ${f.detail ?? '(no detail)'}`).join('; ');
    return `blocked by a failing gate — ${detail}`;
  }
  return 'left pending (not accepted).';
}

/**
 * The mandatory warning printed directly below every rejected-reference diff
 * (§5 tail): the diff is study material for a hand-written fix, never a patch.
 */
export const REJECTED_REFERENCE_WARNING =
  '_Do not apply without independent review and adaptation._';

/**
 * Whether this row renders a rejected-reference diff in the §5 tail: the toggle
 * is on, the row is REJECTED, and there are hunks to show.
 *
 * History (user decision, 2 rounds): a reject-reason CATEGORY selection was
 * designed first — publish excessive_or_api_change / insufficient_context_or_
 * evidence / other / unrecorded (hand-fix reference value), suppress
 * false_positive / incorrect_or_unsafe_fix (bad-code copy hazard). The user
 * replaced it with the explicit `crepair.report.includeRejectedProposals`
 * toggle: once the reviewer opts in, ALL rejected diffs are included — the
 * report does not second-guess by category.
 */
function isRejectedReference(r: DispositionRow, includeRejectedProposals: boolean): boolean {
  return (
    includeRejectedProposals &&
    r.state === 'REJECTED' &&
    (r.candidate?.hunks.length ?? 0) > 0
  );
}

/**
 * Build §5 Per-finding evidence (appendix). PROPOSED (undecided) candidates lead —
 * they are the reviewer's action items, so a reader working through the report
 * meets what still needs a decision first — then override / unresolved findings,
 * then plainly-accepted ones, and (only when `crepair.report.
 * includeRejectedProposals` is on) rejected-reference diffs at the very end.
 * Each: gate results (fail => full detail text; pass => a ✓ list) plus the hunks'
 * unified diff. Diff headings are unambiguous about application state: accepted =
 * "Accepted change …"; PROPOSED = "Proposed change (NOT applied — review pending
 * …)"; rejected-reference = "Rejected proposal (NOT applied) — reference only"
 * with the reject reason directly above and a do-not-apply warning directly
 * below. With the toggle off (default), rejected candidates get no diff — gate
 * evidence + reason only (the lean decision record, D-004 spirit).
 */
function buildEvidenceSection(
  rows: DispositionRow[],
  original: string,
  includeRejectedProposals: boolean,
): string {
  const lines: string[] = ['## 5. Per-finding evidence (appendix)', ''];

  // Only findings with a candidate produce evidence. Order: PROPOSED (action
  // items) first, then override / unresolved (attention-worthy), then plain
  // accepted, then rejected-reference diffs (opt-in study material) last.
  const withCandidate = rows.filter((r) => r.candidate);
  const priority = (r: DispositionRow): number => {
    if (r.state === 'PROPOSED') return 0; // awaiting review — read these first
    if (r.overrode) return 1;
    if (isRejectedReference(r, includeRejectedProposals)) return 4; // reference tail
    if (r.state === 'REJECTED' || r.state === 'UNREPAIRED') return 2;
    return 3; // plain accepted
  };
  const ordered = [...withCandidate].sort((a, b) => priority(a) - priority(b));

  if (ordered.length === 0) {
    lines.push('_No repair candidates were generated._');
    return lines.join('\n');
  }

  for (const r of ordered) {
    const c = r.candidate!;
    const rejectedRef = isRejectedReference(r, includeRejectedProposals);
    lines.push(`### ${r.functionName} — ${r.rule} [${r.state}${r.overrode ? ', override' : ''}]`);
    lines.push('');
    if (r.state === 'PROPOSED') {
      // State the candidate's own status (repair_ready / validation_failed) so
      // the reviewer knows what kind of proposal they are looking at.
      lines.push(`_Candidate status: ${c.status} — no decision recorded yet._`);
      lines.push('');
    }
    // The one-line reject reason (feature B; absent reason => legacy wording).
    // For a reference entry it moves to sit DIRECTLY ABOVE the diff heading (the
    // reader must meet the rejection rationale before the diff); otherwise it
    // stays at the entry top, mirroring §4.
    const rejectedNote =
      r.state === 'REJECTED'
        ? `_Rejected: ${
            (r.disposition?.rejectReason
              ? rejectReasonReportText(r.disposition.rejectReason)
              : undefined) ?? 'rejected by the reviewer'
          }._`
        : undefined;
    if (rejectedNote && !rejectedRef) {
      lines.push(rejectedNote);
      lines.push('');
    }
    if (c.repair_explanation.trim()) {
      lines.push(c.repair_explanation.trim());
      lines.push('');
    }

    // Gate evidence: fails get the full detail text; passes are a compact ✓ list.
    lines.push('**Validation gates:**');
    lines.push('');
    const passed = c.validations.filter((v) => v.status === 'pass').map((v) => v.name);
    const others = c.validations.filter((v) => v.status !== 'pass');
    if (passed.length > 0) lines.push(`- ✓ passed: ${passed.join(', ')}`);
    for (const v of others) {
      const mark = v.status === 'fail' ? '✗' : v.status === 'skipped' ? '⚠' : '·';
      lines.push(`- ${mark} \`${v.name}\`: ${v.status}${v.detail ? ` — ${v.detail}` : ''}`);
    }
    lines.push('');

    // Hunk diff. Accepted candidates show what was applied; PROPOSED candidates
    // show what WOULD be applied; rejected-reference (toggle on) shows the
    // rejected proposal as explicitly-marked study material. Toggle off:
    // rejected candidates get no diff.
    if (r.disposition?.decision === 'accepted' && c.hunks.length > 0) {
      lines.push('**Accepted change (unified diff, Original C basis):**');
      lines.push('');
      lines.push('```diff');
      lines.push(candidateUnifiedDiff(original, c));
      lines.push('```');
      lines.push('');
    } else if (r.state === 'PROPOSED') {
      lines.push('**Proposed change (NOT applied — review pending, unified diff, Original C basis):**');
      lines.push('');
      lines.push('```diff');
      lines.push(candidateUnifiedDiff(original, c));
      lines.push('```');
      lines.push('');
    } else if (rejectedRef) {
      lines.push(rejectedNote!);
      lines.push('');
      lines.push('**Rejected proposal (NOT applied) — reference only:**');
      lines.push('');
      lines.push('```diff');
      lines.push(candidateUnifiedDiff(original, c));
      lines.push('```');
      lines.push('');
      lines.push(REJECTED_REFERENCE_WARNING);
      lines.push('');
    }
  }

  return lines.join('\n').trimEnd();
}

/**
 * The headline note shown when the report contains undecided (PROPOSED)
 * candidates: the reader must know up front that this is a review-in-progress
 * digest, not only a final record. Returns undefined when every candidate is
 * decided, so the line (and the digest framing) disappears naturally.
 */
export function proposedSummaryLine(rows: DispositionRow[]): string | undefined {
  const n = rows.filter((r) => r.state === 'PROPOSED').length;
  if (n === 0) return undefined;
  const noun = n === 1 ? 'proposed fix' : 'proposed fixes';
  return (
    `**${n} ${noun} awaiting review** — undecided candidates are included below ` +
    '(marked NOT applied). This report is a review-in-progress digest; it becomes a ' +
    'pure record once every candidate is decided.'
  );
}

/**
 * Assemble the full "Export Repair Report" Markdown (§1–§6) from the input bag.
 * Pure — a deterministic function of `input` (and `original`, the Original C text
 * the diffs render against, which is the same bytes as the snapshot content).
 */
export function buildRepairReport(input: RepairReportInput, original: string): string {
  const rows = dispositionRows(input);
  const proposedLine = proposedSummaryLine(rows);
  const sections = [
    `# C Repair — Repair Report`,
    '',
    `Standard: CERT® C`,
    '',
    ...(proposedLine ? [proposedLine, ''] : []),
    buildIdentitySection(input),
    '',
    buildScopeSection(input),
    '',
    buildDispositionSection(rows, input.scan.functions),
    '',
    buildRisksSection(rows),
    '',
    buildEvidenceSection(rows, original, input.includeRejectedProposals),
    '',
    '## 6. Trademark and status notice',
    '',
    REPORT_DISCLAIMER,
    '',
  ];
  return sections.join('\n');
}
