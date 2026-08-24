// Pure generation + parsing of the Context Review document (D-021, review revision).
//
// The Review document is the WHOLE Augmented C the harness feeds the LLM: the
// synthesized prelude (marker + note + the inferred declarations) followed by the
// Original source with its COMMENTS STRIPPED (line-structure preserved, mirroring
// certfix's preprocessor). It is shown as the editable right side of a diff against
// the read-only comment-stripped Original (D-021), so the user sees exactly what
// the LLM sees — the LLM never receives comments — and the inserted declaration
// block is visible as an insertion at the top. Accept still applies hunks to the
// real (commented) file; only the review/scan view is comment-stripped.
//
// Layout (marker constants come from @c-repair/core so this stays consistent with
// composeAugmentedC — the same prelude the harness synthesizes for scan/repair):
//
//   /* ===== C Repair inferred context ===== */              <- MARKER_START
//   /* Auto-generated provisional context. Not part of Original source. */  <- PRELUDE_NOTE
//   /* Edit the declarations below … */                      <- review note (comment)
//   /* --- item aug-1 [external_function_declaration] (llm_inferred) --- */
//   int read_sensor(int channel);
//   /* --- item aug-2 [external_global] (llm_inferred) --- */
//   extern int threshold;
//   /* ===== Original source ===== */                        <- MARKER_END
//   <blank separator line>
//   <Original C, comment-stripped (comments blanked, lines preserved)>
//
// The `/* --- item … --- */` delimiters live ONLY in the prelude and carry the
// item_id we parse edits back by. The `[kind] (provenance)` middle is display-only.
//
// PARSE (see parseReviewDoc): split on the FIRST MARKER_END line. The prelude part
// (before it) is parsed with the V2b item rules (item_id load-bearing, strict 1:1).
// The code part (after it) must be byte-identical to the comment-stripped scan-time
// Original — the user must not edit the Original here (edit the file and rescan).
// The byte check is also the safety net when a prelude declaration happens to
// contain a line equal to MARKER_END (e.g. a pasted marker string): we split on the
// first such line, and a mismatched code part then fails loudly rather than
// confirming garbage.

import { MARKER_START, MARKER_END, PRELUDE_NOTE, composeAugmentedC } from '@c-repair/core';
import type { ContextAugmentationItem } from '@c-repair/contract';
import { stripCommentsPreserveLines } from './stripComments';

/** A short instructional note appended under the markers (comment, ignored on parse). */
const REVIEW_NOTE_LINES = [
  '/* Edit the declarations below, then run "C Repair: Confirm Context & Scan". */',
  '/* Keep each /* --- item ... --- *' +
    '/ delimiter line intact — they map edits back to items. */',
  '/* Do NOT edit the Original source under the marker below — edit the file and rescan. */',
];

/** Matches an item delimiter line and captures its item_id (group 1). */
// Format: `/* --- item <id> [<kind>] (<provenance>) --- */`. Only the id is
// load-bearing on parse; the `[kind] (provenance)` middle is tolerated loosely so
// a user who tweaks that text (but keeps the id) does not break the parse.
const DELIMITER_RE = /^\/\*\s*---\s*item\s+(\S+)\b.*---\s*\*\/\s*$/;

/** Build the delimiter comment line for an item. */
function delimiterFor(item: ContextAugmentationItem): string {
  return `/* --- item ${item.item_id} [${item.kind}] (${item.provenance}) --- */`;
}

/**
 * The code tail composeAugmentedC places after the FIRST MARKER_END line: the blank
 * separator line + the Original with comments stripped (line-structure preserved),
 * byte-for-byte. Uses indexOf on `\n MARKER_END \n` so an item whose current_text
 * itself contains a MARKER_END line does not confuse the split
 * (String.prototype.split would return only up to the SECOND marker).
 *
 * The Original is comment-stripped here (not by the caller) so both build and parse
 * use one canonical stripped form — the same the harness would compute — and the
 * byte-equality check compares like for like.
 */
