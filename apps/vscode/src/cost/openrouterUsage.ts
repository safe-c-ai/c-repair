// OpenRouter key-usage lookup (D-025). Queries GET
// https://openrouter.ai/api/v1/key with the BYOK key (Authorization: Bearer) and
// returns the cumulative USD `usage` for that key. Used to show approximate spend
// in the status-bar tooltip and the Scan & Fix completion notice.
//
// SECURITY: the API key is sent ONLY in the Authorization header — never logged,
// never persisted. The raw response is NEVER logged (it could echo account data);
// only the parsed number (or null) leaves this module. On ANY failure — network,
// timeout, non-2xx, malformed / unexpected shape — we return null and the feature
// silently disables (defensive parse per D-025).

const USAGE_URL = 'https://openrouter.ai/api/v1/key';
const USAGE_TIMEOUT_MS = 10_000;

/**
 * A `fetch`-shaped function. Injected so unit tests can supply a fake and never
 * touch the network; production passes the global `fetch`.
 */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/**
 * Parse the cumulative USD usage out of an OpenRouter `GET /key` body. The
 * documented shape is `{ data: { usage: <number>, ... } }` where `usage` is the
 * total USD spent on the key. Returns the number when present and well-typed
 * (finite, >= 0); returns null for any other shape so the caller disables the
 * feature rather than showing a wrong figure. This function is pure and never
 * logs — the body is not echoed anywhere.
 */
export function parseKeyUsage(body: unknown): number | null {
  if (!body || typeof body !== 'object') return null;
  const data = (body as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return null;
  const usage = (data as { usage?: unknown }).usage;
  if (typeof usage !== 'number' || !Number.isFinite(usage) || usage < 0) return null;
  return usage;
}

/**
 * The parsed, well-typed subset of an OpenRouter `GET /key` body the extension
 * uses: the cumulative USD `usage` and the `is_free_tier` flag (B, free-model
 * auto-run). Both fields are defensively null when absent / mistyped so the caller
 * never acts on a wrong value.
 */
export interface KeyInfo {
  /** Cumulative USD spent on the key, or null when absent / mistyped. */
  usage: number | null;
  /**
   * Whether the key is on OpenRouter's free tier (no credits): true / false when
   * the response carries a boolean `is_free_tier`, else null (field absent or the
   * wrong type). null means "unknown" — the caller must NOT switch to the free
   * model on null (only an explicit `true` triggers the switch).
   */
  isFreeTier: boolean | null;
}

/**
 * Parse `is_free_tier` out of an OpenRouter `GET /key` body's `data` object.
 * Returns the boolean only when the field is present AND a real boolean; any
 * other shape (missing, string "false", number, null, non-object body) yields
 * null so the caller treats it as "unknown" and does not switch to the free
 * model. Pure; never logs the body.
 */
export function parseIsFreeTier(body: unknown): boolean | null {
  if (!body || typeof body !== 'object') return null;
  const data = (body as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return null;
  const flag = (data as { is_free_tier?: unknown }).is_free_tier;
  return typeof flag === 'boolean' ? flag : null;
}

/**
 * Parse both fields the extension needs from a `GET /key` body in one pass:
 * `usage` (parseKeyUsage) and `is_free_tier` (parseIsFreeTier). Each is defensive
 * and independent — a body may carry a valid usage but no free-tier flag, or vice
 * versa. Pure; never logs.
 */
export function parseKeyInfo(body: unknown): KeyInfo {
  return { usage: parseKeyUsage(body), isFreeTier: parseIsFreeTier(body) };
}

/**
 * Whether a usage query should run at all (D-025). It runs only when the user has
 * left `crepair.showCosts` on AND a BYOK key is present. When `showCosts` is off we
 * must NOT contact the usage endpoint at all — the key never leaves local storage.
 * Kept pure (no `vscode`) so the gate is unit-testable without a running host.
 */
export function shouldQueryUsage(showCosts: boolean, apiKey: string | undefined): boolean {
  return showCosts && !!apiKey && apiKey.length > 0;
}

/**
 * Fetch the full key info (`usage` + `is_free_tier`) for `apiKey` from OpenRouter.
 * On any failure (no key / network / timeout / non-2xx / malformed body) returns
 * `{ usage: null, isFreeTier: null }` so both features disable silently rather than
 * acting on a wrong value. Times out at 10s. The key travels only in the
 * Authorization header; neither it nor the raw response is logged. `fetchImpl`
 * defaults to the global fetch (injected in tests).
 */
export async function fetchKeyInfo(
  apiKey: string,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
): Promise<KeyInfo> {
  if (!apiKey) return { usage: null, isFreeTier: null };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), USAGE_TIMEOUT_MS);
  try {
    const resp = await fetchImpl(USAGE_URL, {
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (!resp.ok) return { usage: null, isFreeTier: null };
    const body = await resp.json();
    return parseKeyInfo(body);
  } catch {
    // Network failure, abort (timeout), or a JSON parse error: disable silently.
    return { usage: null, isFreeTier: null };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch the cumulative USD usage for `apiKey` from OpenRouter, or null on any
 * failure (network / timeout / non-2xx / malformed body). A thin wrapper over
 * `fetchKeyInfo` that keeps the existing cost-display call sites unchanged. The
 * key travels only in the Authorization header; neither it nor the raw response
 * is logged. `fetchImpl` defaults to the global fetch (injected in tests).
 */
export async function fetchKeyUsage(
  apiKey: string,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
): Promise<number | null> {
  return (await fetchKeyInfo(apiKey, fetchImpl)).usage;
}

/**
 * The approximate cost of a run, as the difference between the usage reading
 * taken AFTER the run and the one taken BEFORE it. Returns null when either
 * reading is unavailable (so the caller omits the figure) or when the delta is
 * negative (a stale/racing reading — never show a negative cost). A zero delta is
 * a legitimate result (sub-cent rounding or a cached read) and is returned as 0.
 */
export function usageDelta(before: number | null, after: number | null): number | null {
  if (before === null || after === null) return null;
  const delta = after - before;
  return delta >= 0 ? delta : null;
}

/** Format a USD figure for the status-bar tooltip / notices, e.g. "$0.0123". */
export function formatUsd(amount: number): string {
  return `$${amount.toFixed(4)}`;
}

/**
 * The one-line tooltip suffix shown under the status bar's state (D-025):
 * the cumulative usage plus the required "approximate" caveat. Returns
 * undefined when usage is unavailable, so the caller appends nothing.
 */
export function usageTooltipLine(usage: number | null): string | undefined {
  if (usage === null) return undefined;
  return (
    `OpenRouter usage: ${formatUsd(usage)} (total for this key)\n` +
    `approximate; includes any other use of this key`
  );
}
