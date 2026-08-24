// Shared hunk-application and conflict logic for the C Repair prototype.
//
// This is the single canonical implementation, shared byte-for-byte between the
// fixture validator (Node) and the web UI (browser). It is pure ESM JS with no
// Node-specific APIs so it can be imported in both environments.
//
// Coordinates: Original C basis, 1-indexed, both ends inclusive
// (CONTRACT.md §1). Hunk semantics: STATE_MODEL.md §6 / CONTRACT.md §2.4.

// ---------------------------------------------------------------------------
// Hunk application (STATE_MODEL.md §6): apply in descending start_line order.
// line_count=0 => insert before start_line. n>0 => replace n lines from start_line.
// Content is modeled as an array of lines (source split on "\n").
// ---------------------------------------------------------------------------
export function applyHunks(content, hunks) {
  const lines = content.split('\n');
  const sorted = [...hunks].sort((a, b) => b.start_line - a.start_line);
  for (const h of sorted) {
    const idx = h.start_line - 1;
    const repl = h.replacement_text === '' && h.line_count > 0 ? [] : h.replacement_text.split('\n');
    if (h.line_count === 0) {
      lines.splice(idx, 0, ...repl);
    } else {
      lines.splice(idx, h.line_count, ...repl);
    }
  }
  return lines.join('\n');
}

// Occupied line range of a hunk. line_count=0 => insertion boundary at start_line
// (modeled as a zero-width point [start_line, start_line) via {ins:true}).
export function hunkRange(h) {
  if (h.line_count === 0) return { start: h.start_line, end: h.start_line, insert: true };
  return { start: h.start_line, end: h.start_line + h.line_count - 1, insert: false };
}

export function rangesIntersect(a, b) {
  if (a.insert && b.insert) return a.start === b.start;
  if (a.insert) return a.start > b.start && a.start <= b.end; // insertion strictly inside b
  if (b.insert) return b.start > a.start && b.start <= a.end;
  return a.start <= b.end && b.start <= a.end;
}

export function candidatesConflict(cA, cB) {
  for (const ha of cA.hunks) {
    for (const hb of cB.hunks) {
      if (rangesIntersect(hunkRange(ha), hunkRange(hb))) return true;
    }
  }
  return false;
}
