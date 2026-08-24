// Unit tests for Reset Extension State's key coverage (Reset Extension State).
// Load-bearing: RESET_GLOBAL_STATE_KEYS must list EVERY globalState one-time flag
// C Repair persists, or a reset would silently leave a flag behind and the user's
// onboarding would not fully re-run. These tests enforce that exhaustiveness so a
// future flag addition that forgets the array fails CI.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  EXTERNAL_NOTICE_SHOWN_KEY,
  FREE_MODEL_NOTICE_SHOWN_KEY,
  MODEL_MODE_CHOSEN_KEY,
  WALKTHROUGH_SHOWN_KEY,
  RESET_GLOBAL_STATE_KEYS,
  shouldOpenWalkthrough,
} from '../src/session/resetState';
import {
  KEY_PREFIX,
  contextCacheKeys,
  clearAllCachedContext,
  setCachedContext,
  getCachedContext,
  type ContextCacheStore,
  type ContextCacheKeyStore,
} from '../src/session/contextCache';
import type { ContextAugmentationSet } from '@c-repair/contract';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(__dirname, '..', 'src');

test('RESET_GLOBAL_STATE_KEYS lists all named flag constants', () => {
  assert.ok(RESET_GLOBAL_STATE_KEYS.includes(EXTERNAL_NOTICE_SHOWN_KEY));
  assert.ok(RESET_GLOBAL_STATE_KEYS.includes(FREE_MODEL_NOTICE_SHOWN_KEY));
  // D-031: the model-mode selection flag must reset too, so the trial-free prompt
  // re-appears after a Reset Extension State.
  assert.ok(RESET_GLOBAL_STATE_KEYS.includes(MODEL_MODE_CHOSEN_KEY));
  // V3c: the walkthrough auto-open flag resets too (onboarding re-runs whole).
  assert.ok(RESET_GLOBAL_STATE_KEYS.includes(WALKTHROUGH_SHOWN_KEY));
});

// --- first-activation walkthrough (V3c) --------------------------------------

test('shouldOpenWalkthrough: opens only while the one-time flag is unset', () => {
  // First activation: flag never recorded -> open.
  assert.equal(shouldOpenWalkthrough(() => undefined), true);
  // Recorded -> never auto-open again.
  assert.equal(
    shouldOpenWalkthrough((k) => (k === WALKTHROUGH_SHOWN_KEY ? true : undefined)),
    false,
  );
  // After Reset Extension State the key is deleted -> opens again.
  assert.equal(shouldOpenWalkthrough(() => undefined), true);
});

test('the reset key list has no duplicates', () => {
  assert.equal(RESET_GLOBAL_STATE_KEYS.length, new Set(RESET_GLOBAL_STATE_KEYS).size);
});

// Exhaustiveness by exported constant: EVERY `*_KEY` flag constant exported from
// resetState.ts must appear in RESET_GLOBAL_STATE_KEYS. This catches a new flag
// (like MODEL_MODE_CHOSEN_KEY) whose name does not match the `*Acknowledged`
// literal scan below but that a reset must still clear.
test('every exported *_KEY flag constant is covered by the reset list', () => {
  const text = readFileSync(join(SRC_DIR, 'session', 'resetState.ts'), 'utf8');
  // Match `export const XXX_KEY = 'crepair.yyy';` and collect the string literal.
  const flagValues = new Set<string>();
  for (const m of text.matchAll(/export const [A-Z0-9_]+_KEY\s*=\s*'(crepair\.[^']+)'/g)) {
    flagValues.add(m[1]);
  }
  assert.ok(flagValues.size >= 3, `expected >=3 flag constants, saw ${[...flagValues]}`);
  for (const value of flagValues) {
    assert.ok(
      RESET_GLOBAL_STATE_KEYS.includes(value),
      `flag '${value}' is not in RESET_GLOBAL_STATE_KEYS — a reset would leave it behind`,
    );
  }
});

