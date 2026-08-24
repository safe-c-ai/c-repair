// Line-structure-preserving C comment stripper (D-021, review revision).
//
// A faithful TypeScript port of certfix's core/preprocessor.py `_remove_comments`
// (the `keep_comments=False` path the harness runs before sending code to the LLM).
// We reproduce it in the extension because the Context Review diff must show BOTH
// sides comment-stripped — "what you review is what the LLM sees" — and we cannot
// round-trip through the bridge to render the diff.
//
// Behavior (must match preprocessor.py byte-for-byte):
//   - Comments are replaced with spaces so character positions (and therefore line
//     numbers / column offsets) are preserved. Line structure is fully preserved:
//     input is split on '\n' and rejoined with '\n' (no line added or removed).
//   - `/* … */` block comments: the `/*` and `*/` markers each become two spaces,
//     interior characters each become one space. Block comments span lines.
//   - `// …` line comments: the rest of the line becomes spaces.
//   - String ("…") and char ('…') literals are NOT stripped; a `//` or `/*` inside
//     a literal is preserved verbatim. Backslash escapes inside literals are
//     honored (so `"\""` does not end the string early).
//   - String/char state resets to normal at each line boundary (mirrors the
//     Python, which scans line by line); block-comment state persists across lines.

/**
 * Replace C comments with spaces, preserving every newline (1:1 line structure).
 * Pure — no `vscode`, no Node APIs — so it is unit testable and usable anywhere.
 */
export function stripCommentsPreserveLines(code: string): string {
  const lines = code.split('\n');
  const result: string[] = [];
  let inBlockComment = false;
  let state: 'normal' | 'string' | 'char' = 'normal';

  for (const line of lines) {
    let processed = '';
    let i = 0;
    while (i < line.length) {
      if (inBlockComment) {
        // Look for the end of the block comment.
        if (i < line.length - 1 && line.slice(i, i + 2) === '*/') {
          processed += '  ';
          i += 2;
          inBlockComment = false;
          state = 'normal';
        } else {
          processed += ' ';
          i += 1;
        }
      } else if (state === 'string') {
        processed += line[i];
        if (line[i] === '\\' && i + 1 < line.length) {
          processed += line[i + 1];
          i += 2;
          continue;
        }
        if (line[i] === '"') state = 'normal';
        i += 1;
      } else if (state === 'char') {
        processed += line[i];
        if (line[i] === '\\' && i + 1 < line.length) {
          processed += line[i + 1];
          i += 2;
          continue;
        }
        if (line[i] === "'") state = 'normal';
        i += 1;
      } else if (i < line.length - 1 && line.slice(i, i + 2) === '/*') {
        // Start of a block comment.
        processed += '  ';
        i += 2;
        inBlockComment = true;
      } else if (i < line.length - 1 && line.slice(i, i + 2) === '//') {
        // Line comment — replace the rest of the line with spaces.
        processed += ' '.repeat(line.length - i);
        break;
      } else {
        processed += line[i];
        if (line[i] === '"') state = 'string';
        else if (line[i] === "'") state = 'char';
        i += 1;
      }
    }

    result.push(processed);
    // String/char state does not leak across a newline (matches the Python).
    if (state === 'string' || state === 'char') state = 'normal';
  }

  return result.join('\n');
}
