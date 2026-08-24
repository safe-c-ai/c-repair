// Unit tests for the OpenRouter key-usage helpers (D-025). Pure Node, no `vscode`
// module and — crucially — NO real network: `fetchKeyUsage` takes an injected
// fetch, so every case here uses a fake that records the call and returns a canned
// response. The load-bearing properties: a malformed / unexpected body parses to
// null (feature disables rather than showing a wrong figure), the key travels only
// in the Authorization header, and the delta never goes negative.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseKeyUsage,
  parseIsFreeTier,
  parseKeyInfo,
  usageDelta,
  formatUsd,
  usageTooltipLine,
  shouldQueryUsage,
  fetchKeyUsage,
  fetchKeyInfo,
  type FetchLike,
} from '../src/cost/openrouterUsage';

// --- shouldQueryUsage: showCosts / key gate --------------------------------

test('shouldQueryUsage is true only with showCosts on AND a key present', () => {
  assert.equal(shouldQueryUsage(true, 'sk-test'), true);
});

test('shouldQueryUsage is false when showCosts is off (no query at all)', () => {
  assert.equal(shouldQueryUsage(false, 'sk-test'), false);
});

test('shouldQueryUsage is false with no key even when showCosts is on', () => {
  assert.equal(shouldQueryUsage(true, undefined), false);
  assert.equal(shouldQueryUsage(true, ''), false);
});

// --- parseKeyUsage: shape defence ------------------------------------------

test('parseKeyUsage reads data.usage when a finite non-negative number', () => {
  assert.equal(parseKeyUsage({ data: { usage: 0.1234 } }), 0.1234);
  assert.equal(parseKeyUsage({ data: { usage: 0 } }), 0);
  assert.equal(parseKeyUsage({ data: { usage: 42 } }), 42);
});

test('parseKeyUsage ignores sibling fields and reads only usage', () => {
  assert.equal(
    parseKeyUsage({ data: { label: 'k', usage: 1.5, limit: 100, is_free_tier: false } }),
    1.5,
  );
});

test('parseKeyUsage returns null when data is missing', () => {
  assert.equal(parseKeyUsage({}), null);
  assert.equal(parseKeyUsage({ usage: 1 }), null); // usage at the top level, not under data
});

test('parseKeyUsage returns null when usage is missing', () => {
  assert.equal(parseKeyUsage({ data: {} }), null);
  assert.equal(parseKeyUsage({ data: { label: 'k' } }), null);
});

test('parseKeyUsage returns null when usage is the wrong type', () => {
  assert.equal(parseKeyUsage({ data: { usage: '1.23' } }), null); // string, not number
  assert.equal(parseKeyUsage({ data: { usage: null } }), null);
  assert.equal(parseKeyUsage({ data: { usage: true } }), null);
  assert.equal(parseKeyUsage({ data: { usage: { amount: 1 } } }), null);
});

test('parseKeyUsage returns null for non-finite or negative usage', () => {
  assert.equal(parseKeyUsage({ data: { usage: Number.NaN } }), null);
  assert.equal(parseKeyUsage({ data: { usage: Number.POSITIVE_INFINITY } }), null);
  assert.equal(parseKeyUsage({ data: { usage: -0.01 } }), null);
});

test('parseKeyUsage returns null for non-object bodies', () => {
  assert.equal(parseKeyUsage(null), null);
  assert.equal(parseKeyUsage(undefined), null);
  assert.equal(parseKeyUsage('nope'), null);
  assert.equal(parseKeyUsage(42), null);
  assert.equal(parseKeyUsage({ data: 'string' }), null);
});

// --- parseIsFreeTier: free-tier flag defence (B) ---------------------------

test('parseIsFreeTier reads a boolean is_free_tier (true / false)', () => {
  assert.equal(parseIsFreeTier({ data: { is_free_tier: true } }), true);
  assert.equal(parseIsFreeTier({ data: { is_free_tier: false } }), false);
});

test('parseIsFreeTier returns null when the field is missing (unknown)', () => {
  assert.equal(parseIsFreeTier({ data: {} }), null);
  assert.equal(parseIsFreeTier({ data: { usage: 1 } }), null);
});

