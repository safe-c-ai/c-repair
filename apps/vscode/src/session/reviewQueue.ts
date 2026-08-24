// Review-queue derivation for the scan → auto-repair → diff-review pipeline
// (D-024). Pure (no `vscode` import) so the ordering / limit-guard / next-pending
// selection logic is unit testable under plain Node. extension.ts owns the
// stateful VS Code side (running /repair, opening diffs, advancing the queue) and
// calls these to decide *what* to do.
//
// Queue order (D-024): the violation findings in function-appearance order, i.e.
// by the finding's Original C `start_line` ascending. The auto-repair pipeline
// generates in this order and the diff review advances through it in this order.

import type {
  FunctionScanResult,
  ScanFunction,
  Finding,
  RepairCandidate,
} from '@c-repair/contract';
import { candidateHasDiff, candidateBadge, badgeAcceptable } from '../ui/model';

/** A violation finding paired with its owning function, in queue order. */
export interface QueueTarget {
  fn: ScanFunction;
  finding: Finding;
}

/**
 * The violation findings of a scan in queue order (D-024): ascending by the
 * finding's Original C `start_line`. Only `violation` findings are queued —
 * `uncertain` findings are not repairable. Ties (same start_line) keep the scan's
 * function order, which is deterministic. Pure so the ordering is unit tested.
 */
export function violationTargetsInOrder(scan: FunctionScanResult): QueueTarget[] {
  const targets: QueueTarget[] = [];
  for (const fn of scan.functions) {
    for (const finding of fn.findings) {
      if (finding.kind === 'violation') targets.push({ fn, finding });
    }
  }
  // Stable sort by the finding's start_line (function appearance order, D-024).
  return targets
    .map((t, i) => ({ t, i }))
    .sort((a, b) => {
      const d = a.t.finding.location.start_line - b.t.finding.location.start_line;
      return d !== 0 ? d : a.i - b.i;
    })
    .map((x) => x.t);
}

/**
 * The limit-guard decision before auto-generating repairs for `violationCount`
 * findings, given `crepair.autoRepairLimit` (D-024 cost guard). `autoRepair`
 * gates whether the pipeline runs at all; since D-025 the caller sets this from
 * the command choice (Scan & Fix passes true; plain Scan never reaches here) —
 * the old `crepair.autoRepair` setting was removed. Kept as a parameter so the
 * branching stays a pure, unit-tested function.
 *
 * - `autoRepair=false`  -> `off`: no auto-generation (never used by production now).
 * - count === 0         -> `none`: nothing to generate.
 * - count <= limit      -> `all`: generate all, no confirmation.
 * - count > limit       -> `confirm`: ask the user (Generate all / First <limit> /
 *                          Cancel) before generating.
 *
 * Pure so the branching is unit tested.
 */
export type AutoRepairPlan =
  | { kind: 'off' }
  | { kind: 'none' }
  | { kind: 'all'; count: number }
  | { kind: 'confirm'; count: number; limit: number };

export function planAutoRepair(
  autoRepair: boolean,
  violationCount: number,
  limit: number,
): AutoRepairPlan {
  if (!autoRepair) return { kind: 'off' };
  if (violationCount === 0) return { kind: 'none' };
  if (violationCount <= limit) return { kind: 'all', count: violationCount };
  return { kind: 'confirm', count: violationCount, limit };
}

/**
 * The candidates that belong in the diff review queue, in queue order (D-024).
 * Built by walking `targetsInOrder` and, for each finding that has a generated
 * candidate, keeping only the DIFFABLE ones (a `no_fix` / repair_failed candidate
 * has no hunks so there is nothing to diff — it stays in the tree only). Findings
 * without a candidate yet are simply absent (they join once generated).
 *
 * `candidateForFinding` is the session lookup (finding_id -> candidate | undefined),
 * passed in so this stays `vscode`-free and unit testable.
 */
export function diffableQueue(
  targets: QueueTarget[],
  candidateForFinding: (findingId: string) => RepairCandidate | undefined,
): RepairCandidate[] {
  const out: RepairCandidate[] = [];
  for (const t of targets) {
    const c = candidateForFinding(t.finding.finding_id);
    if (c && candidateHasDiff(c)) out.push(c);
  }
  return out;
}

/**
 * Select the next PENDING diffable candidate to review after acting on
 * `currentCandidateId` (D-024 auto-advance). Walks the diffable queue and returns
 * the first candidate that is still pending (decision !== accepted/rejected),
 * strictly AFTER the current one in queue order. Accepted/rejected candidates are
 * skipped. When `currentCandidateId` is undefined (opening the first diff), it
 * returns the first pending candidate from the start.
 *
 * Returns undefined when nothing pending remains (review complete).
 *
 * `isPending` is the session lookup (candidate_id -> whether it is still pending),
 * passed in to keep this pure.
 */
export function nextPendingDiffable(
  queue: RepairCandidate[],
  currentCandidateId: string | undefined,
  isPending: (candidateId: string) => boolean,
): RepairCandidate | undefined {
  // Start searching after the current candidate's queue position; from the start
  // when there is no current one.
  let startIdx = 0;
  if (currentCandidateId !== undefined) {
    const idx = queue.findIndex((c) => c.candidate_id === currentCandidateId);
    startIdx = idx === -1 ? 0 : idx + 1;
  }
  for (let i = startIdx; i < queue.length; i += 1) {
    if (isPending(queue[i].candidate_id)) return queue[i];
  }
  return undefined;
}

