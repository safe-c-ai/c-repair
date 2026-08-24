"""Function inventory extraction (PHASE3A_DESIGN.md §3-2).

The Original C is passed through certfix's line-structure-preserving
``Preprocessor`` and then ``split_functions`` to obtain the function inventory
(name, start/end line). Because ``Preprocessor`` preserves line structure, the
processed coordinates equal the Original coordinates.

The inventory is built from **Original C only** (the prelude is prepended
separately, at detection time). Original coordinates therefore never overlap the
prelude's Augmented-line range, so no Original function can lie inside the
prelude. The design's "exclude functions inside the prelude" rule is satisfied
structurally by inventorying Original C rather than Augmented C; the prelude may
contain function-like stubs, but those are not part of Original C and never
enter this inventory.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List

from certfix.core.preprocessor import Preprocessor
from certfix.core.splitter import split_functions


@dataclass(frozen=True)
class FunctionInfo:
    """A function in the Original C, Original coordinates (1-indexed, inclusive)."""

    function_id: str
    name: str
    start_line: int
    end_line: int


def build_inventory(original_content: str, prelude_line_count: int = 0) -> List[FunctionInfo]:
    """Return the function inventory for Original C.

    Args:
        original_content: Original C source (byte-unchanged). Coordinates in the
            returned inventory are Original-C, 1-indexed, inclusive.
        prelude_line_count: Accepted for interface symmetry with the Augmented C
            pipeline and documentation of intent. It is **not** used to gate
            Original functions: the inventory is built from Original C, whose
            line numbers never fall inside the prepended prelude's range, so no
            exclusion applies (see module docstring).

    Returns:
        Ordered list of FunctionInfo (source order).
    """
    del prelude_line_count  # documented no-op; see docstring
    # Preprocessor preserves line structure, so processed line numbers equal
    # Original line numbers.
    preprocessor = Preprocessor()
    processed, _mapping, _ignored = preprocessor.process(original_content)

    chunks = split_functions(processed)

    inventory: List[FunctionInfo] = []
    seq = 0
    for chunk in chunks:
        if not chunk.is_function:
            continue
        seq += 1
        name = chunk.name or f"anon_{seq}"
        inventory.append(
            FunctionInfo(
                function_id=f"fn-{name}-{chunk.start_line}",
                name=name,
                start_line=chunk.start_line,
                end_line=chunk.end_line,
            )
        )
    return inventory
