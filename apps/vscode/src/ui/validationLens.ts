// Validation CodeLens for the candidate diff's RIGHT pane (user feedback: the
// reason a validation failed must be visible at the moment of judgment — the diff
// — not only in the left tree where it is clipped). We surface the candidate's
// validation results as CodeLenses on the first line of the applied-after virtual
// doc (proposedUri).
//
// IMPORTANT (禁止事項): this does NOT change the virtual document's text — a
// CodeLens is layered above the buffer, so the diff itself stays a faithful
// "what will be applied" (and the byte-identical diff tests are untouched). Only
// the crepair `proposed` (right) side is decorated; the left `original` side and
// the Context Review `review=` left side are excluded.
//
// The title derivation is a pure function (buildValidationLensTitles, in model.ts
// so it stays vscode-free and unit tested); this file is the thin vscode.* adapter.

import * as vscode from 'vscode';
import type { RepairCandidate } from '@c-repair/contract';
import { CREPAIR_SCHEME } from './diffView';
import { buildValidationLensTitles } from './model';

/**
 * Resolves a candidate id (from a crepair diff URI) to the candidate off the live
 * session. Returns undefined when the session is gone / the candidate no longer
 * exists, in which case no lens is produced (the diff is still a valid read-only
 * view, just without the overlay).
 */
export type CandidateResolver = (candidateId: string) => RepairCandidate | undefined;

/**
 * The candidate id a crepair `proposed` (right) diff URI refers to, or undefined
 * for any other URI: the `original` (left) side, the Context Review `review=` left
 * side, or a non-crepair scheme. We decorate ONLY the applied-after right pane —
 * that is where the reviewer's eyes land to judge the fix — so the left "Original"
 * side is deliberately excluded even though it also carries `candidate=`.
 */
export function proposedCandidateIdFromUri(uri: vscode.Uri): string | undefined {
  if (uri.scheme !== CREPAIR_SCHEME) return undefined;
  const params = new URLSearchParams(uri.query);
  if (params.get('review') !== null) return undefined; // Context Review left side
  if (params.get('side') !== 'proposed') return undefined; // only the right pane
  const id = params.get('candidate');
  return id ? id : undefined;
}

/**
 * CodeLensProvider for the candidate diff's right pane (VS Code calls it per
 * crepair-scheme document). Emits one lens per validation concern (fail / skipped)
 * or a single all-pass summary, all anchored to line 0. Each concern lens invokes
 * `crepair.showValidationDetail` (the existing Output-channel full-text dump) with
 * the gate as its argument, so the lens is also the entry to the untruncated text.
 */
export class ValidationLensProvider implements vscode.CodeLensProvider {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChange.event;

  constructor(private readonly resolve: CandidateResolver) {}

  /** Re-request lenses (a scan / regenerate replaced the candidate). */
  refresh(): void {
    this._onDidChange.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const candidateId = proposedCandidateIdFromUri(document.uri);
    if (candidateId === undefined) return [];
    const candidate = this.resolve(candidateId);
    if (!candidate) return [];

    const range = new vscode.Range(0, 0, 0, 0);
    return buildValidationLensTitles(candidate).map(
      (item) =>
        new vscode.CodeLens(range, {
          title: item.title,
          command: item.validation ? 'crepair.showValidationDetail' : '',
          arguments: item.validation
            ? [
                {
                  candidateId,
                  name: item.validation.name,
                  status: item.validation.status,
                  detail: item.validation.detail ?? '',
                },
              ]
            : undefined,
        }),
    );
  }
}
