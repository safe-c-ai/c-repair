// Context Review orchestration state + pure messaging helpers (V2b, design §3).
// The VS Code interactions (opening the untitled doc, notifications, running the
// scan) live in extension.ts; this module holds the small pure pieces so they are
// unit testable and keeps extension.ts readable.

import type { CheckContextResponse } from '../bridge/BridgeClient';

/** How the extension should treat context review before scanning (design §3). */
export type ContextReviewMode = 'when-needed' | 'always' | 'never';

/**
 * Decide what the scan flow does with a draft set of a given size, given the
 * user's `crepair.contextReview` setting. Pure so the branching is unit tested.
 *
 *  - `never`  -> always skip the Review; confirm with items unconfirmed
 *               (assumption-dependent). Applies even with items.
 *  - items 0  -> nothing to review; skip straight to scan (self-contained file;
 *               `always` cannot show a meaningful empty Review, so it is skipped
 *               too — see report).
 *  - otherwise (`when-needed`/`always` with items > 0) -> open the Review.
 */
export type ReviewDecision = 'review' | 'skip' | 'direct';

export function decideReview(mode: ContextReviewMode, itemCount: number): ReviewDecision {
  if (mode === 'never') return 'skip';
  if (itemCount === 0) return 'direct';
  return 'review';
}

/**
 * The result-notification copy for a /context/check response (design §3). When it
 * compiles, we say so; otherwise we name the still-missing symbols and warn that
 * scanning now leaves the compile gate skipped. `blocking` is true when the user
 * should be offered a Continue / Edit-context choice (missing symbols), false when
 * we can proceed straight to scan.
 */
export interface CheckMessage {
  blocking: boolean;
  text: string;
}

export function checkResultMessage(check: CheckContextResponse): CheckMessage {
  if (check.compiles) {
    return { blocking: false, text: 'C Repair: context compiles ✓ — scanning.' };
  }
  const missing =
    check.missing_symbols.length > 0 ? check.missing_symbols.join(', ') : '(unknown)';
  return {
    blocking: true,
    text:
      `C Repair: context still missing: ${missing}. ` +
      'Scanning now will leave the compile check skipped.',
  };
}

/** The context-state summary shown on the TreeView root (design §3). */
export type ContextState = 'confirmed' | 'assumption-dependent' | 'none';

/**
 * Classify a confirmed set into the root badge state. `none` when there are no
 * items; `confirmed` when every item is confirmed; otherwise assumption-dependent
 * (at least one unconfirmed item — the §2 semantics).
 */
export function contextStateFor(items: { confirmed: boolean }[]): ContextState {
  if (items.length === 0) return 'none';
  return items.every((i) => i.confirmed) ? 'confirmed' : 'assumption-dependent';
}

/** The human label for the TreeView root context row. */
export function contextStateLabel(state: ContextState, itemCount: number): string {
  switch (state) {
    case 'none':
      return 'context: none';
    case 'confirmed':
      return `context: ${itemCount} item${itemCount === 1 ? '' : 's'} (confirmed)`;
    case 'assumption-dependent':
      return `context: ${itemCount} item${itemCount === 1 ? '' : 's'} (assumption-dependent)`;
  }
}

// --- context completeness (Codex review round) --------------------------------
//
// A scan run while the last /context/check still reported missing symbols
// produces results that LOOK complete but may not be: functions using the
// unresolved symbols were scanned with the compile gate blind to them, so
// violations can go undetected. This axis is INDEPENDENT of the
// confirmed / assumption-dependent state (D-020 / §2): a fully CONFIRMED
// context can still be INCOMPLETE (the reviewer confirmed what was inferred,
// but the check says it is not enough), hence the distinct wording.
//
// `stillMissing` semantics: `undefined` = no /context/check ran before this
// scan (skip / cache / direct paths — nothing is asserted either way);
// `0` = the check passed (context complete); `> 0` = the check's residual
// missing-symbol count at scan time.

/**
 * TreeView context-row suffix for an incomplete context, or `undefined` when
 * nothing should be shown (no check ran, or the context checked complete).
 */
export function contextIncompleteLabel(stillMissing: number | undefined): string | undefined {
  if (stillMissing === undefined || stillMissing <= 0) return undefined;
  return (
    `context incomplete (${stillMissing} symbol${stillMissing === 1 ? '' : 's'} still missing) — ` +
    'findings may be incomplete'
  );
}

/**
 * The scan-completion warning sentence for an incomplete context, or
 * `undefined` when nothing should be appended. Spells out the consequence:
 * detection may have missed violations, so a 0-violation result is not a
 * safety guarantee.
 */
export function scanIncompletenessWarning(stillMissing: number | undefined): string | undefined {
  if (stillMissing === undefined || stillMissing <= 0) return undefined;
  return (
    `Context incomplete (${stillMissing} symbol${stillMissing === 1 ? '' : 's'} still missing) — ` +
    'detection may have missed violations; 0 violations is not a safety guarantee.'
  );
}
