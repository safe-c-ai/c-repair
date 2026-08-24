"""Infer / check unit tests (V2_CONTEXT_BUILDER_DESIGN §1, §5 V2a).

Hermetic: the LLM backend is a fake returning a scripted infer response, and the
compilers are injected fakes (availability probe + whole-file compile runner), so
no LLM and no real gcc are ever invoked. Covers:

- symbol detection -> item synthesis (missing symbols from fake stderr -> items).
- kind classification (typedef/enum -> inferred_type, #define -> inferred_macro,
  prototype -> external_function_declaration, other -> external_global).
- parse failure -> the symbol yields no item (never fabricated).
- compiler absent / gate disabled / baseline compiles -> empty draft (degrade).
- usage evidence line numbers.
- check: compiles true / false + missing_symbols content.
"""

from __future__ import annotations

import logging

from repair_api import compose, infer as infer_mod
from repair_api.adapter import repair as repair_adapter

# A context-poor .c using an external type, function, macro and global. The
# baseline compile is faked to fail with matching diagnostics.
SRC = (
    "int over_threshold(void) {\n"
    "    Sensor s;\n"
    "    int v = read_sensor(0);\n"
    "    if (v > THRESHOLD) {\n"
    "        return limit;\n"
    "    }\n"
    "    return v;\n"
    "}\n"
)

# gcc-style stderr naming the four missing symbols (type / function / macro-ish
# undeclared / global). _extract_missing_symbols yields, in order:
#   Sensor (unknown type), read_sensor (implicit decl), THRESHOLD, limit (undeclared)
STDERR = (
    "x.c:2:5: error: unknown type name 'Sensor'\n"
    "x.c:3:13: warning: implicit declaration of function 'read_sensor'\n"
    "x.c:4:13: error: 'THRESHOLD' undeclared (first use in this function)\n"
    "x.c:5:16: error: 'limit' undeclared (first use in this function)\n"
)


class InferBackendFake:
    """Fake fix-role backend that returns a scripted infer response verbatim."""

    def __init__(self, out: str) -> None:
        self._out = out

    def generate(self, prompt: str, max_tokens: int = 1024, temperature: float = 0.0) -> str:
        return self._out

    def is_available(self) -> bool:
        return True


def _has_compiler(_command: str) -> repair_adapter.CompileProbe:
    return repair_adapter.CompileProbe(available=True, detail="gcc available")


def _no_compiler(_command: str) -> repair_adapter.CompileProbe:
    return repair_adapter.CompileProbe(available=False, detail="gcc not found")


def _baseline_fails(stderr: str):
    def runner(_code: str, _config: object) -> repair_adapter.CompileOutcome:
        return repair_adapter.CompileOutcome(ok=False, stderr=stderr)

    return runner


def _baseline_passes(_code: str, _config: object) -> repair_adapter.CompileOutcome:
    return repair_adapter.CompileOutcome(ok=True, stderr="")


# The model returns one labelled fenced block per symbol.
GOOD_RESPONSE = (
    "### symbol: Sensor\n"
    "```c\n"
    "typedef struct { int channel; } Sensor;\n"
    "```\n"
    "### symbol: read_sensor\n"
    "```c\n"
    "int read_sensor(int channel);\n"
    "```\n"
    "### symbol: THRESHOLD\n"
    "```c\n"
    "#define THRESHOLD 100\n"
    "```\n"
    "### symbol: limit\n"
    "```c\n"
    "extern int limit;\n"
    "```\n"
)


def _run_infer(backend, *, compile_runner, baseline_compile_runner, compile_enabled=True):
    from certfix.config import CompileValidationConfig

    return infer_mod.run_infer(
        backend=backend,
        compile_config=CompileValidationConfig(),
        original_content=SRC,
        filename="x.c",
        compile_enabled=compile_enabled,
        compile_runner=compile_runner,
        baseline_compile_runner=baseline_compile_runner,
    )


# --- detection -> item synthesis + kind classification ----------------------


def test_infer_detects_symbols_and_synthesizes_items_with_kinds() -> None:
    result = _run_infer(
        InferBackendFake(GOOD_RESPONSE),
        compile_runner=_has_compiler,
        baseline_compile_runner=_baseline_fails(STDERR),
    )
    assert result.missing_symbols == ["Sensor", "read_sensor", "THRESHOLD", "limit"]
    by_gen = {it["generated_text"]: it for it in result.items}

    assert by_gen["typedef struct { int channel; } Sensor;"]["kind"] == "inferred_type"
    assert by_gen["int read_sensor(int channel);"]["kind"] == "external_function_declaration"
    assert by_gen["#define THRESHOLD 100"]["kind"] == "inferred_macro"
    assert by_gen["extern int limit;"]["kind"] == "external_global"

    for it in result.items:
        assert it["provenance"] == "llm_inferred"
        assert it["confirmed"] is False
        assert it["user_edited"] is False
        assert it["generated_text"] == it["current_text"]
        assert it["rationale"]

    # prelude_line_count follows the compose rule for the synthesized items.
    assert result.prelude_line_count == compose.synthesized_prelude_line_count(result.items)


def test_infer_usage_evidence_line_numbers() -> None:
    result = _run_infer(
        InferBackendFake(GOOD_RESPONSE),
        compile_runner=_has_compiler,
        baseline_compile_runner=_baseline_fails(STDERR),
    )
    by_gen = {it["generated_text"]: it for it in result.items}
    # read_sensor is used on Original line 3; THRESHOLD on line 4.
    rs = by_gen["int read_sensor(int channel);"]
    assert rs["usage_evidence"][0]["line"] == 3
    assert "read_sensor(0)" in rs["usage_evidence"][0]["snippet"]
    thr = by_gen["#define THRESHOLD 100"]
    assert thr["usage_evidence"][0]["line"] == 4


