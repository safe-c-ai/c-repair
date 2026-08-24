// Confirmed-context cache (V2b, design §3). Persists a confirmed
// ContextAugmentationSet keyed by the source content_hash so a re-scan of an
// UNCHANGED file skips both /context/infer and the Review UI and goes straight to
// scan with the cached set. A source edit changes the content_hash and naturally
// misses (D-006: a context/source change discards downstream state); the "Edit
// Context" command evicts the entry to force a fresh infer + Review.
//
// The storage itself (vscode.Memento / workspaceState) is injected as a tiny
// Store interface so the key/serialisation logic stays unit testable without the
// `vscode` module. Only the confirmed set is cached — a draft (unconfirmed) set is
// never stored, so the cache exclusively holds user-reviewed or explicitly-skipped
// decisions that survive a window reload.

import type { ContextAugmentationSet } from '@c-repair/contract';

/** The minimal Memento surface we use (get/update). vscode.Memento satisfies it. */
export interface ContextCacheStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

/** workspaceState key prefix; the content_hash is appended (design §3). */
export const KEY_PREFIX = 'crepair.contextCache.';

/**
 * Every context-cache key currently held in `store` (Reset Extension State). The
 * cache is keyed by `KEY_PREFIX + content_hash`, so a re-scan can accumulate one
 * entry per file scanned in the workspace; reset removes them all. Returns the
 * subset of the Memento's keys under the cache prefix.
 */
export function contextCacheKeys(store: ContextCacheKeyStore): string[] {
  return store.keys().filter((k) => k.startsWith(KEY_PREFIX));
}

/** The Memento surface used to enumerate cache keys for eviction. */
export interface ContextCacheKeyStore {
  keys(): readonly string[];
}

/** Evict every cached context set in `store` (Reset Extension State). */
export async function clearAllCachedContext(
  store: ContextCacheStore & ContextCacheKeyStore,
): Promise<void> {
  for (const key of contextCacheKeys(store)) {
    await store.update(key, undefined);
  }
}

/**
 * The cache key for a source content_hash. The hash is already a `sha256:<hex>`
 * string (contentHash()); we namespace it under a stable prefix so unrelated
 * workspaceState keys never collide. Source change → different hash → different
 * key → miss (D-006).
 */
export function contextCacheKey(contentHash: string): string {
  return KEY_PREFIX + contentHash;
}

/** Look up a cached confirmed set for a content_hash, or undefined on miss. */
export function getCachedContext(
  store: ContextCacheStore,
  contentHash: string,
): ContextAugmentationSet | undefined {
  return store.get<ContextAugmentationSet>(contextCacheKey(contentHash));
}

/**
 * Store a confirmed set under its source content_hash. No-op (does NOT cache) when
 * the set is not confirmed, so only reviewed/skipped decisions are persisted.
 */
export function setCachedContext(
  store: ContextCacheStore,
  contentHash: string,
  set: ContextAugmentationSet,
): Thenable<void> {
  if (set.status !== 'confirmed') return Promise.resolve();
  return store.update(contextCacheKey(contentHash), set);
}

/** Evict the cached set for a content_hash (Edit Context / eviction). */
export function evictCachedContext(
  store: ContextCacheStore,
  contentHash: string,
): Thenable<void> {
  return store.update(contextCacheKey(contentHash), undefined);
}
