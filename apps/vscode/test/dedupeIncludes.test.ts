// Unit tests for the D-026 duplicate-#include filter (apply/dedupeIncludes.ts):
// a pure (VS Code independent) function that, given a candidate's hunks and the
// current document text, drops #include insertion lines already present in the
// document. Runs immediately before the Accept WorkspaceEdit is built.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dedupeIncludes } from '../src/apply/dedupeIncludes';
import type { Hunk } from '@c-repair/contract';

/** A pure insertion hunk (line_count === 0) with the given replacement text. */
function insert(replacement_text: string, start_line = 1, hunk_id = 'h-ins'): Hunk {
  return { hunk_id, start_line, line_count: 0, replacement_text };
}

/** A replacement hunk (line_count > 0). */
function replace(replacement_text: string, line_count = 1, start_line = 5): Hunk {
  return { hunk_id: 'h-repl', start_line, line_count, replacement_text };
}

const DOC = ['#include <stddef.h>', '#include <string.h>', '', 'int main(void) { return 0; }'].join(
  '\n',
);

test('removes an insertion #include line already present in the document', () => {
  const { hunks, removedCount } = dedupeIncludes([insert('#include <string.h>')], DOC);
  assert.equal(removedCount, 1);
  // The whole hunk was a single duplicate include -> hunk dropped entirely.
  assert.equal(hunks.length, 0);
});

test('keeps an insertion #include not present in the document', () => {
  const { hunks, removedCount } = dedupeIncludes([insert('#include <stdint.h>')], DOC);
  assert.equal(removedCount, 0);
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].replacement_text, '#include <stdint.h>');
});

test('mixed include+code hunk: drops only the duplicate include line, keeps the rest', () => {
  const h = insert('#include <string.h>\n#include <stdint.h>\nstatic int helper(void);');
  const { hunks, removedCount } = dedupeIncludes([h], DOC);
  assert.equal(removedCount, 1, 'only the duplicate <string.h> is removed');
  assert.equal(hunks.length, 1);
  assert.equal(
    hunks[0].replacement_text,
    '#include <stdint.h>\nstatic int helper(void);',
    'the non-duplicate include and the code line survive in order',
  );
});

test('drops the hunk when every line is a duplicate include', () => {
  const h = insert('#include <stddef.h>\n#include <string.h>');
  const { hunks, removedCount } = dedupeIncludes([h], DOC);
  assert.equal(removedCount, 2);
  assert.equal(hunks.length, 0);
});

test('drops the hunk when only blank lines remain after removing duplicates', () => {
  // A duplicate include plus a trailing blank line -> nothing meaningful remains.
  const h = insert('#include <string.h>\n');
  const { hunks, removedCount } = dedupeIncludes([h], DOC);
  assert.equal(removedCount, 1);
  assert.equal(hunks.length, 0, 'a hunk with only blank lines left is dropped');
});

test('replacement hunks are never touched, even if they contain a duplicate include', () => {
  const r = replace('#include <string.h>\nint x = raw * 1000;', 1);
  const { hunks, removedCount } = dedupeIncludes([r], DOC);
  assert.equal(removedCount, 0, 'replacement hunks are out of scope for D-026');
  assert.equal(hunks.length, 1);
  assert.deepEqual(hunks[0], r);
});

test('non-#include lines are never removed even if they match a document line', () => {
  const h = insert('int main(void) { return 0; }\n#include <stdint.h>');
  const { hunks, removedCount } = dedupeIncludes([h], DOC);
  assert.equal(removedCount, 0, 'the matching code line is not an #include -> left alone');
  assert.equal(hunks[0].replacement_text, 'int main(void) { return 0; }\n#include <stdint.h>');
});

test('whitespace differences (leading indent / trailing space) match via trim', () => {
  // Document line has no indent; the inserted line has leading + trailing whitespace.
  const h = insert('    #include <string.h>   ');
  const { hunks, removedCount } = dedupeIncludes([h], DOC);
  assert.equal(removedCount, 1, 'trim-exact comparison treats the whitespace variants as equal');
  assert.equal(hunks.length, 0);
});

test('matches an indented document #include against a non-indented inserted one', () => {
  const doc = ['    #include <stdint.h>', 'int main(void) {}'].join('\n');
  const { hunks, removedCount } = dedupeIncludes([insert('#include <stdint.h>')], doc);
  assert.equal(removedCount, 1);
  assert.equal(hunks.length, 0);
});

test('preserves multiple hunks, filtering each independently', () => {
  const dup = insert('#include <string.h>', 1, 'h-a');
  const fresh = insert('#include <stdint.h>', 10, 'h-b');
  const { hunks, removedCount } = dedupeIncludes([dup, fresh], DOC);
  assert.equal(removedCount, 1);
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].hunk_id, 'h-b');
});

test('empty hunk list yields no removals', () => {
  const { hunks, removedCount } = dedupeIncludes([], DOC);
  assert.equal(removedCount, 0);
  assert.equal(hunks.length, 0);
});
