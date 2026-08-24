// Diff view for a repair candidate (VSCODE_V1B_DESIGN.md §5, D-004).
//
// Left  = the scan-time snapshot content (always Original C, D-004).
// Right = applyHunks(snapshot.content, candidate.hunks) (@core), i.e. the
//         proposed Accepted Candidate C for THIS candidate in isolation.
//
// Both sides are served by a single TextDocumentContentProvider under the
// `crepair` scheme, so no temp files touch disk and the diff is read-only. The
// content is keyed by candidate id + side in the URI query; the provider looks
// the candidate up in the live session via a resolver callback.

import * as vscode from 'vscode';
import { applyHunks } from '@c-repair/core';
import type { RepairCandidate } from '@c-repair/contract';
import { candidateBadge, candidateBadgeLabel } from './model';

export const CREPAIR_SCHEME = 'crepair';

/** What the provider needs to render a side: the snapshot text + the candidate. */
export interface DiffSource {
  /** Original C snapshot text (left side, and the base for applyHunks). */
  snapshotContent: string;
  candidate: RepairCandidate;
  /** rule_id of the finding this candidate repairs (for the title), if any. */
  ruleId: string | undefined;
  /** Display filename (for the title). */
  filename: string;
}

/**
 * Resolves a candidate id to its DiffSource against the live session. Returning
 * undefined (candidate gone / session replaced) yields empty content, which is
 * harmless for a read-only diff.
 */
export type DiffResolver = (candidateId: string) => DiffSource | undefined;

/**
 * Resolves a Context Review's left-side key to its content — the comment-stripped
 * Original the LLM sees (D-021). Keyed by a `review` id in the URI so a rescan /
 * new review can re-render. Returns undefined when the review is gone.
 */
export type ReviewLeftResolver = (reviewId: string) => string | undefined;

/**
 * A read-only content provider for the diff sides served from the extension:
 *   - candidate diffs: crepair:<filename>?candidate=<id>&side=<original|proposed>
 *   - Context Review left side: crepair:<filename>?review=<id>&side=original
 * The path segment is cosmetic (VS Code shows it as the editor label); the query
 * carries the real key. The Review's RIGHT side is a separate editable untitled
 * document (not served here), so only its left (read-only, stripped Original) is
 * a virtual doc.
 */
export class CRepairContentProvider implements vscode.TextDocumentContentProvider {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  constructor(
    private readonly resolve: DiffResolver,
    private readonly resolveReviewLeft?: ReviewLeftResolver,
  ) {}

  /** Signal that both sides of `candidateId` may have changed (re-render). */
  invalidate(candidateId: string, filename: string): void {
    this._onDidChange.fire(originalUri(candidateId, filename));
    this._onDidChange.fire(proposedUri(candidateId, filename));
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const params = new URLSearchParams(uri.query);
    // Context Review left side (comment-stripped Original).
    const reviewId = params.get('review');
    if (reviewId !== null) {
      return this.resolveReviewLeft?.(reviewId) ?? '';
    }
    const candidateId = params.get('candidate') ?? '';
    const side = params.get('side');
    const src = this.resolve(candidateId);
    if (!src) return '';
    if (side === 'proposed') {
      return applyHunks(src.snapshotContent, src.candidate.hunks);
    }
    return src.snapshotContent;
  }
}

/**
 * The read-only left side of a Context Review diff: a `crepair`-scheme virtual doc
 * carrying the comment-stripped Original the LLM sees (D-021). The `reviewId` keys
 * it so the provider can resolve current content and re-render on rescan.
 */
export function reviewLeftUri(reviewId: string, filename: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: CREPAIR_SCHEME,
    path: `/${filename} (Original — comments stripped)`,
    query: `review=${encodeURIComponent(reviewId)}&side=original`,
  });
}

function baseUri(candidateId: string, filename: string, side: 'original' | 'proposed'): vscode.Uri {
  // The path is cosmetic but should end in .c so VS Code highlights it as C.
  const label = side === 'original' ? `${filename} (Original)` : `${filename} (C Repair)`;
  return vscode.Uri.from({
    scheme: CREPAIR_SCHEME,
    path: `/${label}`,
    query: `candidate=${encodeURIComponent(candidateId)}&side=${side}`,
  });
}

export function originalUri(candidateId: string, filename: string): vscode.Uri {
  return baseUri(candidateId, filename, 'original');
}

export function proposedUri(candidateId: string, filename: string): vscode.Uri {
  return baseUri(candidateId, filename, 'proposed');
}

/**
 * The candidate id a `crepair`-scheme diff URI refers to, or undefined for a
 * non-candidate URI (a Context Review left side, or any other scheme). Both diff
 * sides carry `candidate=<id>` in their query (baseUri), so the title-bar commands
 * (Accept / Reject / Regenerate / Next — D-024) can recover the candidate from the
 * active editor's URI without a separate URI↔candidate map: the URI *is* the map.
 */
export function candidateIdFromUri(uri: vscode.Uri): string | undefined {
  if (uri.scheme !== CREPAIR_SCHEME) return undefined;
  const params = new URLSearchParams(uri.query);
  // Exclude the Context Review left side (it carries `review`, not `candidate`).
  if (params.get('review') !== null) return undefined;
  const id = params.get('candidate');
  return id ? id : undefined;
}

/** The diff editor title: `<file> ⟷ C Repair: <rule_id> (<badge>)`. */
export function diffTitle(src: DiffSource): string {
  const badge = candidateBadgeLabel(candidateBadge(src.candidate));
  const rule = src.ruleId ? `${src.ruleId} ` : '';
  return `${src.filename} ⟷ C Repair: ${rule}${badge}`;
}

/** Open the native side-by-side diff for a candidate. */
export async function showCandidateDiff(src: DiffSource): Promise<void> {
  const left = originalUri(src.candidate.candidate_id, src.filename);
  const right = proposedUri(src.candidate.candidate_id, src.filename);
  await vscode.commands.executeCommand('vscode.diff', left, right, diffTitle(src), {
    preview: true,
  });
}
