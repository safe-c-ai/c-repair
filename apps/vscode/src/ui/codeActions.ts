// Quick Fix provider for C Repair diagnostics (V1c-UX task 8). On a C Repair
// violation diagnostic, Ctrl+. offers "C Repair: Generate repair for <rule_id>",
// which runs the same generateRepair flow as the TreeView inline action (via the
// crepair.generateRepairForFinding command).
//
// The diagnostic itself carries only source / code (rule_id) / range, not the
// finding_id, so we resolve the finding off the live session by matching the
// diagnostic's start line to a violation finding's location. Pure aside from the
// vscode API surface; the session is read through an injected accessor so this
// stays decoupled from extension.ts module state.

import * as vscode from 'vscode';
import type { Finding } from '@c-repair/contract';
import type { ScanSession } from '../session/ScanSession';

const SOURCE = 'C Repair';

export class CRepairCodeActionProvider implements vscode.CodeActionProvider {
  static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

  constructor(private readonly getSession: () => ScanSession | undefined) {}

  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    const session = this.getSession();
    if (!session) return [];
    // Only act on the document that was scanned, and only while results are fresh.
    if (document.uri.toString() !== session.snapshot.uri || session.stale) return [];

    const actions: vscode.CodeAction[] = [];
    for (const diag of context.diagnostics) {
      if (diag.source !== SOURCE) continue;
      const finding = findViolationForDiagnostic(session, diag);
      if (!finding) continue;
      // Skip when a candidate already exists (a second generate is a no-op in V1b).
      if (session.candidateForFinding(finding.finding_id)) continue;

      const title = `C Repair: Generate repair for ${finding.rule_id ?? 'finding'}`;
      const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
      action.diagnostics = [diag];
      action.command = {
        command: 'crepair.generateRepairForFinding',
        title,
        arguments: [finding.finding_id],
      };
      actions.push(action);
    }
    return actions;
  }
}

/**
 * Resolve the violation finding a C Repair diagnostic represents. The diagnostic
 * range is a 0-indexed whole-line span converted from the finding's 1-indexed
 * location; match on the start line (and rule_id when the diagnostic carries a
 * code) against the session's violation findings.
 */
function findViolationForDiagnostic(
  session: ScanSession,
  diag: vscode.Diagnostic,
): Finding | undefined {
  const startLine1 = diag.range.start.line + 1; // 0-indexed -> 1-indexed
  const code =
    typeof diag.code === 'string' || typeof diag.code === 'number' ? String(diag.code) : undefined;
  for (const fn of session.scanResult.functions) {
    for (const f of fn.findings) {
      if (f.kind !== 'violation') continue;
      if (f.location.start_line !== startLine1) continue;
      if (code !== undefined && f.rule_id !== undefined && f.rule_id !== code) continue;
      return f;
    }
  }
  return undefined;
}
