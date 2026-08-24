import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyHunks,
  hunkRange,
  rangesIntersect,
  candidatesConflict,
  synthesizePrelude,
  synthesizedPreludeLineCount,
  composeAugmentedC,
  MARKER_START,
  MARKER_END,
  PRELUDE_NOTE,
} from '../src/index.js';

const h = (start_line, line_count, replacement_text) => ({
  hunk_id: `h-${start_line}`,
  start_line,
  line_count,
  replacement_text,
});

test('applyHunks: single-line replacement', () => {
  const src = 'a\nb\nc';
  assert.equal(applyHunks(src, [h(2, 1, 'B')]), 'a\nB\nc');
});

test('applyHunks: multi-line replacement text on one line', () => {
  const src = 'a\nb\nc';
  assert.equal(applyHunks(src, [h(2, 1, 'x\ny')]), 'a\nx\ny\nc');
});

test('applyHunks: insertion (line_count=0) before start_line', () => {
  const src = 'a\nb\nc';
  assert.equal(applyHunks(src, [h(2, 0, 'NEW')]), 'a\nNEW\nb\nc');
});

test('applyHunks: deletion (empty replacement + line_count>0)', () => {
  const src = 'a\nb\nc';
  assert.equal(applyHunks(src, [h(2, 1, '')]), 'a\nc');
});

test('applyHunks: multiple hunks apply in descending order without offset drift', () => {
  const src = 'l1\nl2\nl3\nl4\nl5';
  // Provide hunks out of order; result must be identical regardless of input order.
  const hunks = [h(2, 1, 'X\nY'), h(4, 1, 'Z')];
  const expected = 'l1\nX\nY\nl3\nZ\nl5';
  assert.equal(applyHunks(src, hunks), expected);
  assert.equal(applyHunks(src, [...hunks].reverse()), expected);
});

test('hunkRange: replacement and insertion', () => {
  assert.deepEqual(hunkRange(h(5, 3, 'x')), { start: 5, end: 7, insert: false });
  assert.deepEqual(hunkRange(h(5, 0, 'x')), { start: 5, end: 5, insert: true });
});

test('rangesIntersect: overlapping and disjoint replacements', () => {
  assert.equal(rangesIntersect(hunkRange(h(1, 3, '')), hunkRange(h(3, 2, ''))), true);
  assert.equal(rangesIntersect(hunkRange(h(1, 2, '')), hunkRange(h(3, 2, ''))), false);
});

test('rangesIntersect: insertion strictly inside a replacement conflicts', () => {
  assert.equal(rangesIntersect(hunkRange(h(4, 0, '')), hunkRange(h(3, 3, ''))), true); // 4 in [3,5]
  assert.equal(rangesIntersect(hunkRange(h(3, 0, '')), hunkRange(h(3, 3, ''))), false); // at boundary
  assert.equal(rangesIntersect(hunkRange(h(3, 0, '')), hunkRange(h(3, 0, ''))), true); // same insert point
});

test('candidatesConflict: matches validator semantics', () => {
  const cA = { hunks: [h(4, 1, ''), h(8, 1, '')] };
  const cB = { hunks: [h(4, 1, ''), h(14, 1, '')] }; // shares line 4
  const cC = { hunks: [h(20, 1, '')] };
  assert.equal(candidatesConflict(cA, cB), true);
  assert.equal(candidatesConflict(cA, cC), false);
});

test('prelude: empty items yields 4-line structure', () => {
  assert.equal(synthesizedPreludeLineCount([]), 4);
  assert.equal(synthesizePrelude([]), `${MARKER_START}\n${PRELUDE_NOTE}\n${MARKER_END}\n`);
});

test('prelude: line count = 4 + item text lines', () => {
  const items = [
    { current_text: 'int f(int);' },
    { current_text: 'typedef enum { A, B } E;' },
  ];
  assert.equal(synthesizedPreludeLineCount(items), 6);
});

test('composeAugmentedC: pure concatenation with blank separator, Original unchanged', () => {
  const original = 'int main(void) { return 0; }\n';
  const out = composeAugmentedC([], original);
  assert.equal(out, `${MARKER_START}\n${PRELUDE_NOTE}\n${MARKER_END}\n\n${original}`);
  // Original C must appear byte-unchanged at the tail.
  assert.ok(out.endsWith(original));
});
