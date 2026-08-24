// Reject-reason feedback catalog (feature B minimal, user + Codex approved). The
// single source of truth for the five reject-reason codes, their human labels
// (QuickPick rows + report prose), and the RejectReason shape stored on the
// session. Pure — no `vscode` module — so the catalog, the report reflection, and
// the JSON export all read the same definitions under plain Node.
//
// Purpose (owner): collect real reject signal LOCALLY (never sent over the
// network) to feed leaderboard / detection-quality improvement. A reject is never
// blocked by this — the reason is always optional (Esc = reason-less reject).

/** The stable code recorded for a reject reason. `other` may carry a comment. */
export type RejectReasonCode =
  | 'false_positive'
  | 'incorrect_or_unsafe_fix'
  | 'excessive_or_api_change'
  | 'insufficient_context_or_evidence'
  | 'other';

/**
 * A recorded reject reason: the code, plus (only for `other`) an optional one-line
 * free-text comment. Absent reason = a reason-less reject (Esc on the picker); the
 * report then uses the legacy "rejected by the reviewer" wording.
 */
export interface RejectReason {
  code: RejectReasonCode;
  /** Optional one-line note, only ever present for the `other` code. */
  comment?: string;
}

/** One catalog entry: the code + the QuickPick/report display label. */
export interface RejectReasonChoice {
  code: RejectReasonCode;
  /** The reviewer-facing label (QuickPick row and, lower-cased, report prose). */
  label: string;
}

/**
 * The five reject reasons, in QuickPick display order. Labels are the exact
 * approved wording; `other` opens an optional InputBox for a one-line comment.
 * This list is the ONLY place the codes and labels are defined.
 */
export const REJECT_REASONS: readonly RejectReasonChoice[] = [
  { code: 'false_positive', label: 'False positive — this is not a real violation' },
  { code: 'incorrect_or_unsafe_fix', label: 'Incorrect or unsafe fix' },
  { code: 'excessive_or_api_change', label: 'Excessive change / unwanted API change' },
  { code: 'insufficient_context_or_evidence', label: 'Not enough context to judge' },
  { code: 'other', label: 'Other…' },
];

/** The QuickPick placeholder (stored-locally reassurance, reject-not-blocked). */
export const REJECT_REASON_PLACEHOLDER =
  'Why reject? (optional — helps improve detection/repair quality; stored locally only)';

/** Look up a reason's display label by code (undefined for an unknown code). */
export function rejectReasonLabel(code: RejectReasonCode): string | undefined {
  return REJECT_REASONS.find((r) => r.code === code)?.label;
}

/**
 * The report prose for a recorded reject reason (§4/§5): the label lower-cased
 * (so it reads inline, e.g. "false positive — this is not a real violation"),
 * with the `other` comment appended when present. Returns undefined for an
 * unknown code so the caller falls back to the legacy wording.
 */
export function rejectReasonReportText(reason: RejectReason): string | undefined {
  const label = rejectReasonLabel(reason.code);
  if (!label) return undefined;
  const base = label.replace(/…$/, '').toLowerCase();
  const comment = reason.comment?.trim();
  return comment ? `${base} — ${comment}` : base;
}
