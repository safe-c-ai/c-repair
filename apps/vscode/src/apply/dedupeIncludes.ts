// Duplicate #include removal at Accept time (D-026). Independently generated
// candidates each carry their own `#include <...>` insertion hunk; when their
// insertion anchors differ, the range-based conflict guard (D-004) does not catch
// them, so accepting several in a row can insert the same #include line twice.
//
// This pure filter runs immediately before the WorkspaceEdit is built: for each
// PURE INSERTION hunk (line_count === 0), it drops any `#include` line whose exact
// (trimmed) text already exists in the CURRENT document. Because the check is made
// against the live document text at the moment of Accept, it is independent of the
// candidates' anchors and of the order the accepts are applied.
//
// Conservative by design (D-026): only `#include` lines are ever removed, and only
// on a trim-exact match against an existing document line. Replacement hunks
// (line_count > 0) and every non-`#include` line are left untouched.

import type { Hunk } from '@c-repair/contract';

export interface DedupeResult {
  /** The hunks to apply, with duplicate #include lines removed (empty hunks dropped). */
  hunks: Hunk[];
  /** How many duplicate #include lines were removed across all hunks. */
  removedCount: number;
}

/** True when a line, trimmed, is a C preprocessor `#include` directive. */
function isIncludeLine(line: string): boolean {
  return line.trim().startsWith('#include');
}

/**
 * The set of trim-exact `#include` lines already present in `documentText`. Used to
 * decide which inserted `#include` lines are duplicates. Only `#include` lines are
 * collected; a trailing '\r' (should not occur — the project is LF-only) is stripped
 * by trim so the comparison is newline-agnostic.
 */
function existingIncludeLines(documentText: string): Set<string> {
  const set = new Set<string>();
  for (const raw of documentText.split('\n')) {
    if (isIncludeLine(raw)) set.add(raw.trim());
  }
  return set;
}

/**
 * Remove, from each PURE INSERTION hunk, any `#include` line whose trimmed text
 * already exists in `documentText` (D-026). A hunk that becomes empty (no lines, or
 * only blank lines left) is dropped entirely; a hunk with some non-duplicate lines
 * left keeps them (joined back in original order). Replacement hunks (line_count > 0)
 * are returned unchanged, as are any non-`#include` lines within an insertion hunk.
 *
 * `documentText` must be the CURRENT document body at Accept time (including edits
 * from any already-accepted candidates), so the duplicate check reflects reality
 * regardless of anchor drift or accept ordering.
 */
export function dedupeIncludes(hunks: Hunk[], documentText: string): DedupeResult {
  const existing = existingIncludeLines(documentText);
  const out: Hunk[] = [];
  let removedCount = 0;

  for (const h of hunks) {
    // Only pure insertions are eligible; replacement hunks are never touched.
    if (h.line_count !== 0) {
      out.push(h);
      continue;
    }

    const lines = h.replacement_text.split('\n');
    const kept: string[] = [];
    for (const line of lines) {
      if (isIncludeLine(line) && existing.has(line.trim())) {
        removedCount += 1;
        continue; // drop this duplicate #include line
      }
      kept.push(line);
    }

    // Nothing removed from this hunk: pass it through untouched.
    if (kept.length === lines.length) {
      out.push(h);
      continue;
    }

    // Drop the hunk entirely when only blank lines (or nothing) remain.
    if (kept.every((l) => l.trim() === '')) continue;

    out.push({ ...h, replacement_text: kept.join('\n') });
  }

  return { hunks: out, removedCount };
}
