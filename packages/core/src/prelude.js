// Prelude synthesis for Augmented C (CONTRACT.md §2.2, D-002).
//
// Composition rule (Phase 1 fixture only):
//   Augmented C = marker-start line
//               + provisional-context note line
//               + concatenation of items[].current_text
//               + marker-end line
//               + one blank separator line
//               + Original C (byte-unchanged)
//
// prelude_line_count = 4 + Σ items[].current_text line counts (marker 2 lines +
// note 1 line + blank 1 line = 4). Items may be empty; the 4-line structure is
// always produced.
//
// Pure ESM JS (browser + Node), no Node-specific APIs.

export const MARKER_START = '/* ===== C Repair inferred context ===== */';
export const MARKER_END = '/* ===== Original source ===== */';
export const PRELUDE_NOTE =
  '/* Auto-generated provisional context. Not part of Original source. */';

// Build the ordered array of prelude lines. The trailing '' is the blank
// separator line that precedes the Original C content.
function preludeLines(items) {
  const lines = [MARKER_START, PRELUDE_NOTE];
  for (const item of items) {
    for (const l of item.current_text.split('\n')) lines.push(l);
  }
  lines.push(MARKER_END);
  lines.push(''); // blank separator line before Original C
  return lines;
}

// Number of lines occupied by the synthesized prelude (marker + note +
// concatenated item text + marker-end + blank). Mirrors the validator exactly.
export function synthesizedPreludeLineCount(items) {
  return preludeLines(items).length;
}

// The prelude as a string. It ends with a trailing '\n' because the final
// prelude line is the blank separator; joining the lines and appending the
// Original C therefore yields the pure concatenation described above.
export function synthesizePrelude(items) {
  return preludeLines(items).join('\n');
}

// Augmented C = prelude + '\n' + Original C.
// preludeLines ends with '' (the blank separator), so join() produces a string
// whose last character is the newline terminating the marker-end line; the
// extra '\n' here is that blank separator's own line break, after which the
// Original C begins byte-unchanged.
export function composeAugmentedC(items, originalContent) {
  return synthesizePrelude(items) + '\n' + originalContent;
}