// Exhaustiveness guard: any `crepair.*Acknowledged` (the one-time globalState flag
// naming convention) literal appearing anywhere under src/ MUST be in the reset
// list. A new flag that skips the list (and so would survive a reset) fails here.
test('every crepair.*Acknowledged flag in the source is covered by the reset list', () => {
  const files = ['session/resetState.ts', 'extension.ts'];
  const found = new Set<string>();
  for (const rel of files) {
    const text = readFileSync(join(SRC_DIR, rel), 'utf8');
    for (const m of text.matchAll(/'(crepair\.[A-Za-z0-9.]*Acknowledged)'/g)) {
      found.add(m[1]);
    }
  }
  assert.ok(found.size >= 2, `expected to find the Acknowledged flags, saw ${[...found]}`);
  for (const key of found) {
    assert.ok(
      RESET_GLOBAL_STATE_KEYS.includes(key),
      `flag ${key} is not in RESET_GLOBAL_STATE_KEYS — a reset would leave it behind`,
    );
  }
});

test('extension.ts imports the flag constants from resetState (no drifting literals)', () => {
  const ext = readFileSync(join(SRC_DIR, 'extension.ts'), 'utf8');
  // The flag write sites must use the imported constants, so the array and the
  // writes cannot diverge. The constants are only DEFINED in resetState.ts.
  assert.match(ext, /EXTERNAL_NOTICE_SHOWN_KEY/);
  assert.match(ext, /FREE_MODEL_NOTICE_SHOWN_KEY/);
  assert.match(ext, /MODEL_MODE_CHOSEN_KEY/);
  assert.match(ext, /RESET_GLOBAL_STATE_KEYS/);
  // And extension.ts must NOT redefine them as its own string literals.
  assert.doesNotMatch(ext, /const\s+EXTERNAL_NOTICE_SHOWN_KEY\s*=/);
  assert.doesNotMatch(ext, /const\s+FREE_MODEL_NOTICE_SHOWN_KEY\s*=/);
  assert.doesNotMatch(ext, /const\s+MODEL_MODE_CHOSEN_KEY\s*=/);
});

// --- context-cache mass eviction (workspaceState side of the reset) ---------

/** A fake Memento supporting get/update AND keys() (the reset needs enumeration). */
function fakeStore(): ContextCacheStore & ContextCacheKeyStore & { raw: Map<string, unknown> } {
  const raw = new Map<string, unknown>();
  return {
    raw,
    get<T>(key: string): T | undefined {
      return raw.has(key) ? (raw.get(key) as T) : undefined;
    },
    update(key: string, value: unknown): Thenable<void> {
      if (value === undefined) raw.delete(key);
      else raw.set(key, value);
      return Promise.resolve();
    },
    keys(): readonly string[] {
      return [...raw.keys()];
    },
  };
}

function confirmedSet(hash: string): ContextAugmentationSet {
  return {
    set_id: 'augset-' + hash,
    source_id: 'src-1',
    original_hash: hash,
    status: 'confirmed',
    context_revision_id: 'ctxrev-1',
    prelude_line_count: 0,
    items: [],
  };
}

const HASH_A = 'sha256:' + 'a'.repeat(64);
const HASH_B = 'sha256:' + 'b'.repeat(64);

test('contextCacheKeys returns only the prefixed cache keys', async () => {
  const store = fakeStore();
  await setCachedContext(store, HASH_A, confirmedSet(HASH_A));
  await setCachedContext(store, HASH_B, confirmedSet(HASH_B));
  // An unrelated key must not be swept.
  await store.update('crepair.somethingElse', 'keep-me');

  const keys = contextCacheKeys(store);
  assert.equal(keys.length, 2);
  assert.ok(keys.every((k) => k.startsWith(KEY_PREFIX)));
});

test('clearAllCachedContext evicts every cached set but leaves unrelated keys', async () => {
  const store = fakeStore();
  await setCachedContext(store, HASH_A, confirmedSet(HASH_A));
  await setCachedContext(store, HASH_B, confirmedSet(HASH_B));
  await store.update('crepair.somethingElse', 'keep-me');

  await clearAllCachedContext(store);

  assert.equal(getCachedContext(store, HASH_A), undefined);
  assert.equal(getCachedContext(store, HASH_B), undefined);
  assert.equal(contextCacheKeys(store).length, 0);
  // The unrelated key survives (reset only touches the context cache).
  assert.equal(store.get('crepair.somethingElse'), 'keep-me');
});

test('clearAllCachedContext on an empty store is a no-op', async () => {
  const store = fakeStore();
  await clearAllCachedContext(store);
  assert.equal(contextCacheKeys(store).length, 0);
});
