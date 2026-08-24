"""Context inference / confirmation helpers (PHASE3A_DESIGN.md §2).

Phase 3a keeps context LLM completion in Phase 2: ``/context/infer`` always
returns an empty draft (items empty, prelude_line_count = 4). ``/context/confirm``
assigns a deterministic ``context_revision_id`` so that confirming the same
content twice yields the same revision (idempotent).
"""

from __future__ import annotations

import hashlib
from typing import Sequence

from repair_api import compose

# Empty-items prelude is always the 4-line structure (marker 2 + note 1 + blank 1).
EMPTY_PRELUDE_LINE_COUNT = compose.synthesized_prelude_line_count([])


def compute_revision_id(original_hash: str, items: Sequence[object]) -> str:
    """Deterministic revision id (PHASE3A_DESIGN.md §2).

    ``ctxrev-`` + first 12 hex of sha256(original_hash + concatenated
    items[].current_text). Same input -> same revision (idempotent).
    """
    current_texts = "".join(
        (item["current_text"] if isinstance(item, dict) else getattr(item, "current_text"))
        for item in items
    )
    digest = hashlib.sha256((original_hash + current_texts).encode("utf-8")).hexdigest()
    return "ctxrev-" + digest[:12]