test('parseIsFreeTier returns null for a non-boolean field (defensive)', () => {
  assert.equal(parseIsFreeTier({ data: { is_free_tier: 'true' } }), null); // string
  assert.equal(parseIsFreeTier({ data: { is_free_tier: 1 } }), null); // number
  assert.equal(parseIsFreeTier({ data: { is_free_tier: null } }), null);
  assert.equal(parseIsFreeTier({ data: { is_free_tier: {} } }), null);
});

test('parseIsFreeTier returns null for a non-object / dataless body', () => {
  assert.equal(parseIsFreeTier(null), null);
  assert.equal(parseIsFreeTier(undefined), null);
  assert.equal(parseIsFreeTier('nope'), null);
  assert.equal(parseIsFreeTier({}), null);
  assert.equal(parseIsFreeTier({ is_free_tier: true }), null); // at top level, not under data
});

// --- parseKeyInfo: usage + is_free_tier together ---------------------------

test('parseKeyInfo returns both usage and isFreeTier from one body', () => {
  assert.deepEqual(parseKeyInfo({ data: { usage: 1.5, is_free_tier: true } }), {
    usage: 1.5,
    isFreeTier: true,
  });
});

test('parseKeyInfo fields are independent (valid usage, missing flag)', () => {
  assert.deepEqual(parseKeyInfo({ data: { usage: 2 } }), { usage: 2, isFreeTier: null });
  assert.deepEqual(parseKeyInfo({ data: { is_free_tier: false } }), {
    usage: null,
    isFreeTier: false,
  });
});

test('parseKeyInfo returns nulls for a malformed body', () => {
  assert.deepEqual(parseKeyInfo({ unexpected: 'shape' }), { usage: null, isFreeTier: null });
  assert.deepEqual(parseKeyInfo(null), { usage: null, isFreeTier: null });
});

// --- usageDelta: run-cost difference ---------------------------------------

test('usageDelta subtracts before from after', () => {
  const d = usageDelta(1.0, 1.05);
  assert.ok(d !== null && Math.abs(d - 0.05) < 1e-9); // fp noise; formatUsd rounds
  assert.equal(usageDelta(0, 0.25), 0.25);
});

test('usageDelta returns 0 for an unchanged reading (legitimate: sub-cent / cached)', () => {
  assert.equal(usageDelta(2.5, 2.5), 0);
});

test('usageDelta returns null when either reading is unavailable', () => {
  assert.equal(usageDelta(null, 1), null);
  assert.equal(usageDelta(1, null), null);
  assert.equal(usageDelta(null, null), null);
});

test('usageDelta returns null for a negative delta (stale / racing reading)', () => {
  assert.equal(usageDelta(2.0, 1.5), null);
});

// --- formatUsd / usageTooltipLine ------------------------------------------

test('formatUsd renders four decimals with a dollar sign', () => {
  assert.equal(formatUsd(0), '$0.0000');
  assert.equal(formatUsd(1.23456), '$1.2346');
  assert.equal(formatUsd(0.05), '$0.0500');
});

test('usageTooltipLine includes the total and the approximate caveat', () => {
  const line = usageTooltipLine(0.5);
  assert.ok(line);
  assert.match(line!, /OpenRouter usage: \$0\.5000 \(total for this key\)/);
  assert.match(line!, /approximate; includes any other use of this key/);
});

test('usageTooltipLine returns undefined when usage is unavailable', () => {
  assert.equal(usageTooltipLine(null), undefined);
});

// --- fetchKeyUsage: DI fake, no real network -------------------------------

/** A fetch fake that records the request and returns a canned ok/json response. */
function fakeFetch(
  response: { ok: boolean; status?: number; json: () => Promise<unknown> },
  record?: (url: string, init: Record<string, unknown> | undefined) => void,
): FetchLike {
  return async (url, init) => {
    record?.(url, init as Record<string, unknown> | undefined);
    return { ok: response.ok, status: response.status ?? (response.ok ? 200 : 500), json: response.json };
  };
}

test('fetchKeyUsage returns the parsed usage on a 200 with a valid body', async () => {
  const usage = await fetchKeyUsage(
    'sk-test',
    fakeFetch({ ok: true, json: async () => ({ data: { usage: 3.14 } }) }),
  );
  assert.equal(usage, 3.14);
});

