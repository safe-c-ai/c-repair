// Unit tests for the pure Context Review document generation + parsing (D-021).
// Pure Node, no `vscode` module. Load-bearing:
//   - the generated doc is the WHOLE Augmented C: markers + note (from @core) +
//     item delimiters + the comment-stripped Original — consistent with
//     composeAugmentedC (marker / note / code section byte-match);
//   - the round trip (items -> doc -> items) is identity when unedited and the code
//     section validates;
//   - editing a declaration flips user_edited + provenance;
//   - editing the code section fails with the code-edit reason;
//   - breaking a delimiter / the marker line fails with a reason.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildReviewDoc, parseReviewDoc } from '../src/session/contextReviewDoc';
import { stripCommentsPreserveLines } from '../src/session/stripComments';
import {
  MARKER_START,
  MARKER_END,
  PRELUDE_NOTE,
  composeAugmentedC,
} from '@c-repair/core';
import type { ContextAugmentationItem } from '@c-repair/contract';

function item(overrides: Partial<ContextAugmentationItem> = {}): ContextAugmentationItem {
  return {
    item_id: 'aug-1',
    kind: 'external_function_declaration',
    generated_text: 'int read_sensor(int channel);',
    current_text: 'int read_sensor(int channel);',
    provenance: 'llm_inferred',
    user_edited: false,
    confirmed: false,
    rationale: 'inferred from usage at line 21',
    usage_evidence: [{ line: 21, snippet: 'int v = read_sensor(0);' }],
    ...overrides,
  };
}

const TWO_ITEMS: ContextAugmentationItem[] = [
  item({ item_id: 'aug-1' }),
  item({
    item_id: 'aug-2',
    kind: 'external_global',
    generated_text: 'extern int threshold;',
    current_text: 'extern int threshold;',
  }),
];

// A realistic Original with comments (line + block, plus a string that contains
// comment-looking text that must be preserved).
const ORIGINAL = [
  '#include <stddef.h> // for size_t',
  '/* a block',
  '   comment */',
  'int over_threshold(void) {',
  '    const char *s = "not // a comment";',
  '    int v = read_sensor(0); // read it',
  '    return v > threshold;',
  '}',
  '',
].join('\n');

const STRIPPED = stripCommentsPreserveLines(ORIGINAL);

// --- generation -------------------------------------------------------------

