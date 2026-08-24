// Unit tests for the confirmed-context cache key + store logic (V2b, design §3).
// Pure Node with a fake Memento. Load-bearing: the key namespaces the
// content_hash so a source change (different hash) misses; only confirmed sets are
// stored; eviction removes the entry.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  contextCacheKey,
  getCachedContext,
  setCachedContext,
  evictCachedContext,
  type ContextCacheStore,
} from '../src/session/contextCache';
import type { ContextAugmentationSet } from '@c-repair/contract';

/** A tiny in-memory Memento matching the ContextCacheStore surface. */
function fakeStore(): ContextCacheStore & { raw: Map<string, unknown> } {
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
  };
}

const HASH_A = 'sha256:' + 'a'.repeat(64);
const HASH_B = 'sha256:' + 'b'.repeat(64);

function set(overrides: Partial<ContextAugmentationSet> = {}): ContextAugmentationSet {
  return {
    set_id: 'augset-1',
    source_id: 'src-1',
    original_hash: HASH_A,
    status: 'confirmed',
    context_revision_id: 'ctxrev-1',
    prelude_line_count: 4,
    items: [],
    ...overrides,
  };
}

test('the cache key namespaces the content_hash', () => {
  assert.equal(contextCacheKey(HASH_A), 'crepair.contextCache.' + HASH_A);
  assert.notEqual(contextCacheKey(HASH_A), contextCacheKey(HASH_B));
});

test('a confirmed set stored under a hash round-trips', async () => {
  const store = fakeStore();
  const s = set();
  await setCachedContext(store, HASH_A, s);
  assert.deepEqual(getCachedContext(store, HASH_A), s);
});

test('a different content_hash misses (D-006 source change)', async () => {
  const store = fakeStore();
  await setCachedContext(store, HASH_A, set());
  assert.equal(getCachedContext(store, HASH_B), undefined);
});

test('a draft (unconfirmed) set is NOT cached', async () => {
  const store = fakeStore();
  await setCachedContext(store, HASH_A, set({ status: 'draft', context_revision_id: null }));
  assert.equal(getCachedContext(store, HASH_A), undefined);
});

test('eviction removes the entry (forces a re-infer)', async () => {
  const store = fakeStore();
  await setCachedContext(store, HASH_A, set());
  await evictCachedContext(store, HASH_A);
  assert.equal(getCachedContext(store, HASH_A), undefined);
});

test('a miss on an empty store returns undefined', () => {
  assert.equal(getCachedContext(fakeStore(), HASH_A), undefined);
});
