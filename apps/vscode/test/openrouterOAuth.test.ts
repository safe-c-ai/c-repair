// Unit tests for the OpenRouter OAuth PKCE flow (D-027, HEADLESS copy-paste
// mode). Pure Node, no `vscode` module and NO real network / browser: fetch,
// the browser opener and the paste prompt are injected fakes. The one real
// dependency is `node:crypto` (the PKCE primitives).
//
// Load-bearing properties: the generated verifier is RFC 7636-valid; the
// challenge is S256 = base64url(sha256(verifier)); the headless auth URL
// carries the challenge + key_label and — deliberately — NO callback_url; the
// pasted code is trimmed; the exchange payload is the documented
// { code, code_verifier, code_challenge_method } (unchanged by the transport
// rework); cancel / empty / browser / exchange failures each reject with a
// safe OAuthError; and every failure notification offers Retry AND the
// manual-key fallback.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  generateCodeVerifier,
  computeCodeChallenge,
  isValidCodeVerifier,
  buildHeadlessAuthUrl,
  parseExchangedKey,
  exchangeCodeForKey,
  runOAuthFlow,
  oauthFailureNotification,
  validateCodeInput,
  OAuthError,
  KEY_LABEL,
  RETRY_ACTION,
  MANUAL_KEY_ACTION,
  type FetchLike,
  type OAuthDeps,
} from '../src/auth/openrouterOAuth';

// --- PKCE primitives (RFC 7636) --------------------------------------------

test('generateCodeVerifier yields an RFC 7636-valid verifier (43..128 unreserved)', () => {
  for (let i = 0; i < 50; i += 1) {
    const v = generateCodeVerifier();
    assert.ok(isValidCodeVerifier(v), `not RFC 7636-valid: ${v}`);
    assert.ok(v.length >= 43 && v.length <= 128, `length out of range: ${v.length}`);
    assert.doesNotMatch(v, /[+/=]/, 'must be base64url (no +, /, or =)');
  }
});

test('generateCodeVerifier is random (distinct across calls)', () => {
  const a = generateCodeVerifier();
  const b = generateCodeVerifier();
  assert.notEqual(a, b);
});

test('computeCodeChallenge is base64url(sha256(verifier)) — S256', () => {
  const verifier = 'test-verifier-0123456789-abcdefghijklmnopqrstuvwxyz';
  const expected = createHash('sha256')
    .update(verifier, 'ascii')
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  assert.equal(computeCodeChallenge(verifier), expected);
});

test('computeCodeChallenge output is base64url (no padding / + / /)', () => {
  const c = computeCodeChallenge(generateCodeVerifier());
  assert.doesNotMatch(c, /[+/=]/);
  assert.equal(c.length, 43); // sha256 -> 32 bytes -> 43 base64url chars
});

// --- auth URL ---------------------------------------------------------------

test('buildHeadlessAuthUrl: challenge + key_label, and NO callback_url', () => {
  const url = new URL(buildHeadlessAuthUrl('CHAL'));
  assert.equal(url.origin + url.pathname, 'https://openrouter.ai/auth');
  assert.equal(url.searchParams.get('code_challenge'), 'CHAL');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('key_label'), KEY_LABEL);
  // The absence of callback_url is what selects OpenRouter's headless mode
  // (the page displays the code instead of redirecting).
  assert.equal(url.searchParams.get('callback_url'), null);
  // A custom label is honoured.
  assert.equal(new URL(buildHeadlessAuthUrl('C', 'X')).searchParams.get('key_label'), 'X');
});

// --- parseExchangedKey ------------------------------------------------------

test('parseExchangedKey reads a non-empty string key', () => {
  assert.equal(parseExchangedKey({ key: 'sk-or-123' }), 'sk-or-123');
  assert.equal(parseExchangedKey({ key: 'sk-or-123', label: 'x' }), 'sk-or-123');
});

test('parseExchangedKey returns null for missing / empty / wrong-typed key', () => {
  assert.equal(parseExchangedKey({}), null);
  assert.equal(parseExchangedKey({ key: '' }), null);
  assert.equal(parseExchangedKey({ key: 123 }), null);
  assert.equal(parseExchangedKey({ key: null }), null);
  assert.equal(parseExchangedKey(null), null);
  assert.equal(parseExchangedKey('nope'), null);
});