def test_infer_unparsed_symbol_gets_no_item() -> None:
    # The model omits THRESHOLD and 'limit' entirely -> only 2 items synthesized.
    partial = (
        "### symbol: Sensor\n```c\ntypedef int Sensor;\n```\n"
        "### symbol: read_sensor\n```c\nint read_sensor(int channel);\n```\n"
    )
    result = _run_infer(
        InferBackendFake(partial),
        compile_runner=_has_compiler,
        baseline_compile_runner=_baseline_fails(STDERR),
    )
    gen = {it["generated_text"] for it in result.items}
    assert gen == {"typedef int Sensor;", "int read_sensor(int channel);"}
    # Still records all four missing symbols (the two unparsed ones just lack items).
    assert result.missing_symbols == ["Sensor", "read_sensor", "THRESHOLD", "limit"]


def test_infer_blank_block_is_treated_as_unparsed() -> None:
    only_blank = "### symbol: Sensor\n```c\n\n```\n"
    result = _run_infer(
        InferBackendFake(only_blank),
        compile_runner=_has_compiler,
        baseline_compile_runner=_baseline_fails(STDERR),
    )
    assert result.items == []


# --- degrade paths ----------------------------------------------------------


def test_infer_no_compiler_returns_empty_draft() -> None:
    # The backend must never be consulted when there is no compiler.
    class Boom(InferBackendFake):
        def generate(self, *a, **k):  # noqa: ANN002, ANN003
            raise AssertionError("backend must not be called without a compiler")

    result = _run_infer(
        Boom(""),
        compile_runner=_no_compiler,
        baseline_compile_runner=_baseline_fails(STDERR),
    )
    assert result.items == []
    assert result.missing_symbols == []
    assert result.prelude_line_count == compose.synthesized_prelude_line_count([])


def test_infer_gate_disabled_returns_empty_draft() -> None:
    result = _run_infer(
        InferBackendFake(GOOD_RESPONSE),
        compile_runner=_has_compiler,
        baseline_compile_runner=_baseline_fails(STDERR),
        compile_enabled=False,
    )
    assert result.items == []
    assert result.missing_symbols == []


def test_infer_baseline_compiles_returns_empty_draft() -> None:
    # If the Original already compiles (self-contained) there is nothing to infer.
    result = _run_infer(
        InferBackendFake(GOOD_RESPONSE),
        compile_runner=_has_compiler,
        baseline_compile_runner=_baseline_passes,
    )
    assert result.items == []
    assert result.missing_symbols == []


def test_infer_baseline_fails_without_extractable_symbols_returns_empty() -> None:
    result = _run_infer(
        InferBackendFake(GOOD_RESPONSE),
        compile_runner=_has_compiler,
        baseline_compile_runner=_baseline_fails("x.c: some unrecognized error\n"),
    )
    assert result.items == []


def test_infer_backend_none_with_symbols_returns_empty() -> None:
    result = _run_infer(
        None,
        compile_runner=_has_compiler,
        baseline_compile_runner=_baseline_fails(STDERR),
    )
    assert result.items == []
    # missing symbols still detected even though no backend produced declarations.
    assert result.missing_symbols == ["Sensor", "read_sensor", "THRESHOLD", "limit"]


# --- classify_kind direct ---------------------------------------------------


def test_classify_kind_rules() -> None:
    assert infer_mod.classify_kind("typedef int T;") == "inferred_type"
    assert infer_mod.classify_kind("struct point { int x; };") == "inferred_type"
    assert infer_mod.classify_kind("enum e { A, B };") == "inferred_type"
    assert infer_mod.classify_kind("union u { int a; float b; };") == "inferred_type"
    assert infer_mod.classify_kind("#define MAX 10") == "inferred_macro"
    # Function-like macro: macro check wins over the '(' function heuristic.
    assert infer_mod.classify_kind("#define SQ(x) ((x)*(x))") == "inferred_macro"
    assert infer_mod.classify_kind("int f(int x);") == "external_function_declaration"
    assert infer_mod.classify_kind("extern int g;") == "external_global"


# --- check ------------------------------------------------------------------


def _run_check(items, *, compile_runner, baseline_compile_runner, compile_enabled=True):
    from certfix.config import CompileValidationConfig

    return infer_mod.run_check(
        compile_config=CompileValidationConfig(),
        original_content=SRC,
        items=items,
        compile_enabled=compile_enabled,
        compile_runner=compile_runner,
        baseline_compile_runner=baseline_compile_runner,
    )


def test_check_compiles_true_when_augmented_compiles() -> None:
    result = _run_check(
        [],
        compile_runner=_has_compiler,
        baseline_compile_runner=_baseline_passes,
    )
    assert result.compiles is True
    assert result.missing_symbols == []


def test_check_compiles_false_lists_missing_symbols() -> None:
    result = _run_check(
        [],
        compile_runner=_has_compiler,
        baseline_compile_runner=_baseline_fails(STDERR),
    )
    assert result.compiles is False
    assert result.missing_symbols == ["Sensor", "read_sensor", "THRESHOLD", "limit"]


def test_check_no_compiler_is_skipped_shape() -> None:
    result = _run_check(
        [],
        compile_runner=_no_compiler,
        baseline_compile_runner=_baseline_passes,
    )
    assert result.compiles is False
    assert result.missing_symbols == []


def test_check_gate_disabled_is_skipped_shape() -> None:
    result = _run_check(
        [],
        compile_runner=_has_compiler,
        baseline_compile_runner=_baseline_passes,
        compile_enabled=False,
    )
    assert result.compiles is False