/**
 * The first pending diffable candidate anywhere in the queue (not relative to a
 * current one) — used when auto-opening the first diff as candidates complete, and
 * to detect "review complete" (undefined = none pending). Equivalent to
 * `nextPendingDiffable(queue, undefined, isPending)`.
 */
export function firstPendingDiffable(
  queue: RepairCandidate[],
  isPending: (candidateId: string) => boolean,
): RepairCandidate | undefined {
  return nextPendingDiffable(queue, undefined, isPending);
}

/** The tally shown in the "Review complete" notification (D-024). */
export interface ReviewTally {
  accepted: number;
  rejected: number;
  pending: number;
}

/**
 * Tally the accepted / rejected / pending decisions across the diffable queue
 * (D-024 completion summary). `decisionFor` is the session lookup (candidate_id ->
 * 'accepted' | 'rejected' | 'pending'); anything not accepted/rejected counts as
 * pending. Pure so the summary is unit tested.
 */
export function reviewTally(
  queue: RepairCandidate[],
  decisionFor: (candidateId: string) => string,
): ReviewTally {
  let accepted = 0;
  let rejected = 0;
  let pending = 0;
  for (const c of queue) {
    const d = decisionFor(c.candidate_id);
    if (d === 'accepted') accepted += 1;
    else if (d === 'rejected') rejected += 1;
    else pending += 1;
  }
  return { accepted, rejected, pending };
}

// --- Accept all reviewed (V1c, D-014) ----------------------------------------

/**
 * The candidates `Accept all reviewed` targets, split by reviewed-ness (D-014:
 * target = eligible (D-005) ∧ reviewed).
 *
 * Eligible here is the STATIC part of D-005 — diffable (has hunks) with an
 * acceptable badge (repair_ready family; a validation_failed / no_fix candidate
 * is never eligible) and still pending. The RUNTIME part of D-005 (no hunk
 * conflict with already-accepted candidates) is evaluated per candidate at
 * apply time via the shared accept guard, because each accept changes the
 * accepted set for the next one.
 *
 * `toAccept` is ordered by candidate ID ascending — the D-014 apply order —
 * and `notReviewed` holds the otherwise-eligible candidates whose diff was
 * never displayed (skipped with their own tally bucket, D-014 skip 方式).
 */
export interface AcceptAllSelection {
  toAccept: RepairCandidate[];
  notReviewed: RepairCandidate[];
}

export function selectAcceptAllReviewed(
  candidates: RepairCandidate[],
  isPending: (candidateId: string) => boolean,
  wasReviewed: (candidateId: string) => boolean,
): AcceptAllSelection {
  const eligible = candidates.filter(
    (c) =>
      candidateHasDiff(c) &&
      badgeAcceptable(candidateBadge(c)) &&
      isPending(c.candidate_id),
  );
  const sorted = [...eligible].sort((a, b) =>
    a.candidate_id < b.candidate_id ? -1 : a.candidate_id > b.candidate_id ? 1 : 0,
  );
  const toAccept: RepairCandidate[] = [];
  const notReviewed: RepairCandidate[] = [];
  for (const c of sorted) {
    (wasReviewed(c.candidate_id) ? toAccept : notReviewed).push(c);
  }
  return { toAccept, notReviewed };
}

/** The per-reason outcome tally of one `Accept all reviewed` run (D-014). */
export interface AcceptAllTally {
  accepted: number;
  /** Skipped: hunks overlap an already-accepted candidate (runtime D-005). */
  conflict: number;
  /** Skipped: eligible but the diff was never displayed (D-014 reviewed). */
  notReviewed: number;
  /**
   * Skipped: a judgment gate raised a warning — accepting those requires the
   * per-candidate confirmation (D-023), which a batch must not silently
   * bypass. Accept them individually.
   */
  needsConfirmation: number;
  /** The WorkspaceEdit did not apply (unexpected editor-side failure). */
  failed: number;
  /** Duplicate `#include` lines dropped across the batch (D-026). */
  dedupedIncludes: number;
}

/**
 * The result-notification line for an `Accept all reviewed` run. The fixed
 * D-014 core is always present — `n accepted / m skipped (conflict) / k
 * skipped (not reviewed)` — and the extra buckets (needs-confirmation, apply
 * failures, D-026 include dedupes) are appended only when non-zero.
 */
export function acceptAllSummary(t: AcceptAllTally): string {
  const parts = [
    `${t.accepted} accepted`,
    `${t.conflict} skipped (conflict)`,
    `${t.notReviewed} skipped (not reviewed)`,
  ];
  if (t.needsConfirmation > 0) {
    parts.push(`${t.needsConfirmation} skipped (needs per-candidate confirmation)`);
  }
  if (t.failed > 0) parts.push(`${t.failed} failed to apply`);
  let line = parts.join(' / ');
  if (t.dedupedIncludes > 0) {
    const plural = t.dedupedIncludes === 1 ? '' : 's';
    line += ` — ${t.dedupedIncludes} duplicate #include line${plural} skipped`;
  }
  return line;
}
