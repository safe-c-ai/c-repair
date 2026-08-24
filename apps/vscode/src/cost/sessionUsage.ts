// Session token/cost line for the C Repair TreeView header (D-030). Pure helpers —
// no `vscode`, no I/O — so the formatting and the poll-decision logic are unit
// testable without a running host. The extension polls GET /usage while a scan /
// repair runs and renders `formatSessionUsage(...)` into `treeView.message`.

import { formatUsd } from './openrouterUsage';

/** The token totals the bridge meters (BridgeClient.UsageResponse subset). */
export interface SessionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  reasoning_tokens: number;
  requests: number;
}

/**
 * Format a token count in compact "k" notation with one decimal (D-030):
 *   0 -> "0", 512 -> "512", 1234 -> "1.2k", 18234 -> "18.2k".
 * Counts below 1000 are shown verbatim (no decimal); at / above 1000 they are
 * divided by 1000 and rounded to one decimal. Negative / non-finite inputs are
 * treated as 0 (defensive — the bridge only ever sends non-negative integers).
 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(Math.round(n));
  return `${(n / 1000).toFixed(1)}k`;
}

/**
 * Build the session line shown above the TreeView (D-030), e.g.:
 *   "Session: 18.2k in / 5.1k out (reasoning 2.1k) · ≈$0.0134"
 * The reasoning segment is omitted when there are zero reasoning tokens (detection
 * runs reasoning-off, D-029, so a scan-only session has none). The cost segment is
 * appended only when `costUsd` is a finite number (>= 0); when it is null / undefined
 * (cost display off, or the key-usage query failed) the line is tokens only.
 */
export function formatSessionUsage(
  usage: SessionUsage,
  costUsd?: number | null,
): string {
  const inTok = formatTokens(usage.prompt_tokens);
  const outTok = formatTokens(usage.completion_tokens);
  let line = `Session: ${inTok} in / ${outTok} out`;
  if (usage.reasoning_tokens > 0) {
    line += ` (reasoning ${formatTokens(usage.reasoning_tokens)})`;
  }
  if (costUsd !== null && costUsd !== undefined && Number.isFinite(costUsd) && costUsd >= 0) {
    line += ` · ≈${formatUsd(costUsd)}`;
  }
  return line;
}

/**
 * The TreeView `message` string for the current session, or undefined to show none
 * (D-030). Returns undefined when there is no usage reading (the metering query
 * failed / the bridge is too old — "tracker disabled" -> no display). A valid
 * reading always renders, even at zero tokens, so the line appears as soon as a scan
 * begins and updates as tokens accrue.
 */
export function sessionUsageMessage(
  usage: SessionUsage | null | undefined,
  costUsd?: number | null,
): string | undefined {
  if (!usage) return undefined;
  return formatSessionUsage(usage, costUsd);
}

/**
 * Whether the session-usage poll should keep running (D-030). Polling runs ONLY
 * while a bridge operation is in flight (scan / auto-repair pipeline / manual
 * generate / regenerate); when the operation count drops to zero the poll stops and
 * the last value stays pinned until the next scan resets it. Kept pure so the
 * start/stop decision is unit-testable.
 */
export function shouldPollUsage(inFlightOperations: number): boolean {
  return inFlightOperations > 0;
}
