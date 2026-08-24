// OpenRouter OAuth PKCE key issuance (D-027, HEADLESS copy-paste flow).
//
// Mints a BYOK API key without the user creating one by hand: generate a
// code_verifier + S256 code_challenge, open the browser at OpenRouter's /auth
// page in HEADLESS mode (no callback_url + a key_label), let the user approve —
// OpenRouter then DISPLAYS the authorization code on the page — and paste it
// into a VS Code InputBox; finally exchange it at /api/v1/auth/keys for the key.
//
// WHY headless: both callback transports failed on real machines. The loopback
// server needed asExternalUri port forwarding (fragile under WSL/Remote), and a
// custom-scheme `vscode://` callback is not documented as supported by
// OpenRouter (observed not to redirect). Headless mode is OpenRouter's OFFICIAL
// answer for environments where an HTTP callback cannot work: one manual paste,
// but it always works — and the first-run experience failing is the worst case
// (user policy), so "always works" wins over "zero clicks".
//
// Spec (https://openrouter.ai/docs/use-cases/oauth-pkce, headless mode):
//   - auth URL:  https://openrouter.ai/auth
//       ?code_challenge=<base64url(sha256(code_verifier))>
//       &code_challenge_method=S256          (the challenge is REQUIRED)
//       &key_label=<display label>           (NO callback_url)
//     After approval the page shows the authorization code for the user to copy.
//     The code is single-use and expires after 10 minutes.
//   - exchange:  POST https://openrouter.ai/api/v1/auth/keys
//       Content-Type: application/json
//       { "code": <code>, "code_verifier": <verifier>, "code_challenge_method": "S256" }
//     — identical to the callback flows; the transport change does not touch it.
//
// SECURITY: the code_verifier, the pasted authorization code, and the minted
// key are NEVER logged and never placed on a command line. The seams (fetch,
// browser opener, the paste prompt) are injectable so unit tests run the whole
// flow offline. This module does not touch SecretStorage or `vscode` — the
// caller shows the real InputBox and stores the returned key.

import { randomBytes, createHash } from 'node:crypto';

const AUTH_URL = 'https://openrouter.ai/auth';
const KEY_EXCHANGE_URL = 'https://openrouter.ai/api/v1/auth/keys';

/** The label OpenRouter attaches to the minted key (shown on the dashboard). */
export const KEY_LABEL = 'C Repair (VS Code)';

// --- InputBox copy (exported so the prompt seam and its tests agree) ----------

/** InputBox prompt: what to paste and how long the code lives. */
export const CODE_PROMPT =
  'Approve access in the browser, then paste the code OpenRouter shows you (valid for 10 minutes).';

/** InputBox placeholder: what the pasted value looks like. */
export const CODE_PLACEHOLDER = 'Authorization code from the OpenRouter page';

/**
 * InputBox validation (VS Code convention: null = valid, string = error shown
 * inline). Whitespace-only input is rejected before the user can submit it.
 */
export function validateCodeInput(value: string): string | null {
  return value.trim().length > 0 ? null : 'Paste the authorization code (it cannot be empty).';
}

/**
 * A `fetch`-shaped function for the key exchange. Injected so unit tests supply a
 * fake and never touch the network; production passes the global `fetch`.
 */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

/**
 * Opens a URL in the user's browser. Injected so tests can assert the auth URL
 * without launching a browser; production wraps `vscode.env.openExternal`.
 */
export type OpenExternal = (url: string) => Promise<boolean>;

/** Everything the OAuth flow needs; all seams injectable for offline tests. */
export interface OAuthDeps {
  fetch: FetchLike;
  openExternal: OpenExternal;
  /**
   * Show the paste prompt and resolve with the raw input, or undefined when the
   * user dismissed it. Production wraps `vscode.window.showInputBox` with
   * `ignoreFocusOut: true` (switching to the browser must not close it) and
   * `validateCodeInput`; tests resolve directly.
   */
  promptForCode: () => Promise<string | undefined>;
}

/** A user-facing OAuth failure with a safe message (no code / verifier / key). */
export class OAuthError extends Error {
  constructor(
    message: string,
    readonly kind: 'no_code' | 'exchange_failed' | 'open_browser' | 'cancelled',
  ) {
    super(message);
    this.name = 'OAuthError';
  }
}

// --- failure-notification copy (never a dead end) -----------------------------

/** Notification action: run the OAuth flow again (mints a FRESH code). */
export const RETRY_ACTION = 'Retry';

/** Notification action: fall back to pasting a key manually. */
export const MANUAL_KEY_ACTION = 'Set API Key manually';

/**
 * The error-notification copy for ANY OAuth failure (cancel / browser /
 * exchange / unknown): the message is user-safe, and the actions ALWAYS offer
 * both a retry and the manual-key fallback so the first-run path is never a
 * dead end. Pure so the button set is unit tested.
 */
export function oauthFailureNotification(err: unknown): { message: string; actions: string[] } {
  const detail = err instanceof OAuthError ? err.message : 'OpenRouter sign-in failed.';
  return { message: `C Repair: ${detail}`, actions: [RETRY_ACTION, MANUAL_KEY_ACTION] };
}

// --- PKCE primitives --------------------------------------------------------

