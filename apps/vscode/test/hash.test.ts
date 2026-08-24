// Unit tests for content hashing + stale detection (VSCODE_V1B_DESIGN §7).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { contentHash, isStale } from '../src/session/hash';
import { ScanSession } from '../src/session/ScanSession';
import type {
  FunctionScanResult,
  SourceDocument,
  ContextAugmentationSet,
} from '@c-repair/contract';

const SAMPLE = 'int main(void) { return 0; }\n';

test('contentHash uses sha256: prefix over UTF-8 bytes (CONTRACT.md §1)', () => {
  const expected = 'sha256:' + createHash('sha256').update(SAMPLE, 'utf8').digest('hex');
  assert.equal(contentHash(SAMPLE), expected);
});

test('contentHash does not normalize newlines', () => {
  assert.notEqual(contentHash('a\r\nb'), contentHash('a\nb'));
});

test('isStale: same content is not stale, changed content is stale', () => {
  const h = contentHash(SAMPLE);
  assert.equal(isStale(h, SAMPLE), false);
  assert.equal(isStale(h, SAMPLE + '\n'), true);
});

function emptyScan(): FunctionScanResult {
  return {
    scan_id: 'scan-1',
    source_id: 'src-1',
    original_hash: contentHash(SAMPLE),
    context_revision_id: 'rev-1',
    rule_profile: { id: 'cert-c', version: '1' },
    adapter: { id: 'a', version: '1' },
    harness: { id: 'certfix', version: '0.4.1' },
    functions: [],
  };
}

function source(): SourceDocument {
  return {
    source_id: 'src-1',
    filename: 'a.c',
    language: 'c',
    content: SAMPLE,
    content_hash: contentHash(SAMPLE),
    size_bytes: Buffer.byteLength(SAMPLE, 'utf8'),
    origin: 'vscode_document',
  };
}

function confirmedSet(): ContextAugmentationSet {
  return {
    set_id: 'set-1',
    source_id: 'src-1',
    original_hash: contentHash(SAMPLE),
    status: 'confirmed',
    context_revision_id: 'rev-1',
    prelude_line_count: 0,
    items: [],
  };
}

test('ScanSession.refreshStale toggles only on change and un-stales on revert', () => {
  const snapshot = ScanSession.makeSnapshot('file:///a.c', 'a.c', SAMPLE);
  const session = new ScanSession(snapshot, 'rev-1', emptyScan(), source(), confirmedSet());

  assert.equal(session.stale, false);
  // Same content => no change reported.
  assert.equal(session.refreshStale(SAMPLE), false);
  assert.equal(session.stale, false);

  // Edit => becomes stale, reports a change.
  assert.equal(session.refreshStale(SAMPLE + 'x'), true);
  assert.equal(session.stale, true);
  // Same stale state again => no change.
  assert.equal(session.refreshStale(SAMPLE + 'y'), false);
  assert.equal(session.stale, true);

  // Revert (hash restored) => un-stales, reports a change (D-006 mapping).
  assert.equal(session.refreshStale(SAMPLE), true);
  assert.equal(session.stale, false);
});
