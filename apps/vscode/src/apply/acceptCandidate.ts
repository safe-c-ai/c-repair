// Accept a repair candidate by applying its hunks to the live document via a
// single WorkspaceEdit (VSCODE_V1B_DESIGN.md §5). This file is the thin `vscode`
// adapter; all coordinate math (hunk -> EditRange, offset correction, the Accept
// guard) lives in ui/model.ts and is unit tested under plain Node.
//
// APPROACH: deterministic offset correction (the primary §5 method, not the
// degraded "sequential + rescan" fallback). Each candidate's hunks are Original
// C based (D-004). When several candidates are accepted in one scan, an earlier
// accept shifts the line numbers of later ones; lineOffsetForStart() computes
// that shift deterministically from @core's hunk ranges, so every Accept maps
// cleanly onto the CURRENT document. All accepts in a scan land as one
// WorkspaceEdit each (undo = 1 step per Accept).

import * as vscode from 'vscode';
import type { RepairCandidate } from '@c-repair/contract';
import { candidateToEditRanges, type EditRange } from '../ui/model';
import { dedupeIncludes } from './dedupeIncludes';

/** Turn a pure EditRange into a vscode.TextEdit against `doc`. */
function toTextEdit(doc: vscode.TextDocument, r: EditRange): vscode.TextEdit {
  // Clamp the end position to the document's true end so a hunk that reaches the
  // final line (which may lack a trailing newline) still applies. VS Code
  // validates the range against the document; an over-long endLine is clamped by
  // validateRange, but we build the range defensively.
  const start = new vscode.Position(r.startLine, r.startChar);
  const rawEnd = new vscode.Position(r.endLine, r.endChar);
  const range = doc.validateRange(new vscode.Range(start, rawEnd));
  return vscode.TextEdit.replace(range, r.text);
}

/** The outcome of an Accept apply: whether the WorkspaceEdit landed, plus how many
 * duplicate `#include` lines were skipped (D-026) so the caller can inform the user. */
export interface ApplyResult {
  applied: boolean;
  /** Duplicate `#include` lines dropped before applying (D-026). */
  removedIncludeCount: number;
}

/**
 * Apply `candidate`'s hunks to `doc`, correcting line offsets for
 * `acceptedCandidates` already applied this scan. Returns whether the edit applied,
 * plus the count of duplicate `#include` lines skipped (D-026).
 *
 * D-026: before building the edit, duplicate `#include` insertion lines are dropped
 * against the CURRENT document text (which already reflects any earlier accepts this
 * scan), so a `#include` an earlier candidate already inserted is not inserted again.
 * The offset chain is unaffected: the dedupe only trims pure-insertion hunks (and
 * accepted hunks never carry duplicate includes into `acceptedHunks`, so the offset
 * math over already-applied hunks is unchanged).
 *
 * The whole set of (post-dedupe) hunks lands in ONE WorkspaceEdit so a single undo
 * reverts the accept. The caller is responsible for the Accept guard
 * (evaluateAcceptGuard) and for advancing the session's expected hash afterwards.
 */
export async function applyCandidate(
  doc: vscode.TextDocument,
  candidate: RepairCandidate,
  acceptedCandidates: RepairCandidate[],
): Promise<ApplyResult> {
  const { hunks, removedCount } = dedupeIncludes(candidate.hunks, doc.getText());

  // Nothing left to apply after dropping duplicate includes (the whole diff was a
  // redundant #include already present). Report success with the skip count so the
  // decision still records as accepted and the user is told what happened.
  if (hunks.length === 0) {
    return { applied: true, removedIncludeCount: removedCount };
  }

  const acceptedHunks = acceptedCandidates.flatMap((c) => c.hunks);
  const ranges = candidateToEditRanges({ ...candidate, hunks }, acceptedHunks);

  const edit = new vscode.WorkspaceEdit();
  edit.set(
    doc.uri,
    ranges.map((r) => toTextEdit(doc, r)),
  );
  const applied = await vscode.workspace.applyEdit(edit);
  return { applied, removedIncludeCount: removedCount };
}
