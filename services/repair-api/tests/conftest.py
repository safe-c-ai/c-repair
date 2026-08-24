"""Shared test fixtures and fake CertFix backends.

No LLM is ever called: all detection goes through fake ``InferenceBackend``s
that return a scripted list of violations.
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Callable, List, Optional

import pytest
from certfix.models import Severity, Violation

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURES = REPO_ROOT / "tests" / "fixtures"
SCHEMAS = REPO_ROOT / "packages" / "contract" / "schemas"


def sha256_prefixed(content: str) -> str:
    """``sha256:`` prefixed hex of the UTF-8 bytes (contract hash form)."""
    return "sha256:" + hashlib.sha256(content.encode("utf-8")).hexdigest()


class LineAwareFake:
    """Line-aware fake backend.

    Reports violations at chunk-relative line numbers (``line_aware_detection =
    True``), letting a test place a violation at a precise position inside a
    function chunk. ``detect`` returns the same scripted list for every chunk it
    is called on that contains ``anchor`` (or for every function chunk if
    ``anchor`` is None).
    """

    line_aware_detection = True

    def __init__(
        self,
        violations: List[Violation],
        anchor: Optional[str] = None,
    ) -> None:
        self._violations = violations
        self._anchor = anchor

    def detect(self, code: str, rules: Optional[List[str]] = None) -> List[Violation]:
        if self._anchor is not None and self._anchor not in code:
            return []
        # Return fresh copies so Detector's in-place line remap doesn't mutate
        # the scripted originals across chunk calls.
        return [_copy(v) for v in self._violations]


class ScriptedFake:
    """Non-line-aware fake: violations collapse to each function's start line.

    ``by_function`` maps a substring that identifies a function chunk (typically
    the function name in its signature) to the list of ``rule_id``s to emit for
    that chunk. Because ``line_aware_detection = False``, every emitted violation
    is remapped by the Detector to the function chunk's Augmented start line.
    """

    line_aware_detection = False

    def __init__(self, by_function: dict[str, List[str]]) -> None:
        self._by_function = by_function

    def detect(self, code: str, rules: Optional[List[str]] = None) -> List[Violation]:
        out: List[Violation] = []
        for needle, rule_ids in self._by_function.items():
            if needle in code:
                for rid in rule_ids:
                    out.append(
                        Violation(
                            rule_id=rid,
                            file_path="x",
                            line=1,
                            column=1,
                            message=f"{rid} message",
                            severity=Severity.ERROR,
                        )
                    )
        return out


def _copy(v: Violation) -> Violation:
    return Violation(
        rule_id=v.rule_id,
        file_path=v.file_path,
        line=v.line,
        column=v.column,
        message=v.message,
        severity=v.severity,
    )


def make_violation(rule_id: str, line: int, message: str = "m") -> Violation:
    return Violation(
        rule_id=rule_id,
        file_path="x",
        line=line,
        column=1,
        message=message,
        severity=Severity.ERROR,
    )


class FixBackendFake:
    """Fake fix-role backend for the repair path.

    ``run_simple_repair`` (CODE_ONLY profile) extracts the final fenced ``c``
    block from ``generate``'s output as the whole-file fixed code. This fake wraps
    a supplied ``fixed_code`` in a code fence (or returns ``raw`` verbatim when
    given, e.g. to script an empty / non-code response). Never contacts an LLM.
    """

    def __init__(self, fixed_code: Optional[str] = None, raw: Optional[str] = None) -> None:
        if raw is not None:
            self._out = raw
        elif fixed_code is not None:
            self._out = "```c\n" + fixed_code + "\n```\n"
        else:
            self._out = ""

    def generate(self, prompt: str, max_tokens: int = 4096, temperature: float = 0.0) -> str:
        return self._out

    def is_available(self) -> bool:
        return True


@pytest.fixture
def fixtures_dir() -> Path:
    return FIXTURES


@pytest.fixture
def schemas_dir() -> Path:
    return SCHEMAS