def test_check_no_missing_headers_stubbed_when_augmented_compiles() -> None:
    # The all-headers-present (self-contained) case behaves exactly as before:
    # single probe, stubbed_headers empty.
    result = _run_check(
        [],
        compile_runner=_has_compiler,
        baseline_compile_runner=_baseline_passes,
    )
    assert result.compiles is True
    assert result.stubbed_headers == []


# --- two-stage stub probe (missing local header) ----------------------------

# A context-poor .c whose declarations live in a quoted project header. In a
# single-file context that header is absent, so the FIRST probe stops at the
# include; a stub lets the include pass and the type/undeclared errors surface.
SRC_WITH_INCLUDE = (
    '#include "zutil.h"\n'
    "int over_threshold(void) {\n"
    "    Sensor s;\n"
    "    return read_sensor(0);\n"
    "}\n"
)

# Stage-2 stderr (after the stub resolves the include): the real errors.
STDERR_AFTER_STUB = (
    "x.c:3:5: error: unknown type name 'Sensor'\n"
    "x.c:4:12: warning: implicit declaration of function 'read_sensor'\n"
)

FATAL_INCLUDE = 'x.c:1:10: fatal error: zutil.h: No such file or directory\n'


def _staged_runner(fatal_stderr: str, after_stub_stderr: str):
    """A fake baseline runner: the include fatal error until a stub dir is on -I,
    then the post-include errors (as a real re-probe would return)."""

    def runner(_code: str, config: object):
        include_paths = list(getattr(config, "include_paths", []) or [])
        if any("cfx-stub-" in p for p in include_paths):
            return repair_adapter.CompileOutcome(ok=False, stderr=after_stub_stderr)
        return repair_adapter.CompileOutcome(ok=False, stderr=fatal_stderr)

    return runner


def test_infer_two_stage_probe_stubs_missing_header_then_infers() -> None:
    from certfix.config import CompileValidationConfig

    response = (
        "### symbol: Sensor\n```c\ntypedef struct { int ch; } Sensor;\n```\n"
        "### symbol: read_sensor\n```c\nint read_sensor(int ch);\n```\n"
    )
    result = infer_mod.run_infer(
        backend=InferBackendFake(response),
        compile_config=CompileValidationConfig(),
        original_content=SRC_WITH_INCLUDE,
        filename="x.c",
        compile_enabled=True,
        compile_runner=_has_compiler,
        baseline_compile_runner=_staged_runner(FATAL_INCLUDE, STDERR_AFTER_STUB),
    )
    # Without the stub the first probe yields 0 symbols; the stub surfaces them.
    assert result.missing_symbols == ["Sensor", "read_sensor"]
    gen = {it["generated_text"] for it in result.items}
    assert gen == {"typedef struct { int ch; } Sensor;", "int read_sensor(int ch);"}


def test_infer_missing_local_header_but_no_symbols_after_stub_is_empty() -> None:
    from certfix.config import CompileValidationConfig

    # The stub resolves the include but nothing else is wrong -> compiles, empty.
    def runner(_code: str, config: object):
        include_paths = list(getattr(config, "include_paths", []) or [])
        if any("cfx-stub-" in p for p in include_paths):
            return repair_adapter.CompileOutcome(ok=True, stderr="")
        return repair_adapter.CompileOutcome(ok=False, stderr=FATAL_INCLUDE)

    result = infer_mod.run_infer(
        backend=InferBackendFake(""),
        compile_config=CompileValidationConfig(),
        original_content=SRC_WITH_INCLUDE,
        filename="x.c",
        compile_enabled=True,
        compile_runner=_has_compiler,
        baseline_compile_runner=runner,
    )
    assert result.items == []
    assert result.missing_symbols == []


def test_check_reports_stubbed_headers() -> None:
    from certfix.config import CompileValidationConfig

    result = infer_mod.run_check(
        compile_config=CompileValidationConfig(),
        original_content=SRC_WITH_INCLUDE,
        items=[],
        compile_enabled=True,
        compile_runner=_has_compiler,
        baseline_compile_runner=_staged_runner(FATAL_INCLUDE, STDERR_AFTER_STUB),
    )
    assert result.compiles is False
    assert result.stubbed_headers == ["zutil.h"]
    assert result.missing_symbols == ["Sensor", "read_sensor"]


# --- iterative convergence (task §1) ----------------------------------------
#
# The baseline runner below models a compiler that resolves a symbol once its
# declaration lands in the composed prelude: it emits an ``undeclared`` /
# ``unknown type`` diagnostic ONLY for symbols whose declaration text is not yet
# present in the code it is handed (the Augmented C on a re-probe, the bare
# Original on the first probe). This lets a multi-round loop actually converge
# as the fake backend adds declarations, unlike a fixed-stderr fake.


def _resolving_runner(all_symbols, original):
    """Fake baseline: a symbol is 'declared' when it appears in a line of the
    compiled code that is NOT a line of the Original body. The composed prelude
    is prepended byte-for-byte before the Original, so the added-declaration
    lines are exactly the lines that don't occur in the Original — keying on that
    (rather than the comment markers, which the Preprocessor strips before this
    runner sees the code) reliably tells a declaration line from a call site like
    ``copy_bytes(&st, LIMIT)`` that lives in the Original body."""

    original_lines = {ln.strip() for ln in original.split("\n") if ln.strip()}

    def _declared(code: str, sym: str) -> bool:
        for line in code.split("\n"):
            s = line.strip()
            if sym in s and s not in original_lines:
                return True
        return False

    def runner(code: str, _config: object) -> repair_adapter.CompileOutcome:
        still = [s for s in all_symbols if s in code and not _declared(code, s)]
        if not still:
            return repair_adapter.CompileOutcome(ok=True, stderr="")
        stderr = "".join(f"error: '{s}' undeclared (first use in this function)\n" for s in still)
        return repair_adapter.CompileOutcome(ok=False, stderr=stderr)

    return runner


