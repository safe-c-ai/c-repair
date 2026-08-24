// Pure (VS Code API independent) builder for the "Export Feedback Data (JSON)"
// document (feature B, Codex ruling: structured feedback, else the reject-reason
// QuickPick is a UI ritual with nowhere to land). Given a snapshot of the current
// ScanSession's findings + dispositions + identity, it assembles a versioned,
// SOURCE-FREE JSON object suitable for feeding leaderboard / detection-quality
// analysis LOCALLY. The extension.ts command is a thin adapter that gathers the
// inputs, calls buildFeedbackData, JSON-stringifies, and opens the result as an
// untitled JSON document. Never sent over the network by this module.
//
// SOURCE-FREE INVARIANT (guarded by test): the output MUST NOT contain source
// code, diffs, gate DETAIL text (a detail may embed a code fragment or a path),
// absolute paths, or any free text other than the user's own `other` reject
// comment. File names are basenames only (the caller passes session.snapshot.
// filename, already a basename). Hashes identify content without revealing it:
// the original SHA-256 and a per-hunk SHA-256 of each accepted/proposed candidate's
// hunks — never the hunk text itself.

import { createHash } from 'node:crypto';
import type {
  FunctionScanResult,
  RepairCandidate,
  Finding,
  IdVersion,
} from '@c-repair/contract';
import type { CandidateDisposition } from './repairReport';
import { findingState, type FindingState } from './repairReport';

/** The format tag + schema version. Bump `version` on any breaking shape change. */
export const FEEDBACK_FORMAT = 'c-repair-feedback';
export const FEEDBACK_VERSION = 1;

/**
 * Everything buildFeedbackData needs, assembled by extension.ts from the live
 * session + identity. A deliberately SMALL subset of RepairReportInput — only the
 * source-free identity fields plus the per-finding candidate/disposition lookups.
 */
export interface FeedbackDataInput {
  /** ISO-8601 timestamp of generation. */
  generatedAtIso: string;
  /** The scanned file's display name — a BASENAME only (session.snapshot.filename). */
  filename: string;
  /** `sha256:<hex>` of the Original C captured at scan time (content NOT included). */
  originalHash: string;
  /** Extension version (context.extension.packageJSON.version). */
  extensionVersion: string;
  /** Rule-set catalog identity (scan.rule_profile) — WHICH catalog edition judged. */
  ruleProfile: IdVersion;
  /** Effective model id (health caps / candidate model_identity), or undefined. */
  model: string | undefined;
  /** Model mode display label (e.g. "Preset" / "Free" / "Custom"), or undefined. */
  mode: string | undefined;
  /** The full scan result (findings + rule ids + function names). */
  scan: FunctionScanResult;
  /** candidate lookup by finding id (session.candidateForFinding). */
  candidateForFinding: (findingId: string) => RepairCandidate | undefined;
  /** disposition lookup by candidate id (decision + override + rejectReason). */
  dispositionForCandidate: (candidateId: string) => CandidateDisposition;
}

/** A single gate's outcome — name + status ONLY (detail text is deliberately excluded). */
export interface FeedbackGate {
  name: string;
  status: string;
}

/**
 * The per-finding disposition record: which review outcome + whether a judgment
 * gate was overridden. `state` reuses the report's FindingState so both surfaces
 * agree on how a finding is classified.
 */
export interface FeedbackDisposition {
  /** REPAIRED | REJECTED | PROPOSED | UNREPAIRED (report's FindingState). */
  state: FindingState;
  /** The raw decision (accepted / rejected / pending). */
  decision: string;
  /** True only for an accepted-over-judgment-warning candidate (D-023). */
  overrode: boolean;
}

/** The optional reject-reason feedback, source-free (code + the `other` comment only). */
export interface FeedbackRejectReason {
  code: string;
  /** The user's own one-line note (only for `other`), else absent. */
  comment?: string;
}

/** One finding's feedback record. Source-free — see the module SOURCE-FREE INVARIANT. */
export interface FeedbackFinding {
  /** The finding kind (violation / uncertain). */
  kind: string;
  /** The CERT rule id for a violation, else null (uncertain findings have no rule). */
  rule_id: string | null;
  /** The scanned function's name (an identifier, not source text). */
  function_name: string;
  /** The candidate's status (repair_ready / repair_failed / validation_failed), or null. */
  candidate_status: string | null;
  /** Validation gates: name + status ONLY (detail text excluded — may hold code/paths). */
  gates: FeedbackGate[];
  /** The review disposition (state + decision + override). */
  disposition: FeedbackDisposition;
  /** The optional reject-reason feedback, or null when none / not rejected. */
  reject_reason: FeedbackRejectReason | null;
  /** Per-hunk SHA-256 of the candidate's hunks (identifies patches WITHOUT their text). */
  candidate_hunk_hashes: string[];
}