test('buildReviewDoc emits markers + note (from @core) and one delimiter per item', () => {
  const text = buildReviewDoc(TWO_ITEMS, ORIGINAL);
  assert.ok(text.startsWith(MARKER_START), 'starts with the marker-start line');
  assert.ok(text.includes('\n' + PRELUDE_NOTE + '\n'), 'has the @core provisional note');
  assert.ok(text.includes('\n' + MARKER_END + '\n'), 'has the marker-end line');
  assert.match(text, /\/\* --- item aug-1 \[external_function_declaration\] \(llm_inferred\) --- \*\//);
  assert.match(text, /\/\* --- item aug-2 \[external_global\] \(llm_inferred\) --- \*\//);
  assert.match(text, /int read_sensor\(int channel\);/);
  assert.match(text, /extern int threshold;/);
});

test('buildReviewDoc code section is the comment-stripped Original, byte-for-byte', () => {
  const text = buildReviewDoc(TWO_ITEMS, ORIGINAL);
  const sep = '\n' + MARKER_END + '\n';
  const code = text.slice(text.indexOf(sep) + sep.length);
  // composeAugmentedC puts a blank separator line then the (stripped) Original.
  const expected = composeAugmentedC(TWO_ITEMS, STRIPPED).slice(
    composeAugmentedC(TWO_ITEMS, STRIPPED).indexOf(sep) + sep.length,
  );
  assert.equal(code, expected);
  // And the code section contains no comments (blanked) — the `// read it` is gone.
  assert.ok(!code.includes('// read it'), 'line comment stripped from the code section');
  assert.ok(!code.includes('/* a block'), 'block comment stripped from the code section');
  // The string literal's inner // is preserved.
  assert.ok(code.includes('"not // a comment"'), 'string-literal // preserved');
});

test('buildReviewDoc marker/note lines match @core exactly (consistency)', () => {
  const text = buildReviewDoc(TWO_ITEMS, ORIGINAL);
  const lines = text.split('\n');
  assert.equal(lines[0], MARKER_START);
  assert.equal(lines[1], PRELUDE_NOTE);
});

test('buildReviewDoc handles a multi-line current_text verbatim', () => {
  const multi = [
    item({
      item_id: 'aug-t',
      kind: 'inferred_type',
      generated_text: 'typedef struct {\n    int x;\n} VehicleState;',
      current_text: 'typedef struct {\n    int x;\n} VehicleState;',
    }),
  ];
  const text = buildReviewDoc(multi, ORIGINAL);
  assert.match(text, /typedef struct \{\n {4}int x;\n\} VehicleState;/);
});

test('buildReviewDoc with an empty item list still has both markers (no delimiters)', () => {
  const text = buildReviewDoc([], ORIGINAL);
  assert.ok(text.startsWith(MARKER_START));
  assert.ok(text.includes('\n' + MARKER_END + '\n'));
  const hasDelimiterLine = text
    .split('\n')
    .some((l) => /^\/\*\s*---\s*item\s+\S+\b.*---\s*\*\/\s*$/.test(l));
  assert.equal(hasDelimiterLine, false);
});

// --- round trip / parsing ---------------------------------------------------

test('round trip with no edits is identity on current_text and flags', () => {
  const doc = buildReviewDoc(TWO_ITEMS, ORIGINAL);
  const res = parseReviewDoc(doc, TWO_ITEMS, ORIGINAL);
  assert.ok(res.ok);
  assert.equal(res.items.length, 2);
  assert.equal(res.items[0].current_text, 'int read_sensor(int channel);');
  assert.equal(res.items[0].user_edited, false);
  assert.equal(res.items[0].provenance, 'llm_inferred');
  assert.equal(res.items[1].current_text, 'extern int threshold;');
});

test('an edited declaration body sets user_edited and provenance=user_corrected', () => {
  const doc = buildReviewDoc(TWO_ITEMS, ORIGINAL).replace(
    'int read_sensor(int channel);',
    'long read_sensor(int channel);',
  );
  const res = parseReviewDoc(doc, TWO_ITEMS, ORIGINAL);
  assert.ok(res.ok);
  assert.equal(res.items[0].current_text, 'long read_sensor(int channel);');
  assert.equal(res.items[0].user_edited, true);
  assert.equal(res.items[0].provenance, 'user_corrected');
  assert.equal(res.items[1].user_edited, false);
  assert.equal(res.items[1].provenance, 'llm_inferred');
});

test('editing a body back to generated_text does NOT mark it edited', () => {
  const drafts = [item({ current_text: 'STALE', generated_text: 'int read_sensor(int channel);' })];
  const doc = buildReviewDoc(drafts, ORIGINAL).replace('STALE', 'int read_sensor(int channel);');
  const res = parseReviewDoc(doc, drafts, ORIGINAL);
  assert.ok(res.ok);
  assert.equal(res.items[0].current_text, 'int read_sensor(int channel);');
  assert.equal(res.items[0].user_edited, false);
  assert.equal(res.items[0].provenance, 'llm_inferred');
});

test('a multi-line edited declaration is captured with its blank-edge trimmed', () => {
  const doc = buildReviewDoc(TWO_ITEMS, ORIGINAL).replace(
    'int read_sensor(int channel);',
    'int read_sensor(int channel);\nint helper(void);',
  );
  const res = parseReviewDoc(doc, TWO_ITEMS, ORIGINAL);
  assert.ok(res.ok);
  assert.equal(res.items[0].current_text, 'int read_sensor(int channel);\nint helper(void);');
  assert.equal(res.items[0].user_edited, true);
});

test('parse ignores the display kind/provenance in a delimiter (id is the key)', () => {
  const doc = buildReviewDoc(TWO_ITEMS, ORIGINAL).replace(
    '[external_function_declaration] (llm_inferred)',
    '[whatever] (edited)',
  );
  const res = parseReviewDoc(doc, TWO_ITEMS, ORIGINAL);
  assert.ok(res.ok);
  assert.equal(res.items[0].current_text, 'int read_sensor(int channel);');
});

// --- code section is protected ----------------------------------------------

test('editing the Original code section fails with the code-edit reason', () => {
  const doc = buildReviewDoc(TWO_ITEMS, ORIGINAL).replace(
    'int over_threshold(void) {',
    'int over_threshold(int tampered) {',
  );
  const res = parseReviewDoc(doc, TWO_ITEMS, ORIGINAL);
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.reason, /code section must not be edited/i);
});

test('deleting a code line (byte mismatch) fails with the code-edit reason', () => {
  const doc = buildReviewDoc(TWO_ITEMS, ORIGINAL).replace('    return v > threshold;\n', '');
  const res = parseReviewDoc(doc, TWO_ITEMS, ORIGINAL);
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.reason, /code section must not be edited/i);
});

