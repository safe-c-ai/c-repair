"""Prelude synthesis for Augmented C (CONTRACT.md §2.2, D-002).

This is the Python port of ``packages/core/src/prelude.js`` and MUST stay
byte-for-byte equivalent with it. Equivalence is asserted by the fixture-parity
tests (PHASE3A_DESIGN.md §5-2): for every augmentation fixture the composed
Augmented C and ``prelude_line_count`` produced here must match the fixture.

Composition rule (Phase 1, D-002)::

    Augmented C = marker-start line
                + provisional-context note line
                + concatenation of items[].current_text
                + marker-end line
                + one blank separator line
                + Original C (byte-unchanged)

``prelude_line_count = 4 + Σ items[].current_text line counts`` (marker 2 lines
+ note 1 line + blank 1 line = 4). Items may be empty; the 4-line structure is
always produced.
"""

from __future__ import annotations

from typing import Sequence

# Fixed marker / note strings. These MUST be identical to the constants in
# packages/core/src/prelude.js (CONTRACT.md §1 marker definitions).
MARKER_START = "/* ===== C Repair inferred context ===== */"
MARKER_END = "/* ===== Original source ===== */"
PRELUDE_NOTE = "/* Auto-generated provisional context. Not part of Original source. */"


def _current_text(item: object) -> str:
    """Read ``current_text`` from a dict or an object with the attribute."""
    if isinstance(item, dict):
        return item["current_text"]
    return getattr(item, "current_text")


def prelude_lines(items: Sequence[object]) -> list[str]:
    """Ordered array of prelude lines.

    The trailing ``""`` is the blank separator line that precedes the Original C
    content. Mirrors ``preludeLines`` in prelude.js exactly.
    """
    lines = [MARKER_START, PRELUDE_NOTE]
    for item in items:
        for line in _current_text(item).split("\n"):
            lines.append(line)
    lines.append(MARKER_END)
    lines.append("")  # blank separator line before Original C
    return lines


def synthesized_prelude_line_count(items: Sequence[object]) -> int:
    """Number of lines occupied by the synthesized prelude.

    Marker + note + concatenated item text + marker-end + blank. Mirrors the
    JS validator (``synthesizedPreludeLineCount``) exactly.
    """
    return len(prelude_lines(items))


def synthesize_prelude(items: Sequence[object]) -> str:
    """The prelude as a string.

    It ends with a trailing ``\\n`` because the final prelude line is the blank
    separator; joining the lines and appending the Original C therefore yields
    the pure concatenation described above.
    """
    return "\n".join(prelude_lines(items))


def compose_augmented_c(items: Sequence[object], original_content: str) -> str:
    """Augmented C = prelude + ``\\n`` + Original C.

    ``prelude_lines`` ends with ``""`` (the blank separator), so ``join`` produces
    a string whose last character is the newline terminating the marker-end line;
    the extra ``\\n`` here is that blank separator's own line break, after which
    the Original C begins byte-unchanged.
    """
    return synthesize_prelude(items) + "\n" + original_content