/** The whole exported document: format + version envelope + identity + findings. */
export interface FeedbackData {
  format: typeof FEEDBACK_FORMAT;
  version: typeof FEEDBACK_VERSION;
  generated_at: string;
  /** BASENAME only. */
  filename: string;
  extension_version: string;
  /** WHICH rule catalog edition judged the file (id + version). */
  rule_set: IdVersion;
  model: {
    id: string | null;
    mode: string | null;
  };
  integrity: {
    /** `sha256:<hex>` of the Original C (content NOT included). */
    original_hash: string;
  };
  findings: FeedbackFinding[];
}

/** `sha256:<hex>` over the UTF-8 bytes of `s` (same format as session/hash.ts). */
function sha256(s: string): string {
  return `sha256:${createHash('sha256').update(s, 'utf8').digest('hex')}`;
}

/**
 * A stable per-hunk hash that identifies the patch content without revealing it.
 * Hashes the hunk's coordinates + replacement text so a different fix hashes
 * differently, but the replacement text itself never appears in the output.
 */
function hunkHash(candidate: RepairCandidate): string[] {
  return candidate.hunks.map((h) =>
    sha256(`${h.start_line}:${h.line_count}:${h.replacement_text}`),
  );
}

/**
 * Build the source-free feedback JSON object (feature B). Deterministic — a pure
 * function of `input`. Walks every finding in scan order, resolving its candidate +
 * disposition, and emits only the SOURCE-FREE fields (see module invariant): rule
 * id, function name, candidate status, gate names+statuses (no detail), disposition,
 * reject reason (code + optional `other` comment), and per-hunk hashes.
 */
export function buildFeedbackData(input: FeedbackDataInput): FeedbackData {
  const findings: FeedbackFinding[] = [];
  for (const fn of input.scan.functions) {
    for (const finding of fn.findings) {
      const candidate = input.candidateForFinding(finding.finding_id);
      const disposition = candidate
        ? input.dispositionForCandidate(candidate.candidate_id)
        : undefined;
      const { state, overrode } = findingState(finding, candidate, disposition);
      findings.push(buildFindingRecord(fn.name, finding, candidate, disposition, state, overrode));
    }
  }

  return {
    format: FEEDBACK_FORMAT,
    version: FEEDBACK_VERSION,
    generated_at: input.generatedAtIso,
    filename: input.filename,
    extension_version: input.extensionVersion,
    rule_set: { id: input.ruleProfile.id, version: input.ruleProfile.version },
    model: {
      id: input.model?.trim() ? input.model.trim() : null,
      mode: input.mode?.trim() ? input.mode.trim() : null,
    },
    integrity: { original_hash: input.originalHash },
    findings,
  };
}

/** Assemble one finding's source-free record. */
function buildFindingRecord(
  functionName: string,
  finding: Finding,
  candidate: RepairCandidate | undefined,
  disposition: CandidateDisposition | undefined,
  state: FindingState,
  overrode: boolean,
): FeedbackFinding {
  const reason =
    disposition?.decision === 'rejected' && disposition.rejectReason
      ? {
          code: disposition.rejectReason.code,
          ...(disposition.rejectReason.comment?.trim()
            ? { comment: disposition.rejectReason.comment.trim() }
            : {}),
        }
      : null;

  return {
    kind: finding.kind,
    rule_id: finding.rule_id ?? null,
    function_name: functionName,
    candidate_status: candidate?.status ?? null,
    // Gate NAME + STATUS only — the detail field is deliberately dropped (it can
    // embed a code fragment or a file path, which would break the source-free rule).
    gates: candidate
      ? candidate.validations.map((v) => ({ name: v.name, status: v.status }))
      : [],
    disposition: {
      state,
      decision: disposition?.decision ?? 'pending',
      overrode,
    },
    reject_reason: reason,
    candidate_hunk_hashes: candidate ? hunkHash(candidate) : [],
  };
}