class ScriptedBackend:
    """Fake fix-role backend returning a scripted response per successive call
    (round). After the script is exhausted it returns an empty string."""

    def __init__(self, *responses: str) -> None:
        self._responses = list(responses)
        self.calls = 0
        self.max_tokens_seen: list = []

    def generate(self, prompt: str, max_tokens: int = 1024, temperature: float = 0.0) -> str:
        self.max_tokens_seen.append(max_tokens)
        i = self.calls
        self.calls += 1
        return self._responses[i] if i < len(self._responses) else ""


# A file that uses many symbols the two-stage loop must complete across rounds.
SRC_MANY = (
    "int step(int mode) {\n"
    "    stream_t st;\n"
    "    st.state = HEAD;\n"
    "    if (mode == SYNC) { st.state = HEAD; }\n"
    "    return copy_bytes(&st, LIMIT);\n"
    "}\n"
)
MANY_SYMBOLS = ["stream_t", "HEAD", "SYNC", "copy_bytes", "LIMIT"]


def test_infer_converges_across_rounds_accumulating_items() -> None:
    from certfix.config import CompileValidationConfig

    # Round 1: the model only declares two of the five symbols; round 2 supplies
    # the rest. Items must accumulate and the residual missing must reach zero.
    round1 = (
        "### symbol: stream_t\n```c\ntypedef struct { int state; } stream_t;\n```\n"
        "### symbol: copy_bytes\n```c\nint copy_bytes(stream_t *s, int n);\n```\n"
    )
    round2 = (
        "### symbol: HEAD\n```c\nenum { HEAD, SYNC };\n```\n"
        "### symbol: LIMIT\n```c\n#define LIMIT 256\n```\n"
    )
    backend = ScriptedBackend(round1, round2)
    result = infer_mod.run_infer(
        backend=backend,
        compile_config=CompileValidationConfig(),
        original_content=SRC_MANY,
        filename="x.c",
        compile_enabled=True,
        compile_runner=_has_compiler,
        baseline_compile_runner=_resolving_runner(MANY_SYMBOLS, SRC_MANY),
    )
    # Two rounds, four accumulated items (2 + 2), fully converged.
    assert backend.calls == 2
    gen = {it["generated_text"] for it in result.items}
    assert gen == {
        "typedef struct { int state; } stream_t;",
        "int copy_bytes(stream_t *s, int n);",
        "enum { HEAD, SYNC };",
        "#define LIMIT 256",
    }
    # The wider per-round budget is used (not the old 1024).
    assert backend.max_tokens_seen == [4096, 4096]


def test_infer_enum_block_resolves_multiple_symbols_as_one_item() -> None:
    from certfix.config import CompileValidationConfig

    # One enum block declares HEAD and SYNC together — it must parse as a SINGLE
    # item (block-unit), classified as inferred_type, not two globals.
    response = (
        "### symbol: stream_t\n```c\ntypedef struct { int state; } stream_t;\n```\n"
        "### symbol: copy_bytes\n```c\nint copy_bytes(stream_t *s, int n);\n```\n"
        "### symbol: HEAD\n```c\nenum { HEAD, SYNC };\n```\n"
        "### symbol: LIMIT\n```c\n#define LIMIT 256\n```\n"
    )
    result = infer_mod.run_infer(
        backend=ScriptedBackend(response),
        compile_config=CompileValidationConfig(),
        original_content=SRC_MANY,
        filename="x.c",
        compile_enabled=True,
        compile_runner=_has_compiler,
        baseline_compile_runner=_resolving_runner(MANY_SYMBOLS, SRC_MANY),
    )
    # Four items: the single enum block resolves both HEAD and SYNC.
    assert len(result.items) == 4
    enum_items = [it for it in result.items if it["generated_text"] == "enum { HEAD, SYNC };"]
    assert len(enum_items) == 1
    assert enum_items[0]["kind"] == "inferred_type"
    # A block resolving multiple missing symbols still carries usage evidence for
    # one of them (HEAD is used on Original lines 3/4).
    assert enum_items[0]["usage_evidence"]


def test_infer_stops_when_no_progress() -> None:
    from certfix.config import CompileValidationConfig

    # The model keeps returning a declaration that does NOT resolve any missing
    # symbol (wrong name), so the missing SET never changes -> the loop must
    # stop after the first non-progress round, not spin for the full cap.
    useless = "### symbol: other\n```c\nextern int other;\n```\n"
    backend = ScriptedBackend(useless, useless, useless, useless)
    result = infer_mod.run_infer(
        backend=backend,
        compile_config=CompileValidationConfig(),
        original_content=SRC_MANY,
        filename="x.c",
        compile_enabled=True,
        compile_runner=_has_compiler,
        baseline_compile_runner=_resolving_runner(MANY_SYMBOLS, SRC_MANY),
    )
    # One useful-less round adds one item then stalls (missing set unchanged).
    assert backend.calls == 1
    assert len(result.items) == 1


# A 6-symbol variant so a one-symbol-per-round pace cannot fully converge
# within the 5-round cap (the cap must bind with one symbol still missing).
SRC_CAP = (
    "int step6(int mode) {\n"
    "    stream_t st;\n"
    "    st.state = HEAD;\n"
    "    if (mode == SYNC) { st.state = BAD; }\n"
    "    return copy_bytes(&st, LIMIT);\n"
    "}\n"
)
CAP_SYMBOLS = ["stream_t", "HEAD", "SYNC", "BAD", "copy_bytes", "LIMIT"]