test('a broken marker-end line fails (byte check is the safety net)', () => {
  const doc = buildReviewDoc(TWO_ITEMS, ORIGINAL).replace(MARKER_END, '/* wrong marker */');
  const res = parseReviewDoc(doc, TWO_ITEMS, ORIGINAL);
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.reason, /marker/i);
});

// --- broken delimiter structure -> failure with a reason --------------------

test('a document with no delimiters (but valid code) fails on the prelude', () => {
  // Build a valid doc, then strip out all item delimiters + bodies from the prelude.
  const doc = buildReviewDoc(TWO_ITEMS, ORIGINAL);
  const sep = '\n' + MARKER_END + '\n';
  const codeTail = doc.slice(doc.indexOf(sep));
  const brokenPrelude = [MARKER_START, PRELUDE_NOTE].join('\n');
  const res = parseReviewDoc(brokenPrelude + codeTail, TWO_ITEMS, ORIGINAL);
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.reason, /item 区切りが壊れています/);
});

test('a deleted delimiter (missing item) fails', () => {
  const doc = buildReviewDoc([TWO_ITEMS[0]], ORIGINAL);
  const res = parseReviewDoc(doc, TWO_ITEMS, ORIGINAL);
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.reason, /aug-2/);
});

test('an unknown item id fails', () => {
  const doc = buildReviewDoc(TWO_ITEMS, ORIGINAL).replace('item aug-2', 'item aug-99');
  const res = parseReviewDoc(doc, TWO_ITEMS, ORIGINAL);
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.reason, /aug-99/);
});

test('a duplicated item id fails', () => {
  const doc = buildReviewDoc([TWO_ITEMS[0], TWO_ITEMS[0]], ORIGINAL);
  const res = parseReviewDoc(doc, TWO_ITEMS, ORIGINAL);
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.reason, /重複|aug-1/);
});

test('an empty declaration body fails', () => {
  const doc = buildReviewDoc(TWO_ITEMS, ORIGINAL).replace('int read_sensor(int channel);', '   ');
  const res = parseReviewDoc(doc, TWO_ITEMS, ORIGINAL);
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.reason, /aug-1/);
});

test('parse keeps the original draft order regardless of section order in the doc', () => {
  const doc = buildReviewDoc([TWO_ITEMS[1], TWO_ITEMS[0]], ORIGINAL);
  const res = parseReviewDoc(doc, TWO_ITEMS, ORIGINAL);
  assert.ok(res.ok);
  assert.equal(res.items[0].item_id, 'aug-1');
  assert.equal(res.items[1].item_id, 'aug-2');
});
