"""Fixture-parity tests for compose.py (PHASE3A_DESIGN.md §5-2, §3-1).

Assert that the Python prelude synthesis is equivalent to the canonical JS
implementation (packages/core/src/prelude.js) and matches the fixtures:

1. ``synthesized_prelude_line_count`` equals each augmentation fixture's
   ``prelude_line_count`` field.
2. The composed Augmented C is byte-identical to the JS ``composeAugmentedC``
   output for the same items + Original C (JS is invoked via node when node and
   the core package are available; otherwise that leg is skipped).
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from repair_api import compose

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURES = REPO_ROOT / "tests" / "fixtures"
CORE_INDEX = REPO_ROOT / "packages" / "core" / "src" / "index.js"

CASES = ["sample_clean", "sample_sensor", "sample_conflict"]


def _load(name: str):
    aug = json.loads((FIXTURES / "context" / f"{name}.augmentation.json").read_text())
    src = (FIXTURES / "source" / f"{name}.c").read_text()
    return aug, src


@pytest.mark.parametrize("name", CASES)
def test_prelude_line_count_matches_fixture(name: str) -> None:
    aug, _src = _load(name)
    assert compose.synthesized_prelude_line_count(aug["items"]) == aug["prelude_line_count"]


@pytest.mark.parametrize("name", CASES)
def test_compose_matches_js(name: str) -> None:
    node = shutil.which("node")
    if node is None or not CORE_INDEX.exists():
        pytest.skip("node or @c-repair/core not available")

    aug, src = _load(name)

    script = (
        "import { composeAugmentedC, synthesizedPreludeLineCount } from "
        f"{json.dumps(str(CORE_INDEX))};\n"
        "let input='';process.stdin.on('data',d=>input+=d);"
        "process.stdin.on('end',()=>{const {items,original}=JSON.parse(input);"
        "process.stdout.write(JSON.stringify({"
        "aug: composeAugmentedC(items, original),"
        "count: synthesizedPreludeLineCount(items)}));});"
    )
    payload = json.dumps({"items": aug["items"], "original": src})
    proc = subprocess.run(
        [node, "--input-type=module", "-e", script],
        input=payload,
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
    )
    assert proc.returncode == 0, proc.stderr
    js = json.loads(proc.stdout)

    assert compose.compose_augmented_c(aug["items"], src) == js["aug"]
    assert compose.synthesized_prelude_line_count(aug["items"]) == js["count"]