function codeTailOf(items: ContextAugmentationItem[], originalContent: string): string {
  const composed = composeAugmentedC(items, stripCommentsPreserveLines(originalContent));
  const sep = '\n' + MARKER_END + '\n';
  const i = composed.indexOf(sep);
  // composeAugmentedC always emits exactly one real MARKER_END after all items, so
  // the first occurrence is the composition's marker (item texts precede it).
  return composed.slice(i + sep.length);
}

/**
 * Render the Review document text: the whole Augmented C with per-item delimiters
 * interleaved in the prelude (D-021). The marker lines and the provisional-context
 * note are byte-identical to `composeAugmentedC` from @core; the code section is the
 * Original with comments stripped (line-structure preserved) — exactly what the LLM
 * sees. The only additions are the review-note comment lines and the
 * `/* --- item … --- *` delimiters, which are C comments and never reach the code
 * section. `originalContent` is the raw (commented) file text; stripping happens
 * here. Uses `\n` only (LF); the caller opens it as an untitled document.
 */
export function buildReviewDoc(
  items: ContextAugmentationItem[],
  originalContent: string,
): string {
  const preludeLines: string[] = [MARKER_START, PRELUDE_NOTE, ...REVIEW_NOTE_LINES];
  for (const item of items) {
    preludeLines.push(delimiterFor(item));
    // current_text may be multi-line; keep it verbatim (strip a trailing newline so
    // joining with '\n' does not double up).
    for (const l of item.current_text.replace(/\n+$/, '').split('\n')) preludeLines.push(l);
  }
  // Reuse composeAugmentedC for the marker-end + blank separator + Original tail so
  // the code section byte-matches exactly what the harness composes for scan.
  // composeAugmentedC(items, original) is `MARKER_START\nPRELUDE_NOTE\n<items>\n
  // MARKER_END\n\n<original>`; we replace its prelude head with our annotated head
  // (same markers/note, plus review-note + item delimiters), keeping the tail from
  // MARKER_END onward identical.
  return preludeLines.join('\n') + '\n' + MARKER_END + '\n' + codeTailOf(items, originalContent);
}

/** A parsed section: the item_id from its delimiter and its (trimmed) body text. */
interface ParsedSection {
  itemId: string;
  body: string;
}

export interface ReviewParseSuccess {
  ok: true;
  /**
   * The items with `current_text` updated from the document. When the body differs
   * from the item's `generated_text`, `user_edited` is set true and `provenance`
   * becomes `user_corrected` (design §3); otherwise both are left as-is. The
   * returned items are new objects (the inputs are not mutated).
   */
  items: ContextAugmentationItem[];
}

export interface ReviewParseFailure {
  ok: false;
  /** A user-facing reason (matching the notification copy). */
  reason: string;
}

export type ReviewParseResult = ReviewParseSuccess | ReviewParseFailure;

/**
 * Split the whole Review document into (prelude, code) on the FIRST line equal to
 * MARKER_END. Returns an error if no marker line is present. The blank separator
 * line and the Original code follow the marker line; `code` is everything after the
 * marker line's own newline (i.e. it still includes the blank separator as its
 * first line, mirroring composeAugmentedC's layout, so the byte check compares
 * like for like).
 */
function splitOnMarkerEnd(text: string): { prelude: string; code: string } | { error: string } {
  const lines = text.split('\n');
  const idx = lines.findIndex((l) => l === MARKER_END);
  if (idx === -1) {
    return {
      error:
        'The Original source marker line is missing. Do not edit the marker lines; rescan to restore the review.',
    };
  }
  const prelude = lines.slice(0, idx).join('\n');
  const code = lines.slice(idx + 1).join('\n');
  return { prelude, code };
}

