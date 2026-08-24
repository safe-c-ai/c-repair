// Thin adapter from the pure DiagnosticDescriptor model (ui/model.ts) onto a
// vscode.DiagnosticCollection (VSCODE_V1B_DESIGN.md §4). All value derivation
// lives in model.ts; this file only touches the `vscode` API.

import * as vscode from 'vscode';
import type { FunctionScanResult } from '@c-repair/contract';
import { findingToDiagnostic, STALE_RESULTS_MESSAGE, type DiagnosticDescriptor } from './model';

const COLLECTION_NAME = 'C Repair';

export function createDiagnostics(): vscode.DiagnosticCollection {
  return vscode.languages.createDiagnosticCollection(COLLECTION_NAME);
}

function toSeverity(d: DiagnosticDescriptor): vscode.DiagnosticSeverity {
  return d.severity === 'warning'
    ? vscode.DiagnosticSeverity.Warning
    : vscode.DiagnosticSeverity.Information;
}

function toRange(d: DiagnosticDescriptor): vscode.Range {
  return new vscode.Range(
    new vscode.Position(d.range.startLine, d.range.startChar),
    // Number.MAX_SAFE_INTEGER exceeds VS Code's max; use a large but safe int.
    new vscode.Position(d.range.endLine, Math.min(d.range.endChar, 1_000_000)),
  );
}

function toDiagnostic(d: DiagnosticDescriptor): vscode.Diagnostic {
  const diag = new vscode.Diagnostic(toRange(d), d.message, toSeverity(d));
  diag.source = d.source;
  if (d.code !== undefined) diag.code = d.code;
  return diag;
}

/** Render all findings of a scan result onto the collection for `uri`. */
export function setScanDiagnostics(
  collection: vscode.DiagnosticCollection,
  uri: vscode.Uri,
  scan: FunctionScanResult,
): void {
  const diagnostics: vscode.Diagnostic[] = [];
  for (const fn of scan.functions) {
    for (const finding of fn.findings) {
      diagnostics.push(toDiagnostic(findingToDiagnostic(finding)));
    }
  }
  collection.set(uri, diagnostics);
}

/**
 * Replace all diagnostics for `uri` with a single "results are stale" notice
 * (VSCODE_V1B_DESIGN.md §3/§4). Placed at the top of the file.
 */
export function setStaleDiagnostic(
  collection: vscode.DiagnosticCollection,
  uri: vscode.Uri,
): void {
  const range = new vscode.Range(0, 0, 0, 0);
  const diag = new vscode.Diagnostic(
    range,
    `C Repair results are stale. ${STALE_RESULTS_MESSAGE}`,
    vscode.DiagnosticSeverity.Information,
  );
  diag.source = COLLECTION_NAME;
  collection.set(uri, [diag]);
}

export function clearDiagnostics(
  collection: vscode.DiagnosticCollection,
  uri: vscode.Uri,
): void {
  collection.delete(uri);
}