def test_infer_round_cap_is_five() -> None:
    from certfix.config import CompileValidationConfig

    # Each round resolves exactly one symbol (the missing set changes every
    # round, so set-based progress keeps the loop going); with 6 symbols the
    # loop would need 6 rounds to converge — the cap stops it at 5.
    responses = [
        "### symbol: stream_t\n```c\ntypedef struct { int state; } stream_t;\n```\n",
        "### symbol: copy_bytes\n```c\nint copy_bytes(stream_t *s, int n);\n```\n",
        "### symbol: HEAD\n```c\nenum { HEAD };\n```\n",
        "### symbol: SYNC\n```c\nenum { SYNC };\n```\n",
        "### symbol: LIMIT\n```c\n#define LIMIT 256\n```\n",
        "### symbol: BAD\n```c\nenum { BAD };\n```\n",
    ]
    backend = ScriptedBackend(*responses)
    result = infer_mod.run_infer(
        backend=backend,
        compile_config=CompileValidationConfig(),
        original_content=SRC_CAP,
        filename="x.c",
        compile_enabled=True,
        compile_runner=_has_compiler,
        baseline_compile_runner=_resolving_runner(CAP_SYMBOLS, SRC_CAP),
    )
    # Progresses one symbol per round but is capped at 5 rounds / 5 items.
    assert backend.calls == 5
    assert len(result.items) == 5


def _layered_runner(layers, original):
    """Fake baseline modelling gcc's CASCADE: it reports errors only for the
    FIRST layer that still has an undeclared symbol — deeper layers surface only
    after the shallower ones are declared (a real compile stops elaborating at
    the first failing layer), and the compile succeeds once every layer is
    resolved. 'Declared' uses the same rule as ``_resolving_runner``: the symbol
    appears in a line that is not part of the Original body (i.e. the prelude)."""

    original_lines = {ln.strip() for ln in original.split("\n") if ln.strip()}

    def _declared(code: str, sym: str) -> bool:
        for line in code.split("\n"):
            s = line.strip()
            if sym in s and s not in original_lines:
                return True
        return False

    def runner(code: str, _config: object) -> repair_adapter.CompileOutcome:
        for layer in layers:
            still = [s for s in layer if not _declared(code, s)]
            if still:
                stderr = "".join(
                    f"error: '{s}' undeclared (first use in this function)\n" for s in still
                )
                return repair_adapter.CompileOutcome(ok=False, stderr=stderr)
        return repair_adapter.CompileOutcome(ok=True, stderr="")

    return runner


def test_infer_cascade_growing_missing_set_is_progress() -> None:
    from certfix.config import CompileValidationConfig

    # zlib-inflate.c live finding: resolving the first layer (2 symbols) makes
    # the re-probe surface the NEXT layer (7+ symbols). A count-based "did not
    # shrink" stop would misread both transitions below as a stall:
    #   round 1: missing {stream_t}            -> {copy_bytes, LIMIT}  (1 -> 2, GREW)
    #   round 2: missing {copy_bytes, LIMIT}   -> {HEAD, SYNC}         (2 -> 2, same count)
    #   round 3: missing {HEAD, SYNC}          -> {}                   (converged)
    # Set-based progress must run all 3 rounds to convergence.
    layers = [["stream_t"], ["copy_bytes", "LIMIT"], ["HEAD", "SYNC"]]
    responses = [
        "### symbol: stream_t\n```c\ntypedef struct { int state; } stream_t;\n```\n",
        "### symbol: copy_bytes\n```c\nint copy_bytes(stream_t *s, int n);\n```\n"
        "### symbol: LIMIT\n```c\n#define LIMIT 256\n```\n",
        "### symbol: HEAD\n```c\nenum { HEAD, SYNC };\n```\n",
    ]
    backend = ScriptedBackend(*responses)
    result = infer_mod.run_infer(
        backend=backend,
        compile_config=CompileValidationConfig(),
        original_content=SRC_MANY,
        filename="x.c",
        compile_enabled=True,
        compile_runner=_has_compiler,
        baseline_compile_runner=_layered_runner(layers, SRC_MANY),
    )
    # Three rounds ran to full convergence (no stall despite the growing set).
    assert backend.calls == 3
    gen = {it["generated_text"] for it in result.items}
    assert gen == {
        "typedef struct { int state; } stream_t;",
        "int copy_bytes(stream_t *s, int n);",
        "#define LIMIT 256",
        "enum { HEAD, SYNC };",
    }
    # Every symbol surfaced across the cascade is recorded.
    assert set(result.missing_symbols) == {"stream_t", "copy_bytes", "LIMIT", "HEAD", "SYNC"}


def test_infer_single_round_completes_like_before() -> None:
    from certfix.config import CompileValidationConfig

    # When one round resolves everything, the loop stops after round 1 — same
    # observable outcome as the pre-iteration single-call behaviour.
    response = (
        "### symbol: stream_t\n```c\ntypedef struct { int state; } stream_t;\n```\n"
        "### symbol: copy_bytes\n```c\nint copy_bytes(stream_t *s, int n);\n```\n"
        "### symbol: HEAD\n```c\nenum { HEAD, SYNC };\n```\n"
        "### symbol: LIMIT\n```c\n#define LIMIT 256\n```\n"
    )
    backend = ScriptedBackend(response)
    result = infer_mod.run_infer(
        backend=backend,
        compile_config=CompileValidationConfig(),
        original_content=SRC_MANY,
        filename="x.c",
        compile_enabled=True,
        compile_runner=_has_compiler,
        baseline_compile_runner=_resolving_runner(MANY_SYMBOLS, SRC_MANY),
    )
    assert backend.calls == 1
    assert len(result.items) == 4


# --- provider format variance: parse fallback + empty-retry ------------------
#
# Free-model auto-routing means the SAME prompt may be answered by providers
# that ignore the ``### symbol:`` label format (prose preambles, <think> tags,
# bare fenced blocks). The fallback parse and the one-shot same-prompt retry
# keep infer deterministic-ish under that variance.


