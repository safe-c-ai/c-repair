// Content hashing + stale detection for a scan snapshot. Uses node:crypto (no
// `vscode` module) so the stale-hash logic is unit testable under plain Node
// (VSCODE_V1B_DESIGN.md §3 / §7). Hash format follows CONTRACT.md §1:
// `sha256:` prefix + lowercase hex over the raw UTF-8 bytes (no normalization).

import { createHash } from 'node:crypto';

/** `sha256:<hex>` over the UTF-8 bytes of `content` (CONTRACT.md §1). */
export function contentHash(content: string): string {
  const hex = createHash('sha256').update(content, 'utf8').digest('hex');
  return `sha256:${hex}`;
}

/**
 * A scan snapshot is stale when the document's current content no longer hashes
 * to the snapshot hash. Revert restores the hash, so this un-stales on revert
 * (D-006 mapping is hash-based, not edit-count based).
 */
export function isStale(snapshotHash: string, currentContent: string): boolean {
  return contentHash(currentContent) !== snapshotHash;
}