// --- exchangeCodeForKey -----------------------------------------------------

/** A fetch fake recording the request, returning a canned ok/json/text response. */
function fakeFetch(
  response: { ok: boolean; status?: number; json?: () => Promise<unknown>; text?: () => Promise<string> },
  record?: (url: string, init: Record<string, unknown> | undefined) => void,
): FetchLike {
  return async (url, init) => {
    record?.(url, init as Record<string, unknown> | undefined);
    return {
      ok: response.ok,
      status: response.status ?? (response.ok ? 200 : 500),
      json: response.json ?? (async () => ({})),
      text: response.text ?? (async () => ''),
    };
  };
}

test('exchangeCodeForKey POSTs the documented JSON body and returns the key', async () => {
  let seenUrl = '';
  let seenInit: Record<string, unknown> | undefined;
  const key = await exchangeCodeForKey(
    'auth-code-xyz',
    'verifier-abc',
    fakeFetch({ ok: true, json: async () => ({ key: 'sk-or-minted' }) }, (url, init) => {
      seenUrl = url;
      seenInit = init;
    }),
  );
  assert.equal(key, 'sk-or-minted');
  assert.equal(seenUrl, 'https://openrouter.ai/api/v1/auth/keys');
  assert.equal(seenInit?.method, 'POST');
  const headers = seenInit?.headers as Record<string, string>;
  assert.equal(headers['content-type'], 'application/json');
  const body = JSON.parse(seenInit?.body as string) as Record<string, unknown>;
  assert.deepEqual(body, {
    code: 'auth-code-xyz',
    code_verifier: 'verifier-abc',
    code_challenge_method: 'S256',
  });
});

test('exchangeCodeForKey throws exchange_failed on non-2xx (no code/verifier in message)', async () => {
  await assert.rejects(
    () => exchangeCodeForKey('auth-code-xyz', 'verifier-abc', fakeFetch({ ok: false, status: 400 })),
    (err: unknown) => {
      assert.ok(err instanceof OAuthError);
      assert.equal((err as OAuthError).kind, 'exchange_failed');
      assert.doesNotMatch((err as Error).message, /auth-code-xyz|verifier-abc/);
      return true;
    },
  );
});

test('exchangeCodeForKey throws exchange_failed on a malformed body (no key)', async () => {
  await assert.rejects(
    () => exchangeCodeForKey('c', 'v', fakeFetch({ ok: true, json: async () => ({ nope: 1 }) })),
    (err: unknown) => err instanceof OAuthError && (err as OAuthError).kind === 'exchange_failed',
  );
});

test('exchangeCodeForKey throws exchange_failed when fetch rejects (network)', async () => {
  const rejecting: FetchLike = async () => {
    throw new Error('network down');
  };
  await assert.rejects(
    () => exchangeCodeForKey('c', 'v', rejecting),
    (err: unknown) => err instanceof OAuthError && (err as OAuthError).kind === 'exchange_failed',
  );
});

// --- runOAuthFlow (headless paste) -------------------------------------------

/** Build deps whose paste prompt and browser opener the test scripts. */
function depsFor(opts: {
  fetch?: FetchLike;
  onOpen?: (url: string) => void;
  openResult?: boolean;
  code?: string | undefined;
}): OAuthDeps {
  return {
    fetch: opts.fetch ?? fakeFetch({ ok: true, json: async () => ({ key: 'sk-or-flow' }) }),
    openExternal: async (url: string) => {
      opts.onOpen?.(url);
      return opts.openResult ?? true;
    },
    promptForCode: async () => opts.code,
  };
}