/**
 * RFC 7636 unreserved character set for a code_verifier:
 * ALPHA / DIGIT / "-" / "." / "_" / "~". We draw 96 random bytes and base64url
 * them (no padding), yielding 128 unreserved chars — inside the required 43..128.
 */
export function generateCodeVerifier(): string {
  // 96 bytes -> 128 base64url chars (well within RFC 7636's 43..128 range).
  return base64UrlEncode(randomBytes(96));
}

/** S256 challenge: base64url(sha256(verifier)) per RFC 7636 / OpenRouter docs. */
export function computeCodeChallenge(verifier: string): string {
  return base64UrlEncode(createHash('sha256').update(verifier, 'ascii').digest());
}

/** base64url without padding (RFC 4648 §5): + -> -, / -> _, strip `=`. */
function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * RFC 7636 code_verifier validity: 43..128 chars, all from the unreserved set.
 * Exported for the unit tests (the generator must always satisfy it).
 */
export function isValidCodeVerifier(v: string): boolean {
  return /^[A-Za-z0-9\-._~]{43,128}$/.test(v);
}

/**
 * Build the OpenRouter /auth URL in HEADLESS mode: the required S256 challenge
 * plus a key_label, and — deliberately — NO callback_url, which is what makes
 * OpenRouter display the code on the page instead of redirecting. Pure.
 */
export function buildHeadlessAuthUrl(codeChallenge: string, keyLabel: string = KEY_LABEL): string {
  const u = new URL(AUTH_URL);
  u.searchParams.set('code_challenge', codeChallenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('key_label', keyLabel);
  return u.toString();
}

// --- key exchange -----------------------------------------------------------

/**
 * Parse the minted key out of the /api/v1/auth/keys response body. The documented
 * shape is `{ key: "<api-key>", ... }`. Returns the string when present and
 * non-empty; null otherwise (so the caller reports an exchange failure rather than
 * storing junk). Pure and never logs — the body is not echoed anywhere.
 */
export function parseExchangedKey(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const key = (body as { key?: unknown }).key;
  if (typeof key !== 'string' || key.length === 0) return null;
  return key;
}

/**
 * Exchange the authorization `code` for an API key at /api/v1/auth/keys. Sends the
 * documented JSON body { code, code_verifier, code_challenge_method: 'S256' } —
 * identical across the callback and headless flows. Throws
 * OAuthError('exchange_failed') on a non-2xx (with the fresh-code hint: pasted
 * codes are single-use and expire in 10 minutes), a malformed body, or a network
 * error — WITHOUT including the code / verifier in the message.
 */
export async function exchangeCodeForKey(
  code: string,
  codeVerifier: string,
  fetchImpl: FetchLike,
): Promise<string> {
  let resp: Awaited<ReturnType<FetchLike>>;
  try {
    resp = await fetchImpl(KEY_EXCHANGE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code,
        code_verifier: codeVerifier,
        code_challenge_method: 'S256',
      }),
    });
  } catch {
    // Network / abort: no detail leaks (the message could otherwise echo the URL
    // with the code, though we never put it there — stay conservative).
    throw new OAuthError('Could not reach OpenRouter to exchange the sign-in code.', 'exchange_failed');
  }
  if (!resp.ok) {
    // A rejected code is most often expired or already used (single-use,
    // 10-minute lifetime) — running Connect again shows a fresh one.
    throw new OAuthError(
      `OpenRouter rejected the sign-in code (HTTP ${resp.status}). Codes are ` +
        'single-use and expire after 10 minutes — run Connect again to get a fresh one.',
      'exchange_failed',
    );
  }
  let body: unknown;
  try {
    body = await resp.json();
  } catch {
    throw new OAuthError('OpenRouter returned an unexpected response to the key exchange.', 'exchange_failed');
  }
  const key = parseExchangedKey(body);
  if (!key) {
    throw new OAuthError('OpenRouter did not return an API key.', 'exchange_failed');
  }
  return key;
}

// --- the flow ---------------------------------------------------------------

/**
 * Run the headless OpenRouter OAuth PKCE flow and return the minted API key.
 *
 * Steps (D-027 headless): generate verifier + S256 challenge -> open the
 * browser at OpenRouter /auth (challenge + key_label, no callback_url) -> the
 * user approves and OpenRouter shows the code -> the user pastes it into the
 * prompt -> exchange it for a key -> return the key. The caller stores it in
 * SecretStorage. No CSRF state is needed: nothing redirects back to us — the
 * code arrives by the user's own paste.
 *
 * On any failure throws an OAuthError with a user-safe message; the code,
 * verifier and key never appear in an error or a log.
 */
export async function runOAuthFlow(deps: OAuthDeps): Promise<string> {
  const verifier = generateCodeVerifier();
  const challenge = computeCodeChallenge(verifier);

  const opened = await deps.openExternal(buildHeadlessAuthUrl(challenge));
  if (!opened) {
    throw new OAuthError('Could not open the browser for OpenRouter sign-in.', 'open_browser');
  }

  const raw = await deps.promptForCode();
  if (raw === undefined) {
    throw new OAuthError('The OpenRouter sign-in was cancelled.', 'cancelled');
  }
  const code = raw.trim();
  if (!code) {
    // Defensive: the InputBox validation rejects empty input, but the seam
    // contract does not guarantee it.
    throw new OAuthError('No authorization code was entered.', 'no_code');
  }

  return exchangeCodeForKey(code, verifier, deps.fetch);
}