def test_parse_fallback_prose_and_labelless_fences() -> None:
    # No ``### symbol:`` labels at all; leading + interleaved prose; one fenced
    # block that is not a declaration (no ';', no #define) must be discarded.
    out = (
        "Sure - here are the declarations you need:\n"
        "```c\n"
        "typedef struct { int state; } stream_t;\n"
        "```\n"
        "And the function prototype:\n"
        "```c\n"
        "int copy_bytes(stream_t *s, int n);\n"
        "```\n"
        "```\n"
        "this block is just prose with no declaration\n"
        "```\n"
    )
    blocks = infer_mod.parse_infer_response(out)
    assert [b["declaration"] for b in blocks] == [
        "typedef struct { int state; } stream_t;",
        "int copy_bytes(stream_t *s, int n);",
    ]
    # Fallback label = first identifier in the block body.
    assert blocks[0]["label"] == "typedef"
    assert blocks[1]["label"] == "int"


def test_parse_fallback_strips_think_tags() -> None:
    # A fenced draft inside <think>...</think> must NOT be extracted; only the
    # post-think answer fence is.
    out = (
        "<think>\n"
        "Maybe something like:\n"
        "```c\n"
        "extern int wrong_draft;\n"
        "```\n"
        "no, better a macro.\n"
        "</think>\n"
        "```c\n"
        "#define LIMIT 256\n"
        "```\n"
    )
    blocks = infer_mod.parse_infer_response(out)
    assert [b["declaration"] for b in blocks] == ["#define LIMIT 256"]


def test_parse_strict_format_still_wins_over_fallback() -> None:
    # When the strict labelled format IS present, the fallback must not run (a
    # think-fence would otherwise leak in as an extra block).
    out = (
        "<think>\n```c\nextern int draft;\n```\n</think>\n"
        "### symbol: LIMIT\n```c\n#define LIMIT 256\n```\n"
    )
    blocks = infer_mod.parse_infer_response(out)
    assert [b["declaration"] for b in blocks] == ["#define LIMIT 256"]
    assert blocks[0]["label"] == "LIMIT"


def test_infer_labelless_response_via_fallback_produces_items() -> None:
    from certfix.config import CompileValidationConfig

    # A provider that returns only bare fenced blocks (with a prose preamble)
    # must still yield items and converge in one round.
    response = (
        "Here are the missing declarations:\n"
        "```c\ntypedef struct { int state; } stream_t;\n```\n"
        "```c\nint copy_bytes(stream_t *s, int n);\n```\n"
        "```c\nenum { HEAD, SYNC };\n```\n"
        "```c\n#define LIMIT 256\n```\n"
    )
    backend = ScriptedBackend(response)
    result = infer_mod.run_infer(
        backend=backend,
        compile_config=CompileValidationConfig(),
        original_content=SRC_MANY,
        filename="x.c",
        compile_enabled=True,
        compile_runner=_has_compiler,
        baseline_compile_runner=_resolving_runner(MANY_SYMBOLS, SRC_MANY),
    )
    assert backend.calls == 1
    gen = {it["generated_text"] for it in result.items}
    assert gen == {
        "typedef struct { int state; } stream_t;",
        "int copy_bytes(stream_t *s, int n);",
        "enum { HEAD, SYNC };",
        "#define LIMIT 256",
    }
    # Kind classification works from the declaration text (labels absent).
    by_gen = {it["generated_text"]: it for it in result.items}
    assert by_gen["enum { HEAD, SYNC };"]["kind"] == "inferred_type"
    assert by_gen["#define LIMIT 256"]["kind"] == "inferred_macro"
    # Evidence attribution scans the known missing symbols in the block text.
    assert by_gen["enum { HEAD, SYNC };"]["usage_evidence"]


def test_infer_empty_first_response_retries_once_then_succeeds() -> None:
    from certfix.config import CompileValidationConfig

    good = (
        "### symbol: stream_t\n```c\ntypedef struct { int state; } stream_t;\n```\n"
        "### symbol: copy_bytes\n```c\nint copy_bytes(stream_t *s, int n);\n```\n"
        "### symbol: HEAD\n```c\nenum { HEAD, SYNC };\n```\n"
        "### symbol: LIMIT\n```c\n#define LIMIT 256\n```\n"
    )
    # First call: prose only, no fences (a provider that refused the format);
    # the same-prompt retry draws the good response and converges in round 1.
    backend = ScriptedBackend("I could not find any declarations, sorry.", good)
    result = infer_mod.run_infer(
        backend=backend,
        compile_config=CompileValidationConfig(),
        original_content=SRC_MANY,
        filename="x.c",
        compile_enabled=True,
        compile_runner=_has_compiler,
        baseline_compile_runner=_resolving_runner(MANY_SYMBOLS, SRC_MANY),
    )
    assert backend.calls == 2  # first attempt + one retry, single round
    assert len(result.items) == 4


def test_infer_retry_still_empty_stops_without_items() -> None:
    from certfix.config import CompileValidationConfig

    # Both the first attempt and the single retry parse to 0 blocks -> the round
    # yields no items and the no-progress guard ends the loop (no further rounds,
    # no second retry).
    backend = ScriptedBackend("no code here", "still no code")
    result = infer_mod.run_infer(
        backend=backend,
        compile_config=CompileValidationConfig(),
        original_content=SRC_MANY,
        filename="x.c",
        compile_enabled=True,
        compile_runner=_has_compiler,
        baseline_compile_runner=_resolving_runner(MANY_SYMBOLS, SRC_MANY),
    )
    assert backend.calls == 2  # exactly one retry, then stop
    assert result.items == []