test('runOAuthFlow: happy path — headless URL opened, pasted code exchanged, key minted', async () => {
  let openedUrl = '';
  let exchangeBody = '';
  const deps = depsFor({
    onOpen: (url) => {
      openedUrl = url;
    },
    code: 'the-pasted-code',
    fetch: async (_url, init) => {
      exchangeBody = init?.body ?? '';
      return { ok: true, status: 200, json: async () => ({ key: 'sk-or-flow' }), text: async () => '' };
    },
  });
  const key = await runOAuthFlow(deps);
  assert.equal(key, 'sk-or-flow');

  const u = new URL(openedUrl);
  assert.equal(u.origin + u.pathname, 'https://openrouter.ai/auth');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('key_label'), KEY_LABEL);
  assert.equal(u.searchParams.get('callback_url'), null); // headless

  // The exchange payload is EXACTLY the documented triple, with the pasted
  // code and a verifier matching the challenge that was opened.
  const body = JSON.parse(exchangeBody);
  assert.deepEqual(Object.keys(body).sort(), ['code', 'code_challenge_method', 'code_verifier']);
  assert.equal(body.code, 'the-pasted-code');
  assert.equal(body.code_challenge_method, 'S256');
  assert.equal(computeCodeChallenge(body.code_verifier), u.searchParams.get('code_challenge'));
});

test('runOAuthFlow: the pasted code is trimmed before the exchange', async () => {
  let exchangeBody = '';
  const deps = depsFor({
    code: '   padded-code\n',
    fetch: async (_url, init) => {
      exchangeBody = init?.body ?? '';
      return { ok: true, status: 200, json: async () => ({ key: 'k' }), text: async () => '' };
    },
  });
  await runOAuthFlow(deps);
  assert.equal(JSON.parse(exchangeBody).code, 'padded-code');
});

test('runOAuthFlow: a dismissed prompt rejects as cancelled (no exchange)', async () => {
  let exchanged = false;
  const deps = depsFor({
    code: undefined, // user hit Esc
    fetch: async () => {
      exchanged = true;
      return { ok: true, status: 200, json: async () => ({ key: 'k' }), text: async () => '' };
    },
  });
  await assert.rejects(
    runOAuthFlow(deps),
    (err: unknown) => err instanceof OAuthError && (err as OAuthError).kind === 'cancelled',
  );
  assert.equal(exchanged, false);
});

test('runOAuthFlow: whitespace-only input rejects as no_code (defensive)', async () => {
  const deps = depsFor({ code: '   ' });
  await assert.rejects(
    runOAuthFlow(deps),
    (err: unknown) => err instanceof OAuthError && (err as OAuthError).kind === 'no_code',
  );
});

test('runOAuthFlow: a failed browser open is reported (open_browser)', async () => {
  const deps = depsFor({ openResult: false });
  await assert.rejects(
    runOAuthFlow(deps),
    (err: unknown) => err instanceof OAuthError && (err as OAuthError).kind === 'open_browser',
  );
});

test('runOAuthFlow: exchange failure surfaces with the fresh-code hint', async () => {
  const deps = depsFor({ code: 'expired-code', fetch: fakeFetch({ ok: false, status: 403 }) });
  await assert.rejects(runOAuthFlow(deps), (err: unknown) => {
    assert.ok(err instanceof OAuthError);
    assert.equal((err as OAuthError).kind, 'exchange_failed');
    // The expired/rejected-code guidance: retrying mints a fresh code.
    assert.match((err as Error).message, /run Connect again to get a fresh one/);
    assert.doesNotMatch((err as Error).message, /expired-code/);
    return true;
  });
});

// --- prompt validation + failure notifications --------------------------------

test('validateCodeInput rejects empty/whitespace and accepts a code', () => {
  assert.notEqual(validateCodeInput(''), null);
  assert.notEqual(validateCodeInput('   '), null);
  assert.equal(validateCodeInput('some-code'), null);
  assert.equal(validateCodeInput('  some-code  '), null); // trimmed later
});

test('every failure notification offers Retry AND the manual-key fallback', () => {
  for (const err of [
    new OAuthError('The OpenRouter sign-in was cancelled.', 'cancelled'),
    new OAuthError('Could not open the browser for OpenRouter sign-in.', 'open_browser'),
    new OAuthError('OpenRouter did not return an API key.', 'exchange_failed'),
    new OAuthError('No authorization code was entered.', 'no_code'),
    new Error('something unknown'),
  ]) {
    const n = oauthFailureNotification(err);
    assert.deepEqual(n.actions, [RETRY_ACTION, MANUAL_KEY_ACTION]);
    assert.match(n.message, /^C Repair: /);
  }
  // Unknown errors get the generic safe message.
  assert.equal(
    oauthFailureNotification(new Error('boom')).message,
    'C Repair: OpenRouter sign-in failed.',
  );
});
