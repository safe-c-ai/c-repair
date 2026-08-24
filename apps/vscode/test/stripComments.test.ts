// Unit tests for the line-structure-preserving C comment stripper (D-021). Pure
// Node, no `vscode`. Load-bearing: line count is preserved (1:1), comments become
// spaces (positions preserved), and comment-looking text inside string/char
// literals is NOT stripped. Behavior mirrors certfix core/preprocessor.py.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { stripCommentsPreserveLines } from '../src/session/stripComments';

test('preserves line count exactly (1:1 line structure)', () => {
  const src = 'int a; // x\n/* b\n c */\nint d;\n';
  const out = stripCommentsPreserveLines(src);
  assert.equal(out.split('\n').length, src.split('\n').length);
});

test('a line comment becomes spaces to end of line (positions preserved)', () => {
  const out = stripCommentsPreserveLines('int a; // comment');
  assert.equal(out, 'int a; ' + ' '.repeat('// comment'.length));
  assert.equal(out.length, 'int a; // comment'.length);
});

test('a single-line block comment is blanked (markers -> spaces)', () => {
  const out = stripCommentsPreserveLines('int /* mid */ a;');
  assert.equal(out, 'int           a;');
  assert.equal(out.length, 'int /* mid */ a;'.length);
});

test('a multi-line block comment is blanked on every line, newlines kept', () => {
  const src = 'a/* start\nmiddle\nend */b';
  const out = stripCommentsPreserveLines(src);
  const lines = out.split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[0], 'a' + ' '.repeat('/* start'.length));
  assert.equal(lines[1], ' '.repeat('middle'.length));
  // `end */b` -> the block ends at */, then real code `b` remains.
  assert.equal(lines[2], ' '.repeat('end '.length) + '  ' + 'b');
});

test('a // inside a string literal is NOT stripped', () => {
  const src = 'const char *s = "http://example.com"; // real';
  const out = stripCommentsPreserveLines(src);
  assert.ok(out.includes('"http://example.com"'), 'string content preserved');
  assert.ok(!out.includes('// real'), 'trailing real comment stripped');
});

test('a /* inside a string literal is NOT treated as a block comment', () => {
  const src = 'char *s = "/* not a comment */"; int x;';
  const out = stripCommentsPreserveLines(src);
  assert.equal(out, src, 'no comments to strip; string preserved verbatim');
});

test('a // inside a char literal is NOT stripped', () => {
  const src = "char c = '/'; int y; // tail";
  const out = stripCommentsPreserveLines(src);
  assert.ok(out.includes("'/'"), 'char literal preserved');
  assert.ok(!out.includes('// tail'), 'trailing comment stripped');
});

test('an escaped quote inside a string does not end the string early', () => {
  const src = 'char *s = "a\\"// still string"; // tail';
  const out = stripCommentsPreserveLines(src);
  assert.ok(out.includes('a\\"// still string'), 'escaped-quote string preserved');
  assert.ok(!out.includes('// tail'), 'the real trailing comment is stripped');
});

test('code with no comments is returned unchanged', () => {
  const src = 'int main(void) {\n    return 0;\n}\n';
  assert.equal(stripCommentsPreserveLines(src), src);
});

test('a trailing newline is preserved', () => {
  assert.equal(stripCommentsPreserveLines('int a; // c\n'), 'int a; ' + ' '.repeat('// c'.length) + '\n');
});