# --- backend exception hardening ---------------------------------------------
#
# Live finding (zlib-deflate.c): a free-pool provider returned an error body
# without ``choices``; certfix's backend raised ``KeyError('choices')`` and the
# uncaught exception turned /context/infer into a 500. run_infer must map ANY
# backend.generate exception onto the empty-response path (retry once, then end
# the round) so accumulated items are always returned as a normal draft.


class FlakyBackend:
    """Fake backend whose scripted entries are either a response string (to
    return) or an Exception instance (to raise). Exhausted script -> ''."""

    def __init__(self, *script) -> None:
        self._script = list(script)
        self.calls = 0

    def generate(self, prompt: str, max_tokens: int = 1024, temperature: float = 0.0) -> str:
        i = self.calls
        self.calls += 1
        entry = self._script[i] if i < len(self._script) else ""
        if isinstance(entry, Exception):
            raise entry
        return entry

    def is_available(self) -> bool:
        return True


GOOD_MANY_RESPONSE = (
    "### symbol: stream_t\n```c\ntypedef struct { int state; } stream_t;\n```\n"
    "### symbol: copy_bytes\n```c\nint copy_bytes(stream_t *s, int n);\n```\n"
    "### symbol: HEAD\n```c\nenum { HEAD, SYNC };\n```\n"
    "### symbol: LIMIT\n```c\n#define LIMIT 256\n```\n"
)


def test_infer_backend_exception_then_retry_succeeds() -> None:
    from certfix.config import CompileValidationConfig

    # First call raises (provider error body without 'choices'); the same-prompt
    # retry succeeds and the round converges normally.
    backend = FlakyBackend(KeyError("choices"), GOOD_MANY_RESPONSE)
    result = infer_mod.run_infer(
        backend=backend,
        compile_config=CompileValidationConfig(),
        original_content=SRC_MANY,
        filename="x.c",
        compile_enabled=True,
        compile_runner=_has_compiler,
        baseline_compile_runner=_resolving_runner(MANY_SYMBOLS, SRC_MANY),
    )
    assert backend.calls == 2  # exception + successful retry
    assert len(result.items) == 4


def test_infer_backend_exception_in_later_round_keeps_accumulated_items() -> None:
    from certfix.config import CompileValidationConfig

    # Round 1 succeeds partially (2 items); round 2's first call AND retry both
    # raise -> the loop ends and the round-1 items are returned as a normal
    # draft (no exception escapes run_infer -> the endpoint would return 200).
    round1 = (
        "### symbol: stream_t\n```c\ntypedef struct { int state; } stream_t;\n```\n"
        "### symbol: copy_bytes\n```c\nint copy_bytes(stream_t *s, int n);\n```\n"
    )
    backend = FlakyBackend(round1, KeyError("choices"), RuntimeError("provider 502"))
    result = infer_mod.run_infer(
        backend=backend,
        compile_config=CompileValidationConfig(),
        original_content=SRC_MANY,
        filename="x.c",
        compile_enabled=True,
        compile_runner=_has_compiler,
        baseline_compile_runner=_resolving_runner(MANY_SYMBOLS, SRC_MANY),
    )
    assert backend.calls == 3  # round 1 + round 2's failed attempt + failed retry
    gen = {it["generated_text"] for it in result.items}
    assert gen == {
        "typedef struct { int state; } stream_t;",
        "int copy_bytes(stream_t *s, int n);",
    }


def test_infer_backend_always_raising_returns_empty_draft() -> None:
    from certfix.config import CompileValidationConfig

    # Every call raises from round 1 -> one retry, then the no-progress guard
    # ends the loop; the result is a valid empty draft, not an exception.
    backend = FlakyBackend(
        KeyError("choices"), KeyError("choices"), KeyError("choices"), KeyError("choices")
    )
    result = infer_mod.run_infer(
        backend=backend,
        compile_config=CompileValidationConfig(),
        original_content=SRC_MANY,
        filename="x.c",
        compile_enabled=True,
        compile_runner=_has_compiler,
        baseline_compile_runner=_resolving_runner(MANY_SYMBOLS, SRC_MANY),
    )
    assert backend.calls == 2  # first attempt + one retry, then stop
    assert result.items == []
    # Missing symbols are still reported (detection is deterministic).
    assert result.missing_symbols == MANY_SYMBOLS


# --- finish_reason marker in round diagnostics --------------------------------
#
# Truncation visibility: free-pool reasoning models can write their CoT into
# content and hit the token budget before any declaration (lua-lapi/lua-lgc:
# 0 items, response tail mid-thought). The round log's ``finish=`` marker makes
# that failure mode (finish=length) distinguishable from a format problem
# (finish=stop) in the diagnostics. Fakes bypass the usage_tracker recorder, so
# their marker must read ``unknown`` — and never a stale value from a previous
# call (reset-before-generate protocol).


class _CaptureHandler(logging.Handler):
    """Collect log records (and messages) from the repair_api.infer logger.

    Attached directly to the module logger (not the root) because main.py marks
    the ``repair_api`` parent logger propagate=False when imported elsewhere in
    the test session, which would hide the records from pytest's caplog.
    """

    def __init__(self) -> None:
        super().__init__()
        self.messages: list = []
        self.records: list = []

    def emit(self, record: logging.LogRecord) -> None:
        self.messages.append(record.getMessage())
        self.records.append(record)


def _capture_infer_handler(run) -> _CaptureHandler:
    """Run ``run()`` with an INFO capture handler on repair_api.infer."""
    lg = logging.getLogger("repair_api.infer")
    handler = _CaptureHandler()
    old_level = lg.level
    lg.addHandler(handler)
    lg.setLevel(logging.INFO)
    try:
        run()
    finally:
        lg.removeHandler(handler)
        lg.setLevel(old_level)
    return handler


