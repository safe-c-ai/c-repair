// A single Output channel "C Repair" for diagnostics. This is the ONLY place the
// extension writes operational logs.
//
// SECURITY (VSCODE_V1B_DESIGN §2/§3): never write the Bearer token, the API key,
// or source content here. Callers pass content hashes and counts only.

import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

export function initLog(context: vscode.ExtensionContext): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('C Repair');
    context.subscriptions.push(channel);
  }
  return channel;
}

function ts(): string {
  return new Date().toISOString();
}

export function logInfo(message: string): void {
  channel?.appendLine(`[${ts()}] ${message}`);
}

export function logWarn(message: string): void {
  channel?.appendLine(`[${ts()}] WARN: ${message}`);
}

export function logError(message: string): void {
  channel?.appendLine(`[${ts()}] ERROR: ${message}`);
}

/**
 * Append a raw multi-line block verbatim (no timestamp prefix), used to surface
 * the full text of a value a caller wants to read in full (e.g. a validation
 * detail that is too long for the tree row). Still content-safe: callers pass
 * only harness diagnostics, never source / secrets.
 */
export function logBlock(text: string): void {
  channel?.appendLine(text);
}

/** Reveal the "C Repair" Output channel (does not steal editor focus). */
export function logShow(): void {
  channel?.show(true);
}