test('fetchKeyUsage sends the key ONLY in the Authorization header (never logged elsewhere)', async () => {
  let seenUrl = '';
  let seenInit: Record<string, unknown> | undefined;
  await fetchKeyUsage(
    'sk-secret',
    fakeFetch({ ok: true, json: async () => ({ data: { usage: 1 } }) }, (url, init) => {
      seenUrl = url;
      seenInit = init;
    }),
  );
  assert.equal(seenUrl, 'https://openrouter.ai/api/v1/key');
  assert.equal(seenInit?.method, 'GET');
  const headers = seenInit?.headers as Record<string, string>;
  assert.equal(headers.authorization, 'Bearer sk-secret');
  // The URL carries no key material.
  assert.doesNotMatch(seenUrl, /sk-secret/);
});

test('fetchKeyUsage returns null on a non-2xx response', async () => {
  const usage = await fetchKeyUsage(
    'sk-test',
    fakeFetch({ ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) }),
  );
  assert.equal(usage, null);
});

test('fetchKeyUsage returns null when the body is malformed (unexpected shape)', async () => {
  const usage = await fetchKeyUsage(
    'sk-test',
    fakeFetch({ ok: true, json: async () => ({ unexpected: 'shape' }) }),
  );
  assert.equal(usage, null);
});

test('fetchKeyUsage returns null when json() throws (parse error)', async () => {
  const badJson: FetchLike = async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new Error('not JSON');
    },
  });
  assert.equal(await fetchKeyUsage('sk-test', badJson), null);
});

test('fetchKeyUsage returns null when fetch rejects (network failure)', async () => {
  const rejecting: FetchLike = async () => {
    throw new Error('network down');
  };
  assert.equal(await fetchKeyUsage('sk-test', rejecting), null);
});

test('fetchKeyUsage returns null with no key (never queries)', async () => {
  let called = false;
  const spy: FetchLike = async () => {
    called = true;
    return { ok: true, status: 200, json: async () => ({ data: { usage: 1 } }) };
  };
  assert.equal(await fetchKeyUsage('', spy), null);
  assert.equal(called, false, 'no fetch is made without a key');
});

// --- fetchKeyInfo: usage + is_free_tier over the same DI fake (B) -----------

test('fetchKeyInfo returns usage + isFreeTier on a 200 with a valid body', async () => {
  const info = await fetchKeyInfo(
    'sk-test',
    fakeFetch({ ok: true, json: async () => ({ data: { usage: 0, is_free_tier: true } }) }),
  );
  assert.deepEqual(info, { usage: 0, isFreeTier: true });
});

test('fetchKeyInfo returns nulls on a non-2xx response', async () => {
  const info = await fetchKeyInfo(
    'sk-test',
    fakeFetch({ ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) }),
  );
  assert.deepEqual(info, { usage: null, isFreeTier: null });
});

test('fetchKeyInfo returns nulls when fetch rejects (network failure)', async () => {
  const rejecting: FetchLike = async () => {
    throw new Error('network down');
  };
  assert.deepEqual(await fetchKeyInfo('sk-test', rejecting), {
    usage: null,
    isFreeTier: null,
  });
});

test('fetchKeyInfo returns nulls with no key (never queries)', async () => {
  let called = false;
  const spy: FetchLike = async () => {
    called = true;
    return { ok: true, status: 200, json: async () => ({ data: { usage: 1 } }) };
  };
  assert.deepEqual(await fetchKeyInfo('', spy), { usage: null, isFreeTier: null });
  assert.equal(called, false, 'no fetch is made without a key');
});

test('fetchKeyInfo sends the key ONLY in the Authorization header', async () => {
  let seenUrl = '';
  let seenInit: Record<string, unknown> | undefined;
  await fetchKeyInfo(
    'sk-secret',
    fakeFetch({ ok: true, json: async () => ({ data: { usage: 1, is_free_tier: false } }) }, (url, init) => {
      seenUrl = url;
      seenInit = init;
    }),
  );
  assert.equal(seenUrl, 'https://openrouter.ai/api/v1/key');
  const headers = seenInit?.headers as Record<string, string>;
  assert.equal(headers.authorization, 'Bearer sk-secret');
  assert.doesNotMatch(seenUrl, /sk-secret/);
});