def _capture_infer_logs(run) -> list:
    """Run ``run()`` and return the captured log MESSAGES."""
    return _capture_infer_handler(run).messages


def test_round_log_finish_marker_unknown_for_untracked_backend() -> None:
    from certfix.config import CompileValidationConfig

    from repair_api import usage_tracker

    # Pre-seed a stale finish_reason: _safe_generate must reset it before the
    # call, so a fake that never touches the recorder logs finish=unknown.
    usage_tracker._record_finish_reason("stop")
    messages = _capture_infer_logs(
        lambda: infer_mod.run_infer(
            backend=ScriptedBackend(GOOD_MANY_RESPONSE),
            compile_config=CompileValidationConfig(),
            original_content=SRC_MANY,
            filename="x.c",
            compile_enabled=True,
            compile_runner=_has_compiler,
            baseline_compile_runner=_resolving_runner(MANY_SYMBOLS, SRC_MANY),
        )
    )
    round_logs = [m for m in messages if "retry=False" in m]
    assert round_logs, messages
    assert all("finish=unknown" in m for m in round_logs)


def test_round_log_finish_marker_reports_recorded_reason() -> None:
    from certfix.config import CompileValidationConfig

    from repair_api import usage_tracker

    class TruncatedBackend:
        """Simulates the httpx wrap recording finish_reason=length during the
        call (same thread), with a response cut off before any declaration."""

        def generate(self, prompt: str, max_tokens: int = 1024, temperature: float = 0.0) -> str:
            usage_tracker._record_finish_reason("length")
            return "Let me think about the symbols. First, stream_t looks like"

    messages = _capture_infer_logs(
        lambda: infer_mod.run_infer(
            backend=TruncatedBackend(),
            compile_config=CompileValidationConfig(),
            original_content=SRC_MANY,
            filename="x.c",
            compile_enabled=True,
            compile_runner=_has_compiler,
            baseline_compile_runner=_resolving_runner(MANY_SYMBOLS, SRC_MANY),
        )
    )
    round_logs = [m for m in messages if "finish=length" in m]
    # Both the first attempt and the retry saw the truncated completion.
    assert len(round_logs) == 2, messages


# --- backend exception classification (Codex review round) --------------------
#
# KNOWN provider/transport failures (InferenceError, KeyError('choices'),
# httpx, JSON decode, timeouts, OSError) stay quiet: type-only at INFO, detail
# at DEBUG. Anything else is probably an internal bug: it still degrades (the
# accumulated items survive; no mid-loop 500) but logs at WARNING WITH the
# traceback so it cannot masquerade as an ordinary empty generation. And
# RequestCancelled (BaseException) must pass through untouched — a client
# disconnect aborts the loop, it is not a degrade case.


def test_unexpected_backend_exception_degrades_but_warns_with_traceback() -> None:
    from certfix.config import CompileValidationConfig

    class BuggyBackend:
        def generate(self, prompt: str, max_tokens: int = 1024, temperature: float = 0.0) -> str:
            raise ZeroDivisionError("internal bug, not a provider failure")

    results: list = []
    handler = _capture_infer_handler(
        lambda: results.append(
            infer_mod.run_infer(
                backend=BuggyBackend(),
                compile_config=CompileValidationConfig(),
                original_content=SRC_MANY,
                filename="x.c",
                compile_enabled=True,
                compile_runner=_has_compiler,
                baseline_compile_runner=_resolving_runner(MANY_SYMBOLS, SRC_MANY),
            )
        )
    )
    # Still degrades: a valid empty draft, no exception escapes.
    assert results[0].items == []
    warns = [
        r
        for r in handler.records
        if r.levelno == logging.WARNING and "UNEXPECTEDLY" in r.getMessage()
    ]
    # First attempt + the one retry, each with the traceback attached.
    assert len(warns) == 2
    assert all(r.exc_info for r in warns)
    assert all("ZeroDivisionError" in r.getMessage() for r in warns)


def test_expected_backend_exception_stays_at_info_level() -> None:
    from certfix.config import CompileValidationConfig

    handler = _capture_infer_handler(
        lambda: infer_mod.run_infer(
            backend=FlakyBackend(KeyError("choices"), KeyError("choices")),
            compile_config=CompileValidationConfig(),
            original_content=SRC_MANY,
            filename="x.c",
            compile_enabled=True,
            compile_runner=_has_compiler,
            baseline_compile_runner=_resolving_runner(MANY_SYMBOLS, SRC_MANY),
        )
    )
    # The known provider-failure class produces NO warning — type-only INFO.
    assert not [r for r in handler.records if r.levelno >= logging.WARNING]
    infos = [
        r
        for r in handler.records
        if r.levelno == logging.INFO and "generate failed kind=KeyError" in r.getMessage()
    ]
    assert len(infos) == 2  # first attempt + retry


def test_request_cancelled_propagates_through_infer() -> None:
    import pytest

    from certfix.config import CompileValidationConfig

    from repair_api import cancellation

    class CancelledBackend:
        def generate(self, prompt: str, max_tokens: int = 1024, temperature: float = 0.0) -> str:
            raise cancellation.RequestCancelled()

    # BaseException-derived: must NOT be swallowed by the degrade path — the
    # endpoint relies on it to abort the whole request on client disconnect.
    with pytest.raises(cancellation.RequestCancelled):
        infer_mod.run_infer(
            backend=CancelledBackend(),
            compile_config=CompileValidationConfig(),
            original_content=SRC_MANY,
            filename="x.c",
            compile_enabled=True,
            compile_runner=_has_compiler,
            baseline_compile_runner=_resolving_runner(MANY_SYMBOLS, SRC_MANY),
        )