/** Split the prelude into ordered sections keyed by their delimiter item_id. */
function splitSections(preludeText: string): ParsedSection[] | { error: string } {
  const lines = preludeText.split('\n');
  const sections: ParsedSection[] = [];
  let current: { itemId: string; bodyLines: string[] } | undefined;
  let sawDelimiter = false;

  for (const line of lines) {
    const m = DELIMITER_RE.exec(line);
    if (m) {
      sawDelimiter = true;
      if (current) sections.push({ itemId: current.itemId, body: trimBlankEdges(current.bodyLines) });
      current = { itemId: m[1], bodyLines: [] };
      continue;
    }
    if (current) current.bodyLines.push(line);
    // Lines before the first delimiter (the marker/note banner) are ignored.
  }
  if (current) sections.push({ itemId: current.itemId, body: trimBlankEdges(current.bodyLines) });

  if (!sawDelimiter) {
    return { error: 'item 区切りが壊れています（item 区切りコメントが見つかりません）。' };
  }
  return sections;
}

/** Trim leading/trailing all-blank lines, join the rest with '\n'. */
function trimBlankEdges(bodyLines: string[]): string {
  let start = 0;
  let end = bodyLines.length;
  while (start < end && bodyLines[start].trim() === '') start++;
  while (end > start && bodyLines[end - 1].trim() === '') end--;
  return bodyLines.slice(start, end).join('\n');
}

/**
 * Parse the (possibly user-edited) Review document back onto the draft items and
 * enforce that the Original code section is untouched (D-021).
 *
 * Prelude: strict 1:1 correspondence between the delimiters and the draft items (by
 * item_id): every draft item must appear exactly once, no unknown or duplicate
 * item_id may appear, and no section body may be empty.
 *
 * Code: the section after the first MARKER_END line must be byte-identical to the
 * blank separator + the scan-time Original with comments stripped (`codeTailOf`). No
 * normalization (trailing-newline etc.) is applied — the Original-invariant depends
 * on an exact match. `originalContent` is the raw (commented) file text; it is
 * stripped internally to match the generated doc. Any violation returns
 * `{ ok: false, reason }` so the caller keeps the doc open.
 */
export function parseReviewDoc(
  text: string,
  draftItems: ContextAugmentationItem[],
  originalContent: string,
): ReviewParseResult {
  const parts = splitOnMarkerEnd(text);
  if ('error' in parts) return { ok: false, reason: parts.error };

  // The expected code tail is what composeAugmentedC puts after the first MARKER_END
  // line: a blank separator line then the comment-stripped Original, byte-for-byte.
  const expectedCode = codeTailOf(draftItems, originalContent);
  if (parts.code !== expectedCode) {
    return {
      ok: false,
      reason:
        'The code section must not be edited here. Edit the file itself and rescan.',
    };
  }

  const split = splitSections(parts.prelude);
  if ('error' in split) return { ok: false, reason: split.error };
  const sections = split;

  const byId = new Map<string, ContextAugmentationItem>();
  for (const it of draftItems) byId.set(it.item_id, it);

  const seen = new Set<string>();
  for (const sec of sections) {
    if (!byId.has(sec.itemId)) {
      return {
        ok: false,
        reason: `item 区切りが壊れています（未知の item id: ${sec.itemId}）。`,
      };
    }
    if (seen.has(sec.itemId)) {
      return {
        ok: false,
        reason: `item 区切りが壊れています（item id が重複しています: ${sec.itemId}）。`,
      };
    }
    seen.add(sec.itemId);
    if (sec.body.trim() === '') {
      return {
        ok: false,
        reason: `item 区切りが壊れています（宣言が空です: ${sec.itemId}）。`,
      };
    }
  }
  // Every draft item must be present (a deleted delimiter drops its item).
  for (const it of draftItems) {
    if (!seen.has(it.item_id)) {
      return {
        ok: false,
        reason: `item 区切りが壊れています（item が欠けています: ${it.item_id}）。`,
      };
    }
  }

  // Build updated items in the ORIGINAL draft order (stable; the section order in
  // the doc does not reorder the set — item_id is the key).
  const bodyById = new Map<string, string>();
  for (const sec of sections) bodyById.set(sec.itemId, sec.body);

  const updated = draftItems.map((it): ContextAugmentationItem => {
    const body = bodyById.get(it.item_id)!;
    const edited = body !== it.generated_text;
    return {
      ...it,
      current_text: body,
      user_edited: edited || it.user_edited,
      provenance: edited ? 'user_corrected' : it.provenance,
    };
  });
  return { ok: true, items: updated };
}
