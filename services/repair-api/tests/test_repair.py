"""Repair adapter tests with fake backends (SPIKE §7, VSCODE_PIVOT_PLAN §3 c).

No LLM is called: the fix backend is a fake that returns a scripted whole-file
fixed code, and validation gates are exercised deterministically (disabled gates
or missing validation backends), so outcomes are reproducible.

Covers:
- happy path: fixed_code -> hunks in Original coordinates, status=repair_ready,
  schema-conformant candidate.
- prelude drop: a fix that rewrites a prelude line has that hunk discarded; only
  the in-function hunk survives.
- compile skipped: an absent compiler -> {compile, skipped}; status follows the
  other gates.
- validation_failed: a failing violation_removal gate -> status=validation_failed
  with hunks retained.
- repair_failed: the backend produces no fix / unchanged code -> empty hunks,
  status=repair_failed.
"""

from __future__ import annotations

import json
from pathlib import Path

import jsonschema
from conftest import FixBackendFake, make_violation, sha256_prefixed

from certfix.config import CompileValidationConfig
from certfix.core.preprocessor import Preprocessor
from repair_api import compose
from repair_api.adapter import repair as repair_adapter

REPO_ROOT = Path(__file__).resolve().parents[3]
SCHEMAS = REPO_ROOT / "packages" / "contract" / "schemas"

# A single-function file with no preamble. With empty items prelude_line_count=4,
# so Original line N maps to Augmented line N+4 (the Preprocessor blanks the 4
# prelude lines but preserves line count).
SINGLE_FN = "int f(int x) {\n    int y = x * 1000;\n    return y;\n}\n"


def _whole_file_fix(source: str, items, replace: tuple[str, str]) -> str:
    """The whole-file fixed code a CODE_ONLY model would return.

    The model is given the *processed augmented* text and returns the whole file
    with the fix applied. Build that here by preprocessing the composed Augmented
    C and applying a single ``replace`` (old -> new) on the matching line.
    """
    augmented = compose.compose_augmented_c(list(items), source)
    processed, _m, _i = Preprocessor(keep_comments=False).process(augmented)
    old, new = replace
    lines = processed.split("\n")
    idx = next(i for i, l in enumerate(lines) if old in l)
    lines[idx] = lines[idx].replace(old, new)
    return "\n".join(lines)


def _finding(rule_id: str = "INT32-C", kind: str = "violation") -> dict:
    return {
        "finding_id": "find-abc",
        "kind": kind,
        "rule_id": rule_id,
        "rule_summary": f"CERT-C {rule_id}.",
        "explanation": "e",
        "location": {"start_line": 2, "end_line": 2},
        "assumption_dependent": False,
    }


def _config(
    *,
    compile_enabled: bool = True,
    violation_removal_enabled: bool = False,
    semantic_enabled: bool = False,
) -> repair_adapter.RepairConfig:
    """A RepairConfig with gates individually toggleable (no YAML needed)."""
    return repair_adapter.RepairConfig(
        simple_repair_profile="qwen36_27b_complete_repair_rule_guided_v1",
        simple_max_tokens=4096,
        model_name="fake-model-1",
        compile_config=CompileValidationConfig(),
        compile_enabled=compile_enabled,
        violation_removal_enabled=violation_removal_enabled,
        violation_removal_method="non_target_advisory",
        violation_removal_max_tokens=512,
        violation_removal_override_denylist=["SIG34-C", "STR31-C"],
        semantic_enabled=semantic_enabled,
    )


def _no_compiler(_command: str) -> repair_adapter.CompileProbe:
    return repair_adapter.CompileProbe(available=False, detail="compiler 'gcc' not found on PATH")


def _has_compiler(_command: str) -> repair_adapter.CompileProbe:
    return repair_adapter.CompileProbe(available=True, detail="compiler 'gcc' available")


def _baseline_fails(stderr: str):
    """A baseline compile runner injecting a FAILED baseline compile (given stderr)."""

    def runner(_code: str, _config: object) -> repair_adapter.CompileOutcome:
        return repair_adapter.CompileOutcome(ok=False, stderr=stderr)

    return runner


def _baseline_passes(_code: str, _config: object) -> repair_adapter.CompileOutcome:
    """A baseline compile runner injecting a PASSING baseline compile."""
    return repair_adapter.CompileOutcome(ok=True, stderr="")


def _offline_resolver(ceiling: int = 24576) -> repair_adapter.ModelCeilingResolver:
    """A ceiling resolver that never touches the network (returns ``ceiling``).

    Tests must never make external calls: the injected fetcher returns a doc that
    parses to ``ceiling`` for every model id, so the resolver is fully offline.
    """

    def fetcher(_model_id: str, _api_key):
        return {"data": {"endpoints": [{"max_completion_tokens": ceiling}]}}

    return repair_adapter.ModelCeilingResolver(fetcher=fetcher)


def _run(
    backend,
    source: str,
    *,
    config: repair_adapter.RepairConfig,
    finding: dict,
    compile_runner=None,
    baseline_compile_runner=None,
    semantic_backend=None,
    violation_backend=None,
    items=(),
    prelude_line_count: int = 4,
    function_id: str = "fn-f-1",
    ceiling_resolver=None,
    redraw_backend=None,
) -> dict:
    return repair_adapter.run_repair(
        backend=backend,
        config=config,
        finding=finding,
        function_id=function_id,
        source_id="src-test",
        original_content=source,
        original_hash=sha256_prefixed(source),
        context_revision_id="ctxrev-test-1",
        items=list(items),
        prelude_line_count=prelude_line_count,
        compile_runner=compile_runner,
        baseline_compile_runner=baseline_compile_runner,
        semantic_backend=semantic_backend,
        violation_backend=violation_backend,
        # Default: an offline resolver returning the static-fallback ceiling, so no
        # test ever makes an external OpenRouter call.
        ceiling_resolver=ceiling_resolver or _offline_resolver(),
        redraw_backend=redraw_backend,
    )


def _val(candidate: dict, name: str) -> dict:
    for v in candidate["validations"]:
        if v["name"] == name:
            return v
    raise AssertionError(f"validation {name} not present: {candidate['validations']}")


def _load_schema(name: str) -> dict:
    return json.loads((SCHEMAS / name).read_text())


# --- happy path -------------------------------------------------------------


def test_happy_path_hunks_in_original_coords_and_repair_ready() -> None:
    fixed = _whole_file_fix(SINGLE_FN, [], ("* 1000", "* 1"))
    backend = FixBackendFake(fixed_code=fixed)
    cand = _run(
        backend,
        SINGLE_FN,
        config=_config(),
        finding=_finding(),
        compile_runner=_no_compiler,  # compile skipped; other gates disabled
    )
    assert cand["status"] == "repair_ready"
    assert len(cand["hunks"]) == 1
    h = cand["hunks"][0]
    # The changed line is Original line 2 (Augmented 6 - prelude 4).
    assert h["start_line"] == 2
    assert h["line_count"] == 1
    assert h["replacement_text"] == "    int y = x * 1;"
    assert cand["model_identity"] == "fake-model-1"
    assert cand["finding_id"] == "find-abc"
    assert cand["function_id"] == "fn-f-1"
    assert cand["original_hash"] == sha256_prefixed(SINGLE_FN)
    assert cand["context_revision_id"] == "ctxrev-test-1"


def test_happy_path_candidate_conforms_to_schema() -> None:
    fixed = _whole_file_fix(SINGLE_FN, [], ("* 1000", "* 1"))
    backend = FixBackendFake(fixed_code=fixed)
    cand = _run(backend, SINGLE_FN, config=_config(), finding=_finding(), compile_runner=_no_compiler)
    jsonschema.validate(cand, _load_schema("repair-candidate.schema.json"))


def test_hunks_apply_back_to_original_reproduces_the_fix() -> None:
    # The hunk, applied to the raw Original C, must reproduce the intended fix.
    fixed = _whole_file_fix(SINGLE_FN, [], ("* 1000", "* 1"))
    backend = FixBackendFake(fixed_code=fixed)
    cand = _run(backend, SINGLE_FN, config=_config(), finding=_finding(), compile_runner=_no_compiler)
    lines = SINGLE_FN.split("\n")
    h = cand["hunks"][0]
    idx = h["start_line"] - 1
    lines[idx : idx + h["line_count"]] = h["replacement_text"].split("\n")
    # Applied to the raw Original C, the single hunk changes only the target line.
    expected = SINGLE_FN.replace("* 1000", "* 1")
    assert "\n".join(lines) == expected


# --- prelude drop -----------------------------------------------------------


def test_prelude_hunk_is_dropped_only_in_function_hunk_survives() -> None:
    # One confirmed item so the prelude has a real (non-marker) line to rewrite.
    item = {
        "item_id": "i1",
        "kind": "external_function_declaration",
        "generated_text": "extern int g(int);",
        "current_text": "extern int g(int);",
        "provenance": "derived_from_usage",
        "user_edited": False,
        "confirmed": True,
        "rationale": "r",
        "usage_evidence": [],
    }
    # prelude_line_count = 4 + 1 (one single-line item) = 5.
    prelude_line_count = compose.synthesized_prelude_line_count([item])
    assert prelude_line_count == 5

    # Build the fixed whole-file text by editing the processed augmented text so
    # BOTH a prelude line and an in-function line change; the prelude change must
    # be discarded.
    augmented = compose.compose_augmented_c([item], SINGLE_FN)
    processed, _m, _i = Preprocessor(keep_comments=False).process(augmented)
    proc_lines = processed.split("\n")
    # The item line "extern int g(int);" sits at processed line 3 (marker lines 1
    # and 2 are blanked but present). Rewrite it (a prelude change) ...
    proc_lines[2] = "extern long g(long);"
    # ... and rewrite the in-function multiplier line (Augmented line 7 here,
    # because the extra item shifted the body down by one).
    body_idx = next(i for i, l in enumerate(proc_lines) if "* 1000" in l)
    proc_lines[body_idx] = proc_lines[body_idx].replace("* 1000", "* 1")
    fixed = "\n".join(proc_lines)

    backend = FixBackendFake(fixed_code=fixed)
    cand = _run(
        backend,
        SINGLE_FN,
        config=_config(),
        finding=_finding(),
        compile_runner=_no_compiler,
        items=[item],
        prelude_line_count=prelude_line_count,
    )
    assert cand["status"] == "repair_ready"
    # Exactly one hunk survives (the in-function one); the prelude hunk is gone.
    assert len(cand["hunks"]) == 1
    h = cand["hunks"][0]
    # Body line: Augmented (body_idx+1) - prelude 5 == Original 2.
    assert h["start_line"] == 2
    assert "* 1" in h["replacement_text"] and "* 1000" not in h["replacement_text"]
    # The explanation notes the discarded prelude change.
    assert "discarded" in cand["repair_explanation"]


# --- compile skipped --------------------------------------------------------


def test_compile_skipped_when_no_compiler_status_follows_other_gates() -> None:
    backend = FixBackendFake(fixed_code=_whole_file_fix(SINGLE_FN, [], ("* 1000", "* 1")))
    cand = _run(
        backend,
        SINGLE_FN,
        config=_config(compile_enabled=True),
        finding=_finding(),
        compile_runner=_no_compiler,
    )
    compile_v = _val(cand, "compile")
    assert compile_v["status"] == "skipped"
    assert "not found" in compile_v["detail"]
    # Other gates all pass/skip -> auto_apply -> repair_ready.
    assert cand["status"] == "repair_ready"
    assert _val(cand, "format")["status"] == "pass"


def test_compile_skipped_when_gate_disabled_in_config() -> None:
    backend = FixBackendFake(fixed_code=_whole_file_fix(SINGLE_FN, [], ("* 1000", "* 1")))
    cand = _run(
        backend,
        SINGLE_FN,
        config=_config(compile_enabled=False),
        finding=_finding(),
        compile_runner=_has_compiler,  # compiler present but gate disabled
    )
    compile_v = _val(cand, "compile")
    assert compile_v["status"] == "skipped"
    assert "disabled" in compile_v["detail"]


# --- baseline (unrepaired) compile pre-check --------------------------------


def test_baseline_compile_fail_skips_compile_with_missing_symbols() -> None:
    # The compiler is present + gate enabled, but the UNREPAIRED file does not
    # compile (missing external context). The candidate compile gate is skipped
    # with a detail naming the missing symbols; validation is not meaningful.
    backend = FixBackendFake(fixed_code=_whole_file_fix(SINGLE_FN, [], ("* 1000", "* 1")))
    stderr = (
        "augmented.c:6:5: error: unknown type name 'sensor_t'\n"
        "augmented.c:7:5: warning: implicit declaration of function 'read_sensor'\n"
        "augmented.c:8:9: error: 'THRESHOLD' undeclared (first use in this function)\n"
    )
    cand = _run(
        backend,
        SINGLE_FN,
        config=_config(compile_enabled=True),
        finding=_finding(),
        compile_runner=_has_compiler,
        baseline_compile_runner=_baseline_fails(stderr),
    )
    compile_v = _val(cand, "compile")
    assert compile_v["status"] == "skipped"
    assert "baseline (unrepaired) file does not compile" in compile_v["detail"]
    assert "Missing symbols: sensor_t, read_sensor, THRESHOLD." in compile_v["detail"]
    assert "External-context completion (planned) is required." in compile_v["detail"]
    # Hunks are still produced; the candidate is not forced to fail on the skip.
    assert len(cand["hunks"]) == 1


def test_baseline_compile_fail_without_extractable_symbols_uses_generic_detail() -> None:
    backend = FixBackendFake(fixed_code=_whole_file_fix(SINGLE_FN, [], ("* 1000", "* 1")))
    cand = _run(
        backend,
        SINGLE_FN,
        config=_config(compile_enabled=True),
        finding=_finding(),
        compile_runner=_has_compiler,
        baseline_compile_runner=_baseline_fails("augmented.c: some unrecognized error\n"),
    )
    compile_v = _val(cand, "compile")
    assert compile_v["status"] == "skipped"
    assert "baseline (unrepaired) file does not compile" in compile_v["detail"]
    # No "Missing symbols:" clause when nothing could be extracted.
    assert "Missing symbols:" not in compile_v["detail"]
    assert "External-context completion (planned) is required." in compile_v["detail"]


def test_baseline_compile_pass_runs_candidate_compile_gate(monkeypatch) -> None:
    # When the baseline compiles, the candidate compile gate runs as before. Patch
    # certfix's run_compile_check so the candidate compile is deterministic (a
    # passing result) — no real gcc, no LLM.
    from certfix.core import validation as certfix_validation
    from certfix.models import CompileCheckResult

    def fake_compile_check(_code: str, _config=None) -> CompileCheckResult:
        return CompileCheckResult(ok=True, command=["gcc"], returncode=0)

    monkeypatch.setattr(certfix_validation, "run_compile_check", fake_compile_check)

    backend = FixBackendFake(fixed_code=_whole_file_fix(SINGLE_FN, [], ("* 1000", "* 1")))
    cand = _run(
        backend,
        SINGLE_FN,
        config=_config(compile_enabled=True),
        finding=_finding(),
        compile_runner=_has_compiler,
        baseline_compile_runner=_baseline_passes,
    )
    compile_v = _val(cand, "compile")
    # Baseline passed -> candidate compile gate ran -> pass (from the fake check).
    assert compile_v["status"] == "pass"
    assert cand["status"] == "repair_ready"


# A single-function file that includes a quoted project header (absent in this
# single-file context). prelude_line_count=4, so Original line N maps to N+4.
SINGLE_FN_WITH_INCLUDE = (
    '#include "proj.h"\n'
    "int f(int x) {\n"
    "    int y = x * 1000;\n"
    "    return y;\n"
    "}\n"
)


def test_baseline_stubs_missing_local_header_and_runs_compile_gate(monkeypatch) -> None:
    # The baseline fails on a missing LOCAL header. The two-stage probe stubs it and
    # re-probes; with the stub the baseline compiles, so the candidate compile gate
    # is KEPT (not skipped) and runs with the stub dir on -I. Patch certfix's
    # run_compile_check to report the include failure until the stub dir is present,
    # then a pass — no real gcc, no LLM.
    from certfix.core import validation as certfix_validation
    from certfix.models import CompileCheckResult

    def fake_compile_check(_code: str, config=None) -> CompileCheckResult:
        include_paths = list(getattr(config, "include_paths", []) or []) if config else []
        if any("cfx-stub-" in p for p in include_paths):
            return CompileCheckResult(ok=True, command=["gcc"], returncode=0)
        return CompileCheckResult(
            ok=False,
            command=["gcc"],
            returncode=1,
            stderr='augmented.c:1:10: fatal error: proj.h: No such file or directory\n',
            missing_headers=["proj.h"],
        )

    monkeypatch.setattr(certfix_validation, "run_compile_check", fake_compile_check)

    backend = FixBackendFake(
        fixed_code=_whole_file_fix(SINGLE_FN_WITH_INCLUDE, [], ("* 1000", "* 1"))
    )
    cand = _run(
        backend,
        SINGLE_FN_WITH_INCLUDE,
        config=_config(compile_enabled=True),
        finding=_finding(),
        compile_runner=_has_compiler,
        # Use the real default runner so it calls the patched run_compile_check and
        # sees the injected stub dir on the (deep-copied) config's include_paths.
        baseline_compile_runner=repair_adapter.default_baseline_compile_runner,
    )
    compile_v = _val(cand, "compile")
    # Baseline compiled once the header was stubbed -> compile gate ran -> pass.
    assert compile_v["status"] == "pass"
    assert cand["status"] == "repair_ready"
    assert len(cand["hunks"]) == 1


def test_baseline_stub_still_fails_skips_compile_with_symbols(monkeypatch) -> None:
    # The header is stubbed, but the baseline STILL fails (a real type error the
    # stub cannot fix). The compile gate is skipped and the still-missing symbols
    # are named — the two-stage probe surfaced them where the include failure hid
    # them before.
    from certfix.core import validation as certfix_validation
    from certfix.models import CompileCheckResult

    def fake_compile_check(_code: str, config=None) -> CompileCheckResult:
        include_paths = list(getattr(config, "include_paths", []) or []) if config else []
        if any("cfx-stub-" in p for p in include_paths):
            return CompileCheckResult(
                ok=False,
                command=["gcc"],
                returncode=1,
                stderr="augmented.c:3:5: error: unknown type name 'widget_t'\n",
            )
        return CompileCheckResult(
            ok=False,
            command=["gcc"],
            returncode=1,
            stderr='augmented.c:1:10: fatal error: proj.h: No such file or directory\n',
            missing_headers=["proj.h"],
        )

    monkeypatch.setattr(certfix_validation, "run_compile_check", fake_compile_check)

    backend = FixBackendFake(
        fixed_code=_whole_file_fix(SINGLE_FN_WITH_INCLUDE, [], ("* 1000", "* 1"))
    )
    cand = _run(
        backend,
        SINGLE_FN_WITH_INCLUDE,
        config=_config(compile_enabled=True),
        finding=_finding(),
        compile_runner=_has_compiler,
        baseline_compile_runner=repair_adapter.default_baseline_compile_runner,
    )
    compile_v = _val(cand, "compile")
    assert compile_v["status"] == "skipped"
    assert "baseline (unrepaired) file does not compile" in compile_v["detail"]
    assert "Missing symbols: widget_t." in compile_v["detail"]
    # Hunks still produced; the candidate is not forced to fail on the skip.
    assert len(cand["hunks"]) == 1


def test_baseline_precheck_not_run_when_compiler_absent() -> None:
    # Compiler absent -> compile skipped for the usual reason; the baseline
    # pre-check must NOT fire (its runner is never called).
    called = {"n": 0}

    def spy(_code: str, _config: object) -> repair_adapter.CompileOutcome:
        called["n"] += 1
        return repair_adapter.CompileOutcome(ok=False, stderr="")

    backend = FixBackendFake(fixed_code=_whole_file_fix(SINGLE_FN, [], ("* 1000", "* 1")))
    cand = _run(
        backend,
        SINGLE_FN,
        config=_config(compile_enabled=True),
        finding=_finding(),
        compile_runner=_no_compiler,
        baseline_compile_runner=spy,
    )
    assert called["n"] == 0
    compile_v = _val(cand, "compile")
    assert compile_v["status"] == "skipped"
    assert "not found" in compile_v["detail"]


def test_extract_missing_symbols_dedups_and_orders() -> None:
    stderr = (
        "unknown type name 'Foo'\n"
        "unknown type name 'Foo'\n"  # duplicate
        "implicit declaration of function 'bar'\n"
        "'BAZ' undeclared (first use in this function)\n"
    )
    assert repair_adapter._extract_missing_symbols(stderr) == ["Foo", "bar", "BAZ"]


def test_extract_missing_symbols_empty_when_no_match() -> None:
    assert repair_adapter._extract_missing_symbols("nothing here") == []


# --- deterministic missing standard-include completion (sample11) ------------


# gcc's real note phrasing (curly quotes are gcc's default) for the two headers
# the INT32-C pattern omits. Header names appear in both the "defined in header"
# and the "did you forget to '#include <...>'" clauses.
_INT64_NOTE = (
    "aug.c:4:5: error: unknown type name ‘int64_t’\n"
    "aug.c:1:1: note: ‘int64_t’ is defined in header ‘<stdint.h>’; "
    "did you forget to ‘#include <stdint.h>’?\n"
)
_INTMAX_NOTE = (
    "aug.c:5:13: error: ‘INT_MAX’ undeclared (first use in this function)\n"
    "aug.c:1:1: note: ‘INT_MAX’ is defined in header ‘<limits.h>’; "
    "did you forget to ‘#include <limits.h>’?\n"
)

# A single-function file that already has one include (so the auto-added include
# anchors AFTER it). prelude_line_count=4 with empty items.
SINGLE_FN_WITH_STDIO = (
    "#include <stdio.h>\n"
    "int f(int x) {\n"
    "    int y = x * 1000;\n"
    "    return y;\n"
    "}\n"
)


def _int32_style_fix() -> str:
    """A fixed whole-file that introduces int64_t / INT_MAX but no includes.

    Mirrors the sample11 failure: the model rewrites the arithmetic to use
    ``int64_t`` and ``INT_MAX`` (needing <stdint.h> / <limits.h>) but forgets the
    ``#include`` directives.
    """
    return _whole_file_fix(
        SINGLE_FN_WITH_STDIO,
        [],
        ("    int y = x * 1000;", "    int64_t y = (int64_t)x * 1000;\n    if (y > INT_MAX) return -1;"),
    )


def _compile_fails_until_include(header_marker: str, stderr: str, needs: str = "int64_t"):
    """A gcc-like runner: the fix's new symbol needs a header the fix forgot.

    Simulates the sample11 shape realistically. The BASELINE (unrepaired
    processed text) does not use ``needs`` (e.g. ``int64_t``), so it COMPILES —
    the pre-check passes and the candidate compile gate runs. The CANDIDATE
    reduced code introduces ``needs`` but lacks ``header_marker`` (the
    ``#include`` line), so it FAILS with ``stderr`` (the gcc "defined in header"
    note); once the adapter adds ``header_marker`` it COMPILES. Code that uses
    neither always compiles.
    """

    def runner(code: str, _config: object) -> repair_adapter.CompileOutcome:
        if needs in code and header_marker not in code:
            return repair_adapter.CompileOutcome(ok=False, stderr=stderr)
        return repair_adapter.CompileOutcome(ok=True, stderr="")

    return runner


def test_extract_suggested_standard_includes_allowlist_and_order() -> None:
    # stdint.h appears before limits.h in stderr -> that order is preserved.
    stderr = _INT64_NOTE + _INTMAX_NOTE + _INT64_NOTE  # duplicate note at the end
    assert repair_adapter._extract_suggested_standard_includes(stderr) == [
        "stdint.h",
        "limits.h",
    ]


def test_extract_suggested_standard_includes_excludes_non_standard_headers() -> None:
    stderr = (
        "aug.c: note: ‘foo_t’ is defined in header ‘<myproj/foo.h>’; "
        "did you forget to ‘#include <myproj/foo.h>’?\n"
    )
    assert repair_adapter._extract_suggested_standard_includes(stderr) == []


def test_extract_suggested_standard_includes_matches_straight_quotes() -> None:
    # Some toolchains emit straight ASCII quotes; both phrasings still match.
    stderr = "note: 'size_t' is defined in header '<stddef.h>'; did you forget?\n"
    assert repair_adapter._extract_suggested_standard_includes(stderr) == ["stddef.h"]


def test_last_include_line_and_completion_hunk_anchor() -> None:
    src = '#include <stdio.h>\n#include "proj.h"\nint f(void){return 0;}\n'
    assert repair_adapter._last_include_line(src) == 2
    hunk = repair_adapter._build_include_completion_hunk(["stdint.h", "limits.h"], src)
    assert hunk is not None
    # Anchors right AFTER the last existing include (line 2) -> insert at line 3.
    assert hunk.start_line == 3
    assert hunk.line_count == 0
    assert hunk.replacement_text == "#include <stdint.h>\n#include <limits.h>"


def test_completion_hunk_anchor_is_top_when_no_include() -> None:
    hunk = repair_adapter._build_include_completion_hunk(["stdint.h"], "int f(void){return 0;}\n")
    assert hunk is not None
    assert hunk.start_line == 1
    assert hunk.line_count == 0


def test_completion_hunk_none_when_no_headers() -> None:
    assert repair_adapter._build_include_completion_hunk([], "int f(void){return 0;}\n") is None


def test_auto_include_added_and_recompile_ok_gates_continue(caplog) -> None:
    # The candidate compile gate fails with gcc's "defined in header '<stdint.h>'"
    # note; the adapter adds the include hunk, recompiles once (now ok), and the
    # compile gate reads pass with the include hunk present in the candidate.
    import logging

    backend = FixBackendFake(fixed_code=_int32_style_fix())
    with caplog.at_level(logging.INFO, logger="repair_api.adapter.repair"):
        cand = _run(
            backend,
            SINGLE_FN_WITH_STDIO,
            config=_config(compile_enabled=True),
            finding=_finding(),
            compile_runner=_has_compiler,
            baseline_compile_runner=_compile_fails_until_include(
                "#include <stdint.h>", _INT64_NOTE
            ),
        )
    compile_v = _val(cand, "compile")
    assert compile_v["status"] == "pass"
    assert cand["status"] == "repair_ready"
    # One hunk is the fix (line 3), one is the include insert anchored after the
    # existing #include <stdio.h> (Original line 1 -> insert at line 2).
    include_hunks = [h for h in cand["hunks"] if h["replacement_text"].startswith("#include")]
    assert len(include_hunks) == 1
    inc = include_hunks[0]
    assert inc["start_line"] == 2
    assert inc["line_count"] == 0
    assert inc["replacement_text"] == "#include <stdint.h>"
    # Diagnostic log present.
    assert any(
        "auto-added missing standard include(s) stdint.h -> recompile ok" in r.getMessage()
        for r in caplog.records
    )


def test_auto_include_applies_back_to_original_reproduces_include() -> None:
    # The include hunk, applied to the raw Original C, inserts the include after
    # the existing one and leaves the file compilable in intent.
    backend = FixBackendFake(fixed_code=_int32_style_fix())
    cand = _run(
        backend,
        SINGLE_FN_WITH_STDIO,
        config=_config(compile_enabled=True),
        finding=_finding(),
        compile_runner=_has_compiler,
        baseline_compile_runner=_compile_fails_until_include("#include <stdint.h>", _INT64_NOTE),
    )
    lines = SINGLE_FN_WITH_STDIO.split("\n")
    # Apply every hunk in descending start_line order (STATE_MODEL §6 semantics).
    for h in sorted(cand["hunks"], key=lambda x: x["start_line"], reverse=True):
        idx = h["start_line"] - 1
        repl = [] if (h["replacement_text"] == "" and h["line_count"] > 0) else h["replacement_text"].split("\n")
        if h["line_count"] == 0:
            lines[idx:idx] = repl
        else:
            lines[idx : idx + h["line_count"]] = repl
    applied = "\n".join(lines)
    # The include was inserted right after the original #include <stdio.h>.
    assert "#include <stdio.h>\n#include <stdint.h>\n" in applied


def test_auto_include_non_standard_header_note_adds_nothing() -> None:
    # gcc names a NON-standard header -> no auto-add; the compile gate stays fail
    # and no include hunk appears.
    non_std = (
        "aug.c: note: ‘widget_t’ is defined in header ‘<widget.h>’; "
        "did you forget to ‘#include <widget.h>’?\n"
    )
    backend = FixBackendFake(fixed_code=_int32_style_fix())
    cand = _run(
        backend,
        SINGLE_FN_WITH_STDIO,
        config=_config(compile_enabled=True),
        finding=_finding(),
        compile_runner=_has_compiler,
        # Never compiles (the marker it waits for is never inserted).
        baseline_compile_runner=_compile_fails_until_include("#include <widget.h>", non_std),
    )
    assert not any(h["replacement_text"].startswith("#include") for h in cand["hunks"])
    assert _val(cand, "compile")["status"] == "fail"


def test_no_note_leaves_hunks_unchanged() -> None:
    # A compile failure WITHOUT a "defined in header" note (a real type error) is
    # left alone: no include hunk, compile stays fail.
    plain_error = "aug.c:3:5: error: expected ‘;’ before ‘}’ token\n"
    backend = FixBackendFake(fixed_code=_int32_style_fix())
    cand = _run(
        backend,
        SINGLE_FN_WITH_STDIO,
        config=_config(compile_enabled=True),
        finding=_finding(),
        compile_runner=_has_compiler,
        baseline_compile_runner=_compile_fails_until_include("__never__", plain_error),
    )
    assert not any(h["replacement_text"].startswith("#include") for h in cand["hunks"])
    assert _val(cand, "compile")["status"] == "fail"


def test_auto_include_recompile_still_failing_keeps_hunk_and_fails(caplog) -> None:
    # The include is added but a DIFFERENT error remains, so the recompile still
    # fails. The include hunk is retained (it is a genuine requirement) and the
    # compile gate reads fail.
    import logging

    # Baseline (no int64_t) compiles so the candidate gate runs; the candidate
    # (int64_t) keeps failing even AFTER the include is added — a second,
    # unrelated error the include cannot fix. The note still names stdint.h.
    def candidate_always_fails(code: str, _config: object) -> repair_adapter.CompileOutcome:
        if "int64_t" in code:
            return repair_adapter.CompileOutcome(ok=False, stderr=_INT64_NOTE)
        return repair_adapter.CompileOutcome(ok=True, stderr="")

    backend = FixBackendFake(fixed_code=_int32_style_fix())
    with caplog.at_level(logging.INFO, logger="repair_api.adapter.repair"):
        cand = _run(
            backend,
            SINGLE_FN_WITH_STDIO,
            config=_config(compile_enabled=True),
            finding=_finding(),
            compile_runner=_has_compiler,
            baseline_compile_runner=candidate_always_fails,
        )
    include_hunks = [h for h in cand["hunks"] if h["replacement_text"].startswith("#include")]
    assert len(include_hunks) == 1  # kept despite the still-failing recompile
    assert _val(cand, "compile")["status"] == "fail"
    assert any("recompile still failing" in r.getMessage() for r in caplog.records)


def test_auto_include_abandoned_on_overlap_with_kept_hunk(caplog) -> None:
    # When the include's insertion anchor would land on a kept fix hunk, the
    # completion is abandoned (logged) rather than risk a conflicting edit. The
    # source's only include is on line 1, so the anchor is line 2; a fix hunk
    # spanning lines 1-2 (rewriting the include line and the signature together)
    # covers that anchor -> overlap.
    import logging

    src = (
        "#include <stdio.h>\n"  # line 1 — last include; anchor would be line 2
        "int f(int x) {\n"  # line 2 — a fix hunk spanning lines 1-2 covers the anchor
        "    int y = x * 1000;\n"
        "    return y;\n"
        "}\n"
    )
    # A fix that replaces Original lines 1-2 (the include + signature) with a
    # rewritten pair that introduces int64_t. Build the fixed WHOLE-FILE by
    # preprocessing the composed augmented text and replacing that 2-line region,
    # so the diff is one replace hunk over [1,2] in Original coords.
    augmented = compose.compose_augmented_c([], src)
    processed, _m, _i = Preprocessor(keep_comments=False).process(augmented)
    plines = processed.split("\n")
    sig_idx = next(i for i, l in enumerate(plines) if "int f(int x)" in l)
    # Replace the include line (sig_idx - 1) and the signature line together.
    plines[sig_idx - 1] = "#include <stdio.h>"
    plines[sig_idx] = "int64_t f(int x) {"
    fixed = "\n".join(plines)
    backend = FixBackendFake(fixed_code=fixed)
    with caplog.at_level(logging.INFO, logger="repair_api.adapter.repair"):
        cand = _run(
            backend,
            src,
            config=_config(compile_enabled=True),
            finding=_finding(),
            compile_runner=_has_compiler,
            baseline_compile_runner=_compile_fails_until_include("#include <stdint.h>", _INT64_NOTE),
        )
    assert not any(h["replacement_text"].startswith("#include <stdint.h>") for h in cand["hunks"])
    assert any(
        "auto-include completion abandoned (overlaps a kept hunk)" in r.getMessage()
        for r in caplog.records
    )


def test_auto_include_works_on_window_path() -> None:
    # D-035 window path: the reduced code is still whole-file, so the include
    # completion runs on the same recompile path. Build a large file (> 400 lines)
    # so the window repair engages, with the target function using int64_t/INT_MAX.
    head = "#include <stdio.h>\n"
    filler = "".join(f"int pad{i}(void) {{ return {i}; }}\n" for i in range(450))
    target = (
        "int g(int x) {\n"
        "    int y = x * 1000;\n"
        "    return y;\n"
        "}\n"
    )
    big_src = head + filler + target
    # The window includes the target function; the fix rewrites its body to use
    # int64_t/INT_MAX. Build the fixed WINDOW by preprocessing + replacing.
    augmented = compose.compose_augmented_c([], big_src)
    processed, _m, _i = Preprocessor(keep_comments=False).process(augmented)
    fn_line = next(i for i, l in enumerate(processed.split("\n")) if "int g(int x)" in l)
    # Resolve the target function id via inventory the same way the adapter does.
    from repair_api.functions import build_inventory

    inv = build_inventory(big_src)
    target_fn = next(fn for fn in inv if fn.start_line <= (fn_line - 4 + 1) <= fn.end_line)

    def window_backend_fixed() -> str:
        window = repair_adapter._build_repair_window(processed, 4, target_fn)
        wlines = window.text.split("\n")
        idx = next(i for i, l in enumerate(wlines) if "int y = x * 1000;" in l)
        wlines[idx] = "    int64_t y = (int64_t)x * 1000;\n    if (y > INT_MAX) return -1;"
        return "\n".join(wlines)

    backend = FixBackendFake(fixed_code=window_backend_fixed())
    cand = _run(
        backend,
        big_src,
        config=_config(compile_enabled=True),
        finding={
            "finding_id": "find-g",
            "kind": "violation",
            "rule_id": "INT32-C",
            "rule_summary": "CERT-C INT32-C.",
            "explanation": "e",
            "location": {"start_line": target_fn.start_line, "end_line": target_fn.end_line},
            "assumption_dependent": False,
        },
        function_id=target_fn.function_id,
        compile_runner=_has_compiler,
        baseline_compile_runner=_compile_fails_until_include("#include <stdint.h>", _INT64_NOTE),
    )
    include_hunks = [h for h in cand["hunks"] if h["replacement_text"].startswith("#include")]
    assert len(include_hunks) == 1
    assert include_hunks[0]["replacement_text"] == "#include <stdint.h>"
    assert _val(cand, "compile")["status"] == "pass"


def test_truncate_detail_appends_marker() -> None:
    short = "x" * 10
    assert repair_adapter._truncate_detail(short) == short
    long = "y" * 600
    out = repair_adapter._truncate_detail(long)
    assert out.endswith("… (truncated)")
    assert out.startswith("y" * 500)
    assert len(out) == 500 + len("… (truncated)")


def test_disabled_gates_are_not_run_status() -> None:
    backend = FixBackendFake(fixed_code=_whole_file_fix(SINGLE_FN, [], ("* 1000", "* 1")))
    cand = _run(backend, SINGLE_FN, config=_config(), finding=_finding(), compile_runner=_no_compiler)
    assert _val(cand, "violation_removal")["status"] == "not_run"
    assert _val(cand, "semantic")["status"] == "not_run"
    # regression has no contributing gate -> skipped.
    assert _val(cand, "regression")["status"] == "skipped"


# --- validation_failed ------------------------------------------------------


def test_validation_failed_when_violation_removal_fails_hunks_retained() -> None:
    # violation_removal enabled but no violation backend -> violation_removed False
    # (deterministic, no LLM) -> auto_apply_ok False -> validation_failed.
    backend = FixBackendFake(fixed_code=_whole_file_fix(SINGLE_FN, [], ("* 1000", "* 1")))
    cand = _run(
        backend,
        SINGLE_FN,
        config=_config(violation_removal_enabled=True),
        finding=_finding(),
        compile_runner=_no_compiler,
        violation_backend=None,
    )
    assert cand["status"] == "validation_failed"
    # Hunks are retained so the reviewer can still inspect the diff.
    assert len(cand["hunks"]) == 1
    vr = _val(cand, "violation_removal")
    assert vr["status"] == "skipped"  # no backend supplied -> skipped in the map
    jsonschema.validate(cand, _load_schema("repair-candidate.schema.json"))


# --- repair_failed ----------------------------------------------------------


def test_repair_failed_when_backend_returns_empty() -> None:
    backend = FixBackendFake(raw="")  # no code block at all -> UNRESOLVED / None
    cand = _run(backend, SINGLE_FN, config=_config(), finding=_finding(), compile_runner=_no_compiler)
    assert cand["status"] == "repair_failed"
    assert cand["hunks"] == []
    assert cand["validations"] == []


def test_repair_failed_when_fix_is_unchanged() -> None:
    # Backend returns the (comment-stripped) code unchanged -> NO_VIOLATIONS ->
    # run_simple_repair returns None -> repair_failed.
    augmented = compose.compose_augmented_c([], SINGLE_FN)
    processed, _m, _i = Preprocessor(keep_comments=False).process(augmented)
    backend = FixBackendFake(fixed_code=processed)
    cand = _run(backend, SINGLE_FN, config=_config(), finding=_finding(), compile_runner=_no_compiler)
    assert cand["status"] == "repair_failed"
    assert cand["hunks"] == []


# --- cosmetic hunk filter ---------------------------------------------------

# A commented Original whose comments live INSIDE the function body (so the
# prelude offset never straddles them), with comment-bearing lines SEPARATED by
# plain code lines so difflib aligns each into its own discrete hunk. Original
# lines (1-indexed):
#   1 int f(int x) {
#   2     int a = 1;
#   3     int scale = 1000;  /* scale factor */   <- trailing comment (cosmetic)
#   4     int b = 2;
#   5     /* explain base */                        <- comment-only line (cosmetic)
#   6     int base = 5;
#   7     int y = x * scale + base;                 <- the buggy multiplier line
#   8     return y;
#   9 }
# The harness (run_simple_repair -> parse_code_only_repair) strips comments from
# the model's whole-file output, so the trailing comment on line 3 and the
# comment-only line 5 come back comment-free -> cosmetic hunks the filter drops;
# only a real code change (line 7) survives.
COMMENTED_FN = (
    "int f(int x) {\n"
    "    int a = 1;\n"
    "    int scale = 1000;  /* scale factor */\n"
    "    int b = 2;\n"
    "    /* explain base */\n"
    "    int base = 5;\n"
    "    int y = x * scale + base;\n"
    "    return y;\n"
    "}\n"
)


def _cosmetic_backend(*, code_change: tuple[str, str]) -> FixBackendFake:
    """A fake fix backend that returns the whole file with a real ``code_change``.

    The whole-file text is the processed augmented COMMENTED_FN with the real
    ``code_change`` (old -> new) applied. run_simple_repair then re-strips comments
    (its CODE_ONLY path), reproducing the live cosmetic-hunk pattern: the trailing
    comment on line 3 and the comment-only line 5 come back as comment-only diffs
    vs the raw Original, which the cosmetic filter must drop.
    """
    return FixBackendFake(fixed_code=_whole_file_fix(COMMENTED_FN, [], code_change))


def test_cosmetic_comment_only_replacement_and_deletion_hunks_are_dropped() -> None:
    # A real fix on the multiplier line (line 7) plus the two comment-only cosmetic
    # hunks (trailing comment on line 3; comment-only line 5). Only the real fix
    # survives; both cosmetic hunks are filtered out.
    backend = _cosmetic_backend(code_change=("x * scale", "x * 1"))
    cand = _run(backend, COMMENTED_FN, config=_config(), finding=_finding(), compile_runner=_no_compiler)

    assert cand["status"] == "repair_ready"
    assert len(cand["hunks"]) == 1
    h = cand["hunks"][0]
    # Original line 7 is the multiplier line (1-indexed).
    assert h["start_line"] == 7
    assert "* 1" in h["replacement_text"] and "scale" not in h["replacement_text"]
    # Both the trailing-comment (replacement) and comment-only (deletion) hunks
    # were cosmetic -> 2 filtered out.
    assert "2 cosmetic change(s) were filtered out." in cand["repair_explanation"]


def test_substantive_hunk_with_comment_diff_is_kept() -> None:
    # The multiplier line (line 7) has no comment, but change it AND it must be
    # kept because its normal forms differ (real code changed). The two cosmetic
    # comment hunks (lines 3 and 5) are still dropped.
    backend = _cosmetic_backend(code_change=("x * scale + base", "x * 2 + base"))
    cand = _run(backend, COMMENTED_FN, config=_config(), finding=_finding(), compile_runner=_no_compiler)

    assert cand["status"] == "repair_ready"
    assert len(cand["hunks"]) == 1
    assert "* 2" in cand["hunks"][0]["replacement_text"]
    assert "cosmetic change(s) were filtered out." in cand["repair_explanation"]


def test_all_cosmetic_hunks_yields_repair_failed() -> None:
    # The model deletes only the comment-only line (line 5) and makes no real code
    # change. After the harness strips comments this differs from the processed
    # text (one fewer line) -> a FixResult IS produced, but every resulting Original
    # hunk (the line-3 trailing comment + the line-5 deletion) is comment-only
    # cosmetic churn -> all dropped by the cosmetic filter -> repair_failed.
    augmented = compose.compose_augmented_c([], COMMENTED_FN)
    processed, _m, _i = Preprocessor(keep_comments=False).process(augmented)
    lines = processed.split("\n")
    # The comment-only line 5 is blank in `processed`; delete that blank body line
    # (skip the prelude blanks and the trailing blank).
    comment_idx = next(
        i for i, l in enumerate(lines) if l.strip() == "" and 4 < i < len(lines) - 2
    )
    del lines[comment_idx]
    backend = FixBackendFake(fixed_code="\n".join(lines))
    cand = _run(backend, COMMENTED_FN, config=_config(), finding=_finding(), compile_runner=_no_compiler)

    assert cand["status"] == "repair_failed"
    assert cand["hunks"] == []
    assert cand["validations"] == []
    assert "no substantive change" in cand["repair_explanation"]


# --- compile include paths (D-020) ------------------------------------------


def _capturing_baseline(store: dict):
    """A compile runner that records every (code, config) it is handed; passes.

    The FIRST call is the baseline pre-check (on the unmodified processed text);
    the SECOND is the whole-file candidate compile gate — since D-033 the
    candidate compile runs through this same injectable runner in the adapter,
    no longer inside validate_fix_result.
    """
    store.setdefault("calls", [])

    def runner(code: str, compile_config: object) -> repair_adapter.CompileOutcome:
        store["calls"].append((code, compile_config))
        # First call = the baseline pre-check (kept under its historic key).
        store.setdefault("baseline_config", compile_config)
        return repair_adapter.CompileOutcome(ok=True, stderr="")

    return runner


def test_include_paths_merge_reaches_baseline_and_candidate_compile() -> None:
    # The request's include paths must be merged into the compile config used for
    # BOTH the baseline pre-check and the whole-file candidate compile gate.
    store: dict = {}
    cand = repair_adapter.run_repair(
        backend=FixBackendFake(fixed_code=_whole_file_fix(SINGLE_FN, [], ("* 1000", "* 1"))),
        config=_config(compile_enabled=True),
        finding=_finding(),
        function_id="fn-f-1",
        source_id="src-test",
        original_content=SINGLE_FN,
        original_hash=sha256_prefixed(SINGLE_FN),
        context_revision_id="ctxrev-test-1",
        items=[],
        prelude_line_count=4,
        compile_runner=_has_compiler,
        baseline_compile_runner=_capturing_baseline(store),
        ceiling_resolver=_offline_resolver(),
        compile_include_paths=["/proj/include", "/proj/src"],
    )
    # Two compile calls: baseline pre-check, then the candidate whole-file gate.
    assert len(store["calls"]) == 2
    baseline_config = store["calls"][0][1]
    candidate_config = store["calls"][1][1]
    assert list(baseline_config.include_paths) == ["/proj/include", "/proj/src"]
    assert list(candidate_config.include_paths) == ["/proj/include", "/proj/src"]
    assert cand["status"] == "repair_ready"
    assert _val(cand, "compile")["status"] == "pass"


def test_include_paths_append_to_config_existing_dedup_order() -> None:
    # Merge appends AFTER the config's own include_paths, de-dups, preserves order.
    config = _config(compile_enabled=True)
    config = repair_adapter.RepairConfig(
        **{**config.__dict__, "compile_config": CompileValidationConfig(include_paths=["/a", "/b"])}
    )
    store: dict = {}
    cand = repair_adapter.run_repair(
        backend=FixBackendFake(fixed_code=_whole_file_fix(SINGLE_FN, [], ("* 1000", "* 1"))),
        config=config,
        finding=_finding(),
        function_id="fn-f-1",
        source_id="src-test",
        original_content=SINGLE_FN,
        original_hash=sha256_prefixed(SINGLE_FN),
        context_revision_id="ctxrev-test-1",
        items=[],
        prelude_line_count=4,
        compile_runner=_has_compiler,
        baseline_compile_runner=_capturing_baseline(store),
        ceiling_resolver=_offline_resolver(),
        # "/b" duplicates an existing path; " " is blank; order must be preserved.
        compile_include_paths=["/b", "/proj/include", "  ", "/proj/include"],
    )
    assert list(store["baseline_config"].include_paths) == ["/a", "/b", "/proj/include"]
    # The caller's own CompileValidationConfig is NOT mutated (deep-copied on merge).
    assert config.compile_config.include_paths == ["/a", "/b"]


def test_include_paths_unset_leaves_config_object_unchanged() -> None:
    # No include paths passed -> the same compile_config object is used verbatim
    # (identity), matching the pre-D-020 behaviour exactly.
    config = _config(compile_enabled=True)
    store: dict = {}
    repair_adapter.run_repair(
        backend=FixBackendFake(fixed_code=_whole_file_fix(SINGLE_FN, [], ("* 1000", "* 1"))),
        config=config,
        finding=_finding(),
        function_id="fn-f-1",
        source_id="src-test",
        original_content=SINGLE_FN,
        original_hash=sha256_prefixed(SINGLE_FN),
        context_revision_id="ctxrev-test-1",
        items=[],
        prelude_line_count=4,
        compile_runner=_has_compiler,
        baseline_compile_runner=_capturing_baseline(store),
        ceiling_resolver=_offline_resolver(),
        # compile_include_paths omitted entirely.
    )
    # Same object identity: no copy, no include_paths mutation (default []).
    assert store["baseline_config"] is config.compile_config
    assert config.compile_config.include_paths == []


def test_include_paths_all_blank_is_a_no_op() -> None:
    # Only blank/whitespace entries -> nothing to merge -> config used verbatim.
    config = _config(compile_enabled=True)
    store: dict = {}
    repair_adapter.run_repair(
        backend=FixBackendFake(fixed_code=_whole_file_fix(SINGLE_FN, [], ("* 1000", "* 1"))),
        config=config,
        finding=_finding(),
        function_id="fn-f-1",
        source_id="src-test",
        original_content=SINGLE_FN,
        original_hash=sha256_prefixed(SINGLE_FN),
        context_revision_id="ctxrev-test-1",
        items=[],
        prelude_line_count=4,
        compile_runner=_has_compiler,
        baseline_compile_runner=_capturing_baseline(store),
        ceiling_resolver=_offline_resolver(),
        compile_include_paths=["", "   "],
    )
    assert store["baseline_config"] is config.compile_config


def test_merge_compile_config_helper_dedup_and_no_mutation() -> None:
    # Direct unit test of the merge helper: append + dedup + order, no mutation.
    cfg = CompileValidationConfig(include_paths=["/a"])
    merged = repair_adapter._merge_compile_config(cfg, ["/b", "/a", "/c", "/b"])
    assert merged.include_paths == ["/a", "/b", "/c"]
    assert cfg.include_paths == ["/a"]  # original untouched
    assert merged is not cfg
    # No extras -> the same object back (no copy).
    assert repair_adapter._merge_compile_config(cfg, []) is cfg
    assert repair_adapter._merge_compile_config(cfg, ["/a"]) is cfg  # already present


def test_real_fix_plus_cosmetic_mix_status_follows_validator() -> None:
    # Real fix (1 hunk) + 2 cosmetic hunks: status follows the validator (not the
    # cosmetic filter), hunks are only the real fix, explanation notes the count.
    backend = _cosmetic_backend(code_change=("x * scale", "x * 1"))
    # violation_removal enabled + no backend -> validation_failed (deterministic).
    cand = _run(
        backend,
        COMMENTED_FN,
        config=_config(violation_removal_enabled=True),
        finding=_finding(),
        compile_runner=_no_compiler,
        violation_backend=None,
    )
    assert cand["status"] == "validation_failed"  # follows the validator, not the filter
    assert len(cand["hunks"]) == 1
    assert "* 1" in cand["hunks"][0]["replacement_text"]
    assert "cosmetic change(s) were filtered out." in cand["repair_explanation"]
    jsonschema.validate(cand, _load_schema("repair-candidate.schema.json"))


# --- function-scope hunk restriction (D-022) --------------------------------

# A two-function file with a global #include. Original lines (1-indexed):
#   1  #include <stdio.h>           <- global scope
#   2  int f(int x) {               <- target function f: lines 2-5
#   3      int y = x * 1000;
#   4      return y;
#   5  }
#   6  (blank)                      <- global gap
#   7  int g(int z) {               <- other function g: lines 7-10
#   8      int w = z + 1;
#   9      return w;
#  10  }
# With empty items the prelude is 4 lines, so Original line N == processed N+4.
TWO_FN = (
    "#include <stdio.h>\n"
    "int f(int x) {\n"
    "    int y = x * 1000;\n"
    "    return y;\n"
    "}\n"
    "\n"
    "int g(int z) {\n"
    "    int w = z + 1;\n"
    "    return w;\n"
    "}\n"
)


def _two_fn_fixed(*replaces, add_include: bool = False) -> str:
    """Whole-file fixed text: apply each (old -> new) to the processed TWO_FN.

    Mirrors what a whole-file CODE_ONLY model would emit. When ``add_include`` is
    set, a NEW global #include line is inserted right after the existing include
    (a legitimate file-level change that scope restriction must KEEP).
    """
    augmented = compose.compose_augmented_c([], TWO_FN)
    processed, _m, _i = Preprocessor(keep_comments=False).process(augmented)
    lines = processed.split("\n")
    for old, new in replaces:
        idx = next(i for i, l in enumerate(lines) if old in l)
        lines[idx] = lines[idx].replace(old, new)
    if add_include:
        inc_idx = next(i for i, l in enumerate(lines) if "#include <stdio.h>" in l)
        lines.insert(inc_idx + 1, "#include <stdlib.h>")
    return "\n".join(lines)


def test_scope_drops_other_function_keeps_target_and_global() -> None:
    # The model touches three regions: the target function f (line 3), a global
    # #include insertion, and the OTHER function g (line 8). Only the g change is
    # dropped; the f fix and the global insert survive.
    fixed = _two_fn_fixed(
        ("* 1000", "* 1"),  # target function f (Original line 3) -> keep
        ("z + 1", "z + 2"),  # other function g (Original line 8) -> drop
        add_include=True,  # new global #include -> keep
    )
    backend = FixBackendFake(fixed_code=fixed)
    cand = _run(
        backend,
        TWO_FN,
        config=_config(),
        finding=_finding(),
        compile_runner=_no_compiler,
        function_id="fn-f-2",  # f is the target
    )
    assert cand["status"] == "repair_ready"
    starts = sorted(h["start_line"] for h in cand["hunks"])
    texts = "\n".join(h["replacement_text"] for h in cand["hunks"])
    # Two hunks kept: the global #include insert (anchored at Original line 2) and
    # the f-body fix (Original line 3). The g-body change (line 8) is gone.
    assert len(cand["hunks"]) == 2
    assert "* 1" in texts and "* 1000" not in texts  # f fix kept
    assert "#include <stdlib.h>" in texts  # global include kept
    assert "z + 2" not in texts  # g change dropped
    assert all(s <= 5 for s in starts)  # nothing from g's range (7-10) survives
    assert "1 change(s) outside the target function were discarded." in cand["repair_explanation"]


def test_scope_all_hunks_in_other_function_yields_repair_failed() -> None:
    # The model only changes the OTHER function g; nothing touches f (the target)
    # or global scope -> every hunk dropped -> repair_failed.
    # Both changes live inside g (Original lines 8 and 9); none in f or global.
    fixed = _two_fn_fixed(("z + 1", "z + 2"), ("return w", "return w + 0"))
    backend = FixBackendFake(fixed_code=fixed)
    cand = _run(
        backend,
        TWO_FN,
        config=_config(),
        finding=_finding(),
        compile_runner=_no_compiler,
        function_id="fn-f-2",  # target is f, but all changes are in g
    )
    assert cand["status"] == "repair_failed"
    assert cand["hunks"] == []
    assert cand["validations"] == []
    assert "target function" in cand["repair_explanation"]


def test_scope_drops_whole_file_replacement_hunk() -> None:
    # A degenerate model output that replaces (nearly) the whole file yields one
    # giant hunk spanning BOTH functions. It intersects the target f — but also
    # g, so it is out of scope and must be dropped -> repair_failed (observed
    # live on zlib-deflate: an L1/count-2186 near-empty replacement passed the
    # old intersects-target-first check and wiped every function).
    backend = FixBackendFake(fixed_code="typedef int zlib_stub;\n")
    cand = _run(
        backend,
        TWO_FN,
        config=_config(),
        finding=_finding(),
        compile_runner=_no_compiler,
        function_id="fn-f-2",
    )
    assert cand["status"] == "repair_failed"
    assert cand["hunks"] == []
    assert "target function" in cand["repair_explanation"]


class _CapturingSemantic:
    """A semantic backend that records the fixed_code embedded in its prompt.

    The semantic gate builds its prompt from ``fix_result.fixed_code``; capturing
    the prompt lets a test assert exactly which whole-file text reached validation
    (the reduced version, not the LLM's raw output). ``generate`` returns a fixed
    PASS verdict so the gate is deterministic (no LLM).
    """

    def __init__(self) -> None:
        self.prompts: list[str] = []

    def generate(self, prompt: str, max_tokens: int = 4096, temperature: float = 0.0) -> str:
        self.prompts.append(prompt)
        # A full semantic auto-apply PASS verdict (all required fields present).
        return (
            '{"parse_ok": true, "auto_apply_ok": true, "behavior_preserved": true, '
            '"material_behavior_delta": false, "uncertain_material_behavior": false, '
            '"fail_type": "none", "confidence": "high", "reason": "ok"}'
        )

    def is_available(self) -> bool:
        return True


def test_validation_runs_on_reduced_code_not_whole_llm_output() -> None:
    # The reduced fixed code handed to the gates must contain ONLY the kept hunks
    # (target f + global), never the dropped other-function (g) change. Capture the
    # fixed_code the semantic gate sees via its prompt and assert g's edit is absent.
    fixed = _two_fn_fixed(
        ("* 1000", "* 1"),  # f -> keep
        ("z + 1", "z + 99"),  # g -> drop (a very visible marker)
    )
    backend = FixBackendFake(fixed_code=fixed)
    semantic = _CapturingSemantic()
    cand = _run(
        backend,
        TWO_FN,
        config=_config(semantic_enabled=True),
        finding=_finding(),
        compile_runner=_no_compiler,  # compile skipped so semantic still runs
        semantic_backend=semantic,
        function_id="fn-f-2",
    )
    assert cand["status"] == "repair_ready"
    # The semantic gate ran and saw the reduced code.
    assert semantic.prompts, "semantic gate did not run"
    seen = "\n".join(semantic.prompts)
    assert "z + 99" not in seen  # the dropped g change never reached validation
    assert "x * 1" in seen  # the kept f fix did
    # And the candidate's own hunks likewise exclude g.
    assert all("z + 99" not in h["replacement_text"] for h in cand["hunks"])


def test_function_id_mismatch_resolves_via_finding_location() -> None:
    # An unknown function_id but a finding.location inside g -> g becomes the
    # target; the f change is dropped, g's change is kept.
    fixed = _two_fn_fixed(
        ("* 1000", "* 1"),  # f -> now OUTSIDE the target (dropped)
        ("z + 1", "z + 2"),  # g -> target (kept)
    )
    backend = FixBackendFake(fixed_code=fixed)
    finding = _finding()
    finding["location"] = {"start_line": 8, "end_line": 8}  # inside g (lines 7-10)
    cand = _run(
        backend,
        TWO_FN,
        config=_config(),
        finding=finding,
        compile_runner=_no_compiler,
        function_id="fn-does-not-exist",  # forces the location fallback
    )
    assert cand["status"] == "repair_ready"
    texts = "\n".join(h["replacement_text"] for h in cand["hunks"])
    assert "z + 2" in texts  # g kept
    assert "* 1" not in texts and "* 1000" not in texts  # f dropped
    assert "1 change(s) outside the target function were discarded." in cand["repair_explanation"]


def test_unresolvable_target_degrades_to_legacy_no_restriction(caplog) -> None:
    # Neither function_id nor finding.location resolves to a function -> scope
    # restriction is SKIPPED (legacy whole-file behaviour) with a warning. Both the
    # f and g changes survive.
    import logging

    fixed = _two_fn_fixed(("* 1000", "* 1"), ("z + 1", "z + 2"))
    backend = FixBackendFake(fixed_code=fixed)
    finding = _finding()
    finding["location"] = {"start_line": 6, "end_line": 6}  # global gap, no function
    with caplog.at_level(logging.WARNING, logger="repair_api.adapter.repair"):
        cand = _run(
            backend,
            TWO_FN,
            config=_config(),
            finding=finding,
            compile_runner=_no_compiler,
            function_id="fn-nope",
        )
    assert cand["status"] == "repair_ready"
    texts = "\n".join(h["replacement_text"] for h in cand["hunks"])
    assert "* 1" in texts and "z + 2" in texts  # both survive (no restriction)
    assert "outside the target function" not in cand["repair_explanation"]
    assert any("target function unresolved" in r.message for r in caplog.records)


def test_apply_hunks_to_processed_matches_core_semantics() -> None:
    # The reduced-code reconstruction helper must match packages/core applyHunks:
    # descending order, insert (line_count=0) before start_line, replace n lines.
    processed = "p0\np1\np2\np3\np4\np5"  # prelude p0,p1; body p2..p5
    prelude = 2
    hunks = [
        repair_adapter._Hunk(start_line=1, line_count=1, replacement_text="B0"),  # replace body line1
        repair_adapter._Hunk(start_line=3, line_count=0, replacement_text="INS"),  # insert before body line3
    ]
    out = repair_adapter._apply_hunks_to_processed(processed, hunks, prelude)
    # Original body lines: 1->p2, 2->p3, 3->p4, 4->p5. Replace #1 (p2->B0); insert
    # "INS" before #3 (p4).
    assert out == "p0\np1\nB0\np3\nINS\np4\np5"


# --- judgment-reason wiring (D-023) -----------------------------------------


class _FailingSemantic:
    """A semantic backend that returns a FAIL verdict carrying a human reason.

    The reason flows: run_semantic_auto_apply_check -> SemanticAutoApplyResult
    (fail) -> _semantic_auto_to_semantic_result -> fix_result.semantic_result.reason
    -> _map_validations semantic-fail detail. Deterministic; no LLM.
    """

    def __init__(self, reason: str) -> None:
        self._reason = reason

    def generate(self, prompt: str, max_tokens: int = 4096, temperature: float = 0.0) -> str:
        return (
            '{"parse_ok": true, "auto_apply_ok": false, "behavior_preserved": false, '
            '"material_behavior_delta": true, "uncertain_material_behavior": false, '
            '"fail_type": "semantic_changed", "confidence": "high", '
            f'"reason": {json.dumps(self._reason)}}}'
        )

    def is_available(self) -> bool:
        return True


def test_semantic_fail_detail_carries_certfix_reason() -> None:
    # A real semantic FAIL verdict with a reason -> the semantic validation detail
    # is that reason (not the fixed phrase), so the reviewer sees WHY (D-023).
    reason = "The fix drops the early-return guard, changing behaviour for raw == 0."
    fixed = _whole_file_fix(SINGLE_FN, [], ("* 1000", "* 1"))
    backend = FixBackendFake(fixed_code=fixed)
    cand = _run(
        backend,
        SINGLE_FN,
        config=_config(semantic_enabled=True),
        finding=_finding(),
        compile_runner=_no_compiler,  # compile skipped so semantic runs
        semantic_backend=_FailingSemantic(reason),
    )
    sem = _val(cand, "semantic")
    assert sem["status"] == "fail"
    assert sem["detail"] == reason
    # A failing judgment gate -> validation_failed status (hunks retained).
    assert cand["status"] == "validation_failed"
    assert len(cand["hunks"]) == 1


def test_semantic_fail_detail_falls_back_to_verdict_name_when_reason_blank() -> None:
    # No reason text -> the detail names the verdict so the row is never empty.
    from certfix.models import SemanticCheckResult, SemanticVerdict

    detail = repair_adapter._semantic_fail_detail(
        SemanticCheckResult(
            verdict=SemanticVerdict.FAIL,
            semantic_preserved=False,
            target_violation_removed=True,
            new_regression=False,
            reason="",
        )
    )
    assert detail == "semantic verdict: FAIL"


def test_semantic_fail_detail_is_truncated() -> None:
    from certfix.models import SemanticCheckResult, SemanticVerdict

    long_reason = "x" * 600
    detail = repair_adapter._semantic_fail_detail(
        SemanticCheckResult(
            verdict=SemanticVerdict.FAIL,
            semantic_preserved=False,
            target_violation_removed=True,
            new_regression=False,
            reason=long_reason,
        )
    )
    assert detail.endswith("… (truncated)")
    assert len(detail) == repair_adapter._DETAIL_LIMIT + len("… (truncated)")


def test_violation_removal_fail_detail_prefers_reason_then_evidence_then_count() -> None:
    from certfix.models import ViolationRemovalResult

    def _vr(**kw) -> ViolationRemovalResult:
        base = dict(removed=False, target_rule_id="INT32-C", remaining_violations=[])
        base.update(kw)
        return ViolationRemovalResult(**base)

    # reason wins
    assert (
        repair_adapter._violation_removal_fail_detail(_vr(reason="target INT32-C still present"))
        == "target INT32-C still present"
    )
    # evidence when no reason
    assert (
        repair_adapter._violation_removal_fail_detail(
            _vr(remaining_evidence="line 5: raw * 1000 still overflows")
        )
        == "line 5: raw * 1000 still overflows"
    )
    # count when neither, but violations remain
    assert (
        repair_adapter._violation_removal_fail_detail(
            _vr(remaining_violations=[make_violation("INT32-C", 5), make_violation("INT32-C", 6)])
        )
        == "2 target violation(s) remain after the fix"
    )
    # nothing available -> legacy phrase
    assert (
        repair_adapter._violation_removal_fail_detail(_vr())
        == "target violation may remain after the fix"
    )
    # None (backend-absent path) -> legacy phrase
    assert (
        repair_adapter._violation_removal_fail_detail(None)
        == "target violation may remain after the fix"
    )


def test_regression_fail_detail_summarises_programmatic_findings() -> None:
    from certfix.models import ProgrammaticFinding

    findings = [
        ProgrammaticFinding(
            check_id="over_deletion",
            rule_id="INT32-C",
            verdict="fail",
            reason="removed 4 lines with no replacement",
        ),
        ProgrammaticFinding(
            check_id="over_deletion",
            rule_id="INT32-C",
            verdict="fail",
            reason="second one",
        ),
        ProgrammaticFinding(
            check_id="control_flow_changed",
            rule_id="INT32-C",
            verdict="fail",
            reason="",
        ),
    ]

    class _V:
        programmatic_findings = findings

    detail = repair_adapter._regression_fail_detail(_V(), None, None)
    assert "programmatic findings (3)" in detail
    assert "over_deletion x2" in detail
    assert "control_flow_changed" in detail
    assert "removed 4 lines with no replacement" in detail  # first finding's reason


def test_regression_fail_detail_falls_back_to_semantic_then_removal_reason() -> None:
    from certfix.models import SemanticCheckResult, SemanticVerdict, ViolationRemovalResult

    class _V:
        programmatic_findings: list = []

    # No programmatic findings -> semantic reason.
    sem = SemanticCheckResult(
        verdict=SemanticVerdict.FAIL,
        semantic_preserved=True,
        target_violation_removed=True,
        new_regression=True,
        reason="introduces a use-after-free on the error path",
    )
    assert (
        repair_adapter._regression_fail_detail(_V(), sem, None)
        == "introduces a use-after-free on the error path"
    )
    # No semantic reason -> removal reason.
    removal = ViolationRemovalResult(
        removed=False,
        target_rule_id="INT32-C",
        remaining_violations=[],
        reason="introduced a non-target STR31-C violation",
    )
    sem_blank = SemanticCheckResult(
        verdict=SemanticVerdict.FAIL,
        semantic_preserved=True,
        target_violation_removed=True,
        new_regression=False,
        reason="",
    )
    assert (
        repair_adapter._regression_fail_detail(_V(), sem_blank, removal)
        == "introduced a non-target STR31-C violation"
    )
    # Nothing at all -> legacy phrase.
    assert (
        repair_adapter._regression_fail_detail(_V(), sem_blank, None)
        == "the fix may introduce a regression"
    )


# --- dynamic repair max_tokens (task §1) ------------------------------------


def test_estimate_code_tokens_is_chars_over_3_5_rounded_up() -> None:
    import math

    assert repair_adapter.estimate_code_tokens("") == 0
    code = "x" * 35
    assert repair_adapter.estimate_code_tokens(code) == math.ceil(35 / 3.5)
    # Rounds UP (never truncates the estimate).
    assert repair_adapter.estimate_code_tokens("x" * 36) == math.ceil(36 / 3.5)


def test_estimate_repair_max_tokens_small_file_clamps_to_floor() -> None:
    # A tiny file: code_tokens*1.3 + 4096 << floor -> the floor (8192) wins.
    budget = repair_adapter.estimate_repair_max_tokens("int f(){return 0;}\n", base=4096)
    assert budget == 8192


def test_estimate_repair_max_tokens_medium_file_scales_between_floor_and_ceiling() -> None:
    # A mid-size file lands strictly between floor and ceiling and matches the
    # explicit formula: ceil(chars/3.5)*1.3 (int) + 4096.
    code = "y" * 21280
    code_tokens = repair_adapter.estimate_code_tokens(code)
    expected = int(code_tokens * 1.3) + 4096
    budget = repair_adapter.estimate_repair_max_tokens(code, base=4096)
    assert budget == expected
    assert 8192 < budget < 24576


def test_estimate_repair_max_tokens_large_file_clamps_to_ceiling() -> None:
    # A large file sized so the unclamped want lands exactly at the ceiling
    # (24576) -> clamped to ceiling, and NOT flagged as would-truncate (the guard
    # only fires when want strictly exceeds the ceiling).
    code = "z" * 55136
    budget = repair_adapter.estimate_repair_max_tokens(code, base=4096)
    assert budget == 24576
    assert repair_adapter.repair_budget_exceeds_ceiling(code) is False


def test_estimate_repair_max_tokens_adds_reasoning_allowance() -> None:
    # D-034: the budget is content(x1.3) + reasoning_allowance + 4096. The
    # allowance is the fix role's EXPLICIT reasoning cap (effort-style reasoning
    # adapted to any budget and starved the content — measured 3/3 finish=length
    # with reasoning 47k/87k/58k — so 12b's content doubling is withdrawn).
    code = "y" * 21280
    code_tokens = repair_adapter.estimate_code_tokens(code)
    plain = repair_adapter.estimate_repair_max_tokens(code, base=4096, ceiling=200_000)
    with_cap = repair_adapter.estimate_repair_max_tokens(
        code, base=4096, ceiling=200_000, reasoning_allowance=24576
    )
    assert plain == int(code_tokens * 1.3) + 4096  # off -> no allowance term
    assert with_cap == int(code_tokens * 1.3) + 24576 + 4096
    # Ceiling still clamps the capped budget.
    assert (
        repair_adapter.estimate_repair_max_tokens(
            code, base=4096, ceiling=10_000, reasoning_allowance=24576
        )
        == 10_000
    )
    # The oversize fail-fast guard stays content-only (no allowance term).
    assert repair_adapter.repair_budget_exceeds_ceiling(code, ceiling=15_000) is False


def test_reasoning_effort_to_cap_conversion() -> None:
    # D-034: every effort level maps to its cap; other keys are preserved and
    # the input dict is never mutated.
    convert = repair_adapter.reasoning_effort_to_cap
    for effort, cap in [
        ("max", 32768),
        ("xhigh", 24576),
        ("high", 16384),
        ("medium", 8192),
        ("low", 4096),
        ("minimal", 1024),
    ]:
        src = {"provider": {"order": ["DeepInfra"]}, "reasoning": {"effort": effort}}
        out = convert(src)
        assert out["reasoning"] == {"max_tokens": cap}
        assert out["provider"] == {"order": ["DeepInfra"]}  # other keys preserved
        assert src["reasoning"] == {"effort": effort}  # input not mutated


def test_reasoning_effort_to_cap_passthroughs() -> None:
    convert = repair_adapter.reasoning_effort_to_cap
    # off stays off (identity).
    off = {"reasoning": {"enabled": False}}
    assert convert(off) is off
    # An explicit max_tokens is respected verbatim.
    explicit = {"reasoning": {"max_tokens": 2048}}
    assert convert(explicit) is explicit
    # No reasoning block / non-dict extra_body: unchanged.
    plain = {"provider": {}}
    assert convert(plain) is plain
    assert convert(None) is None
    # Unknown effort level: fail-open (provider sees the original).
    unknown = {"reasoning": {"effort": "ultra"}}
    assert convert(unknown) is unknown


def test_fix_reasoning_cap_reads_allowance() -> None:
    cap = repair_adapter._fix_reasoning_cap
    # Converted (normal) form reads directly.
    assert cap({"reasoning": {"max_tokens": 24576}}) == 24576
    # Effort form (unconverted RepairConfig, e.g. tests) converts defensively.
    assert cap({"reasoning": {"effort": "medium"}}) == 8192
    # Off / absent / malformed -> 0 (no allowance).
    assert cap({"reasoning": {"enabled": False}}) == 0
    assert cap({"reasoning": {}}) == 0
    assert cap({}) == 0
    assert cap(None) == 0
    assert cap({"reasoning": {"max_tokens": True}}) == 0
    assert cap({"reasoning": {"max_tokens": -5}}) == 0


def test_estimate_repair_max_tokens_base_acts_as_floor() -> None:
    # A configured simple_max_tokens larger than the default floor is honoured:
    # the dynamic budget never drops below max(floor, base).
    budget = repair_adapter.estimate_repair_max_tokens("int f(){return 0;}\n", base=12000)
    assert budget == 12000
    # base below the default floor -> the default floor still applies.
    assert repair_adapter.estimate_repair_max_tokens("int f(){}\n", base=1000) == 8192


def test_estimate_repair_max_tokens_custom_bounds() -> None:
    # floor/ceiling/reasoning_overhead are all overridable (pure function).
    tiny = repair_adapter.estimate_repair_max_tokens(
        "int f(){}\n", base=0, reasoning_overhead=100, floor=500, ceiling=1000
    )
    assert tiny == 500  # clamps up to the custom floor
    big = repair_adapter.estimate_repair_max_tokens(
        "x" * 100000, base=0, reasoning_overhead=100, floor=500, ceiling=1000
    )
    assert big == 1000  # clamps down to the custom ceiling


def test_repair_budget_exceeds_ceiling_boundary() -> None:
    # At/under ceiling -> False; a file whose whole-file regeneration cannot fit
    # even at the ceiling -> True. 55136 chars lands the want exactly at the
    # ceiling (boundary, not exceeding); 56000 tips it over.
    assert repair_adapter.repair_budget_exceeds_ceiling("z" * 55136) is False
    assert repair_adapter.repair_budget_exceeds_ceiling("z" * 56000) is True


# --- model output-ceiling resolver (task §1 correction) ---------------------


def _endpoints_doc(*endpoints: dict) -> dict:
    """An OpenRouter models/{id}/endpoints response body (data.endpoints[])."""
    return {"data": {"endpoints": list(endpoints)}}


def test_ceiling_resolver_auto_routing_takes_max_across_endpoints() -> None:
    # No provider pin (auto-routing) -> the MAX max_completion_tokens across all
    # endpoints (the best a routed request could hit).
    doc = _endpoints_doc(
        {"provider_name": "DeepInfra", "max_completion_tokens": 16384},
        {"provider_name": "Together", "max_completion_tokens": 32768},
        {"provider_name": "Fireworks", "max_completion_tokens": 8192},
    )
    resolver = repair_adapter.ModelCeilingResolver(fetcher=lambda _m, _k: doc)
    ceiling = resolver.resolve("deepseek/deepseek-v4", extra_body={}, api_key="k")
    assert ceiling == 32768


def test_ceiling_resolver_pinned_provider_takes_that_providers_value() -> None:
    # A pinned provider (allow_fallbacks False, single order entry) -> exactly that
    # provider's endpoint value, ignoring larger endpoints on other providers.
    doc = _endpoints_doc(
        {"provider_name": "DeepInfra", "max_completion_tokens": 16384},
        {"provider_name": "Together", "max_completion_tokens": 32768},
    )
    resolver = repair_adapter.ModelCeilingResolver(fetcher=lambda _m, _k: doc)
    extra_body = {"provider": {"order": ["DeepInfra"], "allow_fallbacks": False}}
    ceiling = resolver.resolve("deepseek/deepseek-v4", extra_body=extra_body, api_key="k")
    assert ceiling == 16384  # DeepInfra's, not the larger Together value


def test_ceiling_resolver_field_missing_falls_back_to_static() -> None:
    # Endpoints present but none carry max_completion_tokens -> static fallback.
    doc = _endpoints_doc({"provider_name": "DeepInfra"}, {"provider_name": "Together"})
    resolver = repair_adapter.ModelCeilingResolver(fetcher=lambda _m, _k: doc)
    ceiling = resolver.resolve("deepseek/deepseek-v4", extra_body={}, api_key="k")
    assert ceiling == 24576


def test_ceiling_resolver_pinned_provider_absent_falls_back_to_static() -> None:
    # Pinned to a provider that has no endpoint in the doc -> static fallback (we
    # do NOT silently use another provider's larger value for a pinned request).
    doc = _endpoints_doc({"provider_name": "Together", "max_completion_tokens": 32768})
    resolver = repair_adapter.ModelCeilingResolver(fetcher=lambda _m, _k: doc)
    extra_body = {"provider": {"order": ["DeepInfra"], "allow_fallbacks": False}}
    ceiling = resolver.resolve("deepseek/deepseek-v4", extra_body=extra_body, api_key="k")
    assert ceiling == 24576


def test_ceiling_resolver_fetch_failure_falls_back_to_static() -> None:
    # The fetcher returns None (non-200 / timeout / parse failure) -> static fallback.
    resolver = repair_adapter.ModelCeilingResolver(fetcher=lambda _m, _k: None)
    ceiling = resolver.resolve("deepseek/deepseek-v4", extra_body={}, api_key="k")
    assert ceiling == 24576


def test_ceiling_resolver_no_api_key_skips_fetch() -> None:
    # Without an API key the resolver must NOT call the fetcher (no unauthenticated
    # / test network call) and returns the static fallback.
    called = {"n": 0}

    def fetcher(_m, _k):
        called["n"] += 1
        return _endpoints_doc({"max_completion_tokens": 99999})

    resolver = repair_adapter.ModelCeilingResolver(fetcher=fetcher)
    ceiling = resolver.resolve("deepseek/deepseek-v4", extra_body={}, api_key=None)
    assert ceiling == 24576
    assert called["n"] == 0


def test_ceiling_resolver_caches_per_model_id() -> None:
    # The fetch happens at most once per model id (cached process-wide).
    called = {"n": 0}

    def fetcher(_m, _k):
        called["n"] += 1
        return _endpoints_doc({"max_completion_tokens": 20000})

    resolver = repair_adapter.ModelCeilingResolver(fetcher=fetcher)
    a = resolver.resolve("m/x", extra_body={}, api_key="k")
    b = resolver.resolve("m/x", extra_body={}, api_key="k")
    assert a == b == 20000
    assert called["n"] == 1  # second call served from cache


def test_ceiling_resolver_unknown_model_returns_fallback_without_fetch() -> None:
    called = {"n": 0}

    def fetcher(_m, _k):
        called["n"] += 1
        return None

    resolver = repair_adapter.ModelCeilingResolver(fetcher=fetcher)
    assert resolver.resolve("unknown", extra_body={}, api_key="k") == 24576
    assert resolver.resolve("", extra_body={}, api_key="k") == 24576
    assert called["n"] == 0


def test_pinned_provider_name_detection() -> None:
    # Single pinned provider, fallbacks off -> the name.
    assert (
        repair_adapter._pinned_provider_name(
            {"provider": {"order": ["DeepInfra"], "allow_fallbacks": False}}
        )
        == "DeepInfra"
    )
    # Fallbacks allowed -> not pinned.
    assert (
        repair_adapter._pinned_provider_name(
            {"provider": {"order": ["DeepInfra"], "allow_fallbacks": True}}
        )
        is None
    )
    # Multiple providers -> not pinned (auto among them).
    assert (
        repair_adapter._pinned_provider_name(
            {"provider": {"order": ["DeepInfra", "Together"], "allow_fallbacks": False}}
        )
        is None
    )
    # No provider block / not a dict -> None.
    assert repair_adapter._pinned_provider_name({}) is None
    assert repair_adapter._pinned_provider_name(None) is None


def test_ceiling_resolver_drives_oversize_guard_by_model_output_length() -> None:
    # A file that fits under a large model ceiling but would exceed a small one:
    # the guard's decision follows the RESOLVED model ceiling, not a constant.
    # ~40k chars: want ≈ ceil(40000/3.5)*1.3 + 4096 ≈ 19k tokens.
    source = "int f(int x) {\n" + "    x = x + 1;\n" * 2300 + "    return x;\n}\n"
    fixed_backend = FixBackendFake(fixed_code="int f(int x){return x;}\n")

    # Small ceiling (8000) -> file exceeds it -> repair_failed, backend not called.
    small = _offline_resolver(ceiling=8000)
    # Force a key so the injected fetcher actually runs (resolver skips on no key).
    # Pre-seed to avoid the no-key skip. Round 19: the cache key includes the
    # provider pin ("auto" when none) so a pin change never reuses a stale ceiling.
    small._cache["fake-model-1::auto"] = 8000
    cand_small = _run(
        FixBackendFake(fixed_code="x"),
        source,
        config=_config(),
        finding=_finding(),
        compile_runner=_no_compiler,
        ceiling_resolver=small,
    )
    assert cand_small["status"] == "repair_failed"
    assert "exceeds the output budget of the current model" in cand_small["repair_explanation"]

    # Large ceiling (100000) -> the same file fits -> the guard does NOT fire (it
    # proceeds to the backend; here the fix is unchanged so it's repair_failed for a
    # DIFFERENT reason, but crucially NOT the oversize message).
    large = _offline_resolver(ceiling=100000)
    large._cache["fake-model-1::auto"] = 100000
    cand_large = _run(
        fixed_backend,
        source,
        config=_config(),
        finding=_finding(),
        compile_runner=_no_compiler,
        ceiling_resolver=large,
    )
    assert "exceeds the output budget of the current model" not in cand_large["repair_explanation"]


class _CapturingFixBackend:
    """A fix backend that records the max_tokens it was called with.

    Returns a scripted whole-file fixed code (fenced) so run_simple_repair parses
    a real candidate; ``seen_max_tokens`` lets a test assert the DYNAMIC budget
    (not the config floor) reached the backend. No LLM.
    """

    def __init__(self, fixed_code: str) -> None:
        self._out = "```c\n" + fixed_code + "\n```\n"
        self.seen_max_tokens: list[int] = []

    def generate(self, prompt: str, max_tokens: int = 4096, temperature: float = 0.0) -> str:
        self.seen_max_tokens.append(max_tokens)
        return self._out

    def is_available(self) -> bool:
        return True


def test_dynamic_budget_reaches_run_simple_repair() -> None:
    # The repair path must size max_tokens from the input, not pass the config
    # floor verbatim. For SINGLE_FN (tiny) the dynamic budget clamps to the floor
    # (8192), which is still > the config simple_max_tokens (4096) — proving the
    # dynamic sizing (not the raw config value) reached the backend.
    fixed = _whole_file_fix(SINGLE_FN, [], ("* 1000", "* 1"))
    backend = _CapturingFixBackend(fixed)
    cand = _run(backend, SINGLE_FN, config=_config(), finding=_finding(), compile_runner=_no_compiler)
    assert cand["status"] == "repair_ready"
    assert backend.seen_max_tokens, "backend was never called"
    # Floor (8192), not the config simple_max_tokens (4096).
    assert backend.seen_max_tokens[0] == 8192


def test_oversize_file_returns_repair_failed_without_calling_backend() -> None:
    # A file too large to regenerate whole even at the ceiling -> repair_failed is
    # returned BEFORE the backend is called (no wasted spend). The explanation is
    # the honest "file too large" guidance with an approximate line count.
    called = {"n": 0}

    class _SpyBackend:
        def generate(self, prompt: str, max_tokens: int = 4096, temperature: float = 0.0) -> str:
            called["n"] += 1
            return "```c\nint f(){}\n```\n"

        def is_available(self) -> bool:
            return True

    # ~70k chars of C over many lines -> exceeds the static-fallback ceiling
    # (no OpenRouter key/fetch in tests -> the resolver falls back to 24576).
    big_source = "int f(int x) {\n" + "    x = x + 1;\n" * 4000 + "    return x;\n}\n"
    backend = _SpyBackend()
    cand = _run(backend, big_source, config=_config(), finding=_finding(), compile_runner=_no_compiler)
    assert called["n"] == 0  # LLM never called
    assert cand["status"] == "repair_failed"
    assert cand["hunks"] == []
    assert cand["validations"] == []
    # Model-dependent wording (no concrete line-count / token numbers).
    assert "exceeds the output budget of the current model" in cand["repair_explanation"]
    assert "whole-file repair" in cand["repair_explanation"]
    assert "Split the function/file" in cand["repair_explanation"]


# --- truncation-honest explanation (task §2) --------------------------------


def test_truncation_finish_reason_yields_truncation_explanation() -> None:
    # When the backend produces no parseable fix AND the last completion's
    # finish_reason was "length", the explanation is the truncation-honest version
    # (not the generic "no fix"). Simulate by setting the thread-local recorder.
    from repair_api import usage_tracker

    class _EmptyThenTruncated:
        """Returns no code block, and marks the completion as length-truncated."""

        def generate(self, prompt: str, max_tokens: int = 4096, temperature: float = 0.0) -> str:
            usage_tracker._record_finish_reason("length")
            return ""  # no fenced code -> run_simple_repair returns None

        def is_available(self) -> bool:
            return True

    usage_tracker.reset_finish_reason()
    cand = _run(
        _EmptyThenTruncated(), SINGLE_FN, config=_config(), finding=_finding(), compile_runner=_no_compiler
    )
    usage_tracker.reset_finish_reason()
    assert cand["status"] == "repair_failed"
    assert "truncated" in cand["repair_explanation"]
    assert "too large for whole-file repair at the current budget" in cand["repair_explanation"]
    assert cand["hunks"] == []


def test_stop_finish_reason_yields_generic_no_fix_explanation() -> None:
    # finish_reason "stop" (natural completion) -> the generic "no fix" phrasing,
    # NOT the truncation version. The repair path resets finish_reason before the
    # call, so a stale "length" from a prior request cannot leak in.
    from repair_api import usage_tracker

    class _EmptyStop:
        def generate(self, prompt: str, max_tokens: int = 4096, temperature: float = 0.0) -> str:
            usage_tracker._record_finish_reason("stop")
            return ""

        def is_available(self) -> bool:
            return True

    usage_tracker.reset_finish_reason()
    cand = _run(
        _EmptyStop(), SINGLE_FN, config=_config(), finding=_finding(), compile_runner=_no_compiler
    )
    usage_tracker.reset_finish_reason()
    assert cand["status"] == "repair_failed"
    assert "did not produce a fix" in cand["repair_explanation"]
    assert "truncated" not in cand["repair_explanation"]


def test_repair_resets_finish_reason_so_stale_length_does_not_leak() -> None:
    # A stale "length" left over from a PRIOR request must not be read for a
    # repair whose own completion did NOT set a finish_reason. run_repair resets
    # before the call, so the empty/no-fix path reads None -> generic phrasing.
    from repair_api import usage_tracker

    usage_tracker._record_finish_reason("length")  # stale from a "previous" request
    # A backend that returns no code and does NOT touch the recorder.
    backend = FixBackendFake(raw="")
    cand = _run(backend, SINGLE_FN, config=_config(), finding=_finding(), compile_runner=_no_compiler)
    usage_tracker.reset_finish_reason()
    assert cand["status"] == "repair_failed"
    # The stale "length" was cleared by run_repair -> generic (not truncation).
    assert "did not produce a fix" in cand["repair_explanation"]
    assert "truncated" not in cand["repair_explanation"]


# --- validation window (D-033) -----------------------------------------------
#
# The LLM gates must see a function/hunk-scale WINDOW, not the whole file
# (zlib-deflate live: whole-file inputs made the semantic reviewer claim two
# real hunks were "identical to the original"); the compile gate must still see
# the whole reduced file (the TU is what compiles).

# f (Original lines 2-5) followed by filler globals and a far sentinel (line 16)
# that lies well outside f ± 3 context lines — it must never reach an LLM gate.
WINDOW_SRC = (
    "#include <stdio.h>\n"  # 1
    "int f(int x) {\n"  # 2
    "    int y = x * 1000;\n"  # 3
    "    return y;\n"  # 4
    "}\n"  # 5
    + "".join(f"int filler_{i} = {i};\n" for i in range(10))  # 6-15
    + "int far_sentinel_variable = 424242;\n"  # 16
)


def _window_target():
    from repair_api.functions import build_inventory

    return next(fn for fn in build_inventory(WINDOW_SRC) if fn.name == "f")


def test_validation_window_intervals_function_only() -> None:
    # A hunk inside the target function -> ONE merged interval: the function's
    # augmented range padded by the context lines (clamped at the top).
    hunks = [repair_adapter._Hunk(start_line=3, line_count=1, replacement_text="    int y = x * 1;")]
    intervals = repair_adapter._validation_window_intervals(hunks, _window_target(), 4, 20)
    # f Original 2-5 -> aug 6-9; hunk aug 7-7 (subsumed); pad ±3 -> (3, 12).
    assert intervals == [(3, 12)]


def test_validation_window_intervals_function_plus_file_level_hunk() -> None:
    # A second, file-level hunk far from the function -> a SECOND interval; the
    # two do not merge across the gap.
    hunks = [
        repair_adapter._Hunk(start_line=3, line_count=1, replacement_text="    int y = x * 1;"),
        repair_adapter._Hunk(start_line=16, line_count=1, replacement_text="int far_sentinel_variable = 5;"),
    ]
    intervals = repair_adapter._validation_window_intervals(hunks, _window_target(), 4, 20)
    # far hunk aug 20-20, pad ±3 clamped to 20 lines -> (17, 20).
    assert intervals == [(3, 12), (17, 20)]


def test_validation_window_intervals_hunks_only_when_target_unresolved() -> None:
    # No resolved target function -> the window is built from the hunk regions.
    hunks = [repair_adapter._Hunk(start_line=16, line_count=1, replacement_text="int x = 5;")]
    intervals = repair_adapter._validation_window_intervals(hunks, None, 4, 20)
    assert intervals == [(17, 20)]


def test_extract_validation_window_original_and_fixed_sides() -> None:
    augmented = compose.compose_augmented_c([], WINDOW_SRC)
    processed, _m, _i = Preprocessor(keep_comments=False).process(augmented)
    hunks = [
        repair_adapter._Hunk(start_line=3, line_count=1, replacement_text="    int y = x * 1;"),
        # An insertion before Original line 4 (inside f).
        repair_adapter._Hunk(start_line=4, line_count=0, replacement_text="    if (y > 10) y = 10;"),
    ]
    win_o, win_f = repair_adapter._extract_validation_window(processed, hunks, 4, _window_target())
    # Original side: verbatim slice (fix absent); fixed side: hunks applied.
    assert "x * 1000" in win_o and "x * 1000" not in win_f
    assert "x * 1;" in win_f and "x * 1;" not in win_o
    assert "if (y > 10) y = 10;" in win_f and "y = 10" not in win_o
    # The far sentinel is outside the window on BOTH sides.
    assert "far_sentinel_variable" not in win_o
    assert "far_sentinel_variable" not in win_f
    # The fixed side equals the corresponding region of the reduced whole file:
    # every window-fixed line is present in the reduced file.
    reduced = repair_adapter._apply_hunks_to_processed(processed, hunks, 4)
    reduced_lines = set(reduced.split("\n"))
    assert all(line in reduced_lines for line in win_f.split("\n"))


def test_semantic_gate_sees_window_not_whole_file() -> None:
    # The semantic reviewer's prompt must contain the fix but NOT the far
    # sentinel — proof that the gate got the window, not the 2-sided whole file.
    fixed = _whole_file_fix(WINDOW_SRC, [], ("* 1000", "* 1"))
    semantic = _CapturingSemantic()
    cand = _run(
        FixBackendFake(fixed_code=fixed),
        WINDOW_SRC,
        config=_config(semantic_enabled=True),
        finding=_finding(),
        compile_runner=_no_compiler,  # compile skipped so semantic still runs
        semantic_backend=semantic,
        function_id="fn-f-2",
    )
    assert cand["status"] == "repair_ready"
    assert semantic.prompts, "semantic gate did not run"
    seen = "\n".join(semantic.prompts)
    assert "x * 1" in seen  # the fix is visible in the window
    assert "far_sentinel_variable" not in seen  # whole-file content is not


def test_candidate_compile_gate_receives_whole_reduced_file() -> None:
    # The compile gate must still get the WHOLE reduced file (D-033): the second
    # compile call's code carries both the fix and the far sentinel.
    store: dict = {}
    cand = _run(
        FixBackendFake(fixed_code=_whole_file_fix(WINDOW_SRC, [], ("* 1000", "* 1"))),
        WINDOW_SRC,
        config=_config(compile_enabled=True),
        finding=_finding(),
        compile_runner=_has_compiler,
        baseline_compile_runner=_capturing_baseline(store),
        function_id="fn-f-2",
    )
    assert cand["status"] == "repair_ready"
    assert len(store["calls"]) == 2  # baseline pre-check + candidate whole-file gate
    candidate_code = store["calls"][1][0]
    assert "x * 1;" in candidate_code  # the fix was applied
    assert "x * 1000" not in candidate_code
    assert "far_sentinel_variable" in candidate_code  # whole file, not the window


# --- validation window: neighbour-function pad clipping (play.c) --------------
#
# Live failure (play.c, 33 lines): the ±3 pad around the target function pulled
# the ADJACENT function average_two into the validation window, so the removal
# detector attributed average_two's own unfixed signed addition to the target
# ("average_two still performs signed addition that can overflow") and both
# violation_removal and semantic failed. The pad must stop at another function's
# boundary; non-function gap lines stay includable.

# Target function flanked by neighbours within pad distance (Original coords):
# above 3-5, target 7-10, below 12-14, gap lines 6 and 11.
NEIGHBOUR_SRC = (
    "#include <stdio.h>\n"  # 1
    "\n"  # 2
    "int above(int a) {\n"  # 3
    "    return a + 1;\n"  # 4
    "}\n"  # 5
    "\n"  # 6
    "int target_fn(int r) {\n"  # 7
    "    int y = r * 1000;\n"  # 8
    "    return y;\n"  # 9
    "}\n"  # 10
    "\n"  # 11
    "int below(int b) {\n"  # 12
    "    return b - 1;\n"  # 13
    "}\n"  # 14
)


def _neighbour_inventory():
    from repair_api.functions import build_inventory

    return build_inventory(NEIGHBOUR_SRC)


def test_validation_window_pad_clipped_out_of_neighbour_functions() -> None:
    # Pad ±3 around the target seed would reach into BOTH neighbours; the clip
    # stops at their boundaries while keeping the non-function gap lines.
    inv = _neighbour_inventory()
    target = next(fn for fn in inv if fn.name == "target_fn")
    hunks = [repair_adapter._Hunk(start_line=8, line_count=1, replacement_text="    int y = r * 1;")]
    intervals = repair_adapter._validation_window_intervals(hunks, target, 4, 19, inv)
    # target Original 7-10 -> aug 11-14; pad -> (8,17); above aug 7-9 clips lo to
    # 10; below aug 16-18 clips hi to 15 -> one interval keeping only the gap
    # lines (Original 6 and 11) around the target.
    assert intervals == [(10, 15)]


def test_validation_window_seed_is_never_clipped() -> None:
    # A file-level hunk between two functions: its own seed line stays even
    # though both pad directions clip at the neighbours' boundaries.
    inv = _neighbour_inventory()
    target = next(fn for fn in inv if fn.name == "target_fn")
    hunks = [
        repair_adapter._Hunk(start_line=8, line_count=1, replacement_text="    int y = r * 1;"),
        # A global insertion at the gap line between above and target (Original 6).
        repair_adapter._Hunk(start_line=6, line_count=0, replacement_text="#define SCALE 1"),
    ]
    intervals = repair_adapter._validation_window_intervals(hunks, target, 4, 19, inv)
    # The insertion seeds aug line 10 (Original 6); its pad is clipped by
    # ``above`` (aug 7-9) but the seed line itself survives and merges with the
    # target interval.
    assert intervals == [(10, 15)]


def test_validation_window_no_clipping_when_target_unresolved() -> None:
    # Unresolved target -> legacy behaviour even when an inventory is supplied
    # (mirrors the D-022 scope-filter degradation).
    inv = _neighbour_inventory()
    hunks = [repair_adapter._Hunk(start_line=8, line_count=1, replacement_text="x")]
    intervals = repair_adapter._validation_window_intervals(hunks, None, 4, 19, inv)
    # Seed aug 12 (Original 8), pad ±3 unclipped -> (9, 15).
    assert intervals == [(9, 15)]


class _CapturingRemovalDetector:
    """A removal-gate detector fake recording every code text it scans.

    Models play.c: the ADJACENT function has its own unfixed violation, so the
    detector reports the target rule whenever the scanned text contains the
    neighbour (``anchor``). If the validation window leaks the neighbour in,
    the removal gate misattributes that violation to the target and fails.
    """

    def __init__(self, anchor: str) -> None:
        self.seen: list[str] = []
        self._anchor = anchor

    def detect(self, code: str, rules=None):  # noqa: ANN001 — certfix duck type
        self.seen.append(code)
        if self._anchor in code:
            return [make_violation("INT32-C", 1)]
        return []

    def is_available(self) -> bool:
        return True


def test_removal_and_semantic_window_excludes_adjacent_function() -> None:
    # play.c-shaped integration: the target fix is valid, but the neighbour
    # average_two (within pad distance) carries a similar unfixed violation.
    # Neither the removal detector nor the semantic reviewer may see the
    # neighbour; both gates must judge the target only and pass.
    playc_src = (
        "#include <stdio.h>\n"  # 1
        "\n"  # 2
        "int average_two(int a, int b) {\n"  # 3
        "    return (a + b) / 2;\n"  # 4 — unfixed signed addition (neighbour's own)
        "}\n"  # 5
        "\n"  # 6
        "int scale_reading(int r) {\n"  # 7
        "    int y = r * 1000;\n"  # 8 — the target violation
        "    return y;\n"  # 9
        "}\n"  # 10
    )
    from repair_api.functions import build_inventory

    target = next(fn for fn in build_inventory(playc_src) if fn.name == "scale_reading")
    finding = _finding()
    finding["location"] = {"start_line": 8, "end_line": 8}
    fixed = _whole_file_fix(playc_src, [], ("* 1000", "* 1"))
    # Anchor on the neighbour's BODY content ``(a + b)``: the un-clipped ±3 pad
    # reached Original lines 4-5 (the addition), not the signature line, so the
    # body text is what discriminates the old bleed from the clipped window.
    detector = _CapturingRemovalDetector(anchor="(a + b)")
    semantic = _CapturingSemantic()
    cand = _run(
        FixBackendFake(fixed_code=fixed),
        playc_src,
        config=_config(violation_removal_enabled=True, semantic_enabled=True),
        finding=finding,
        compile_runner=_no_compiler,  # compile skipped; LLM gates still run
        violation_backend=detector,
        semantic_backend=semantic,
        function_id=target.function_id,
    )
    # No line of the neighbour ever reached either gate's input.
    assert detector.seen, "removal detector did not run"
    assert all("(a + b)" not in code and "average_two" not in code for code in detector.seen)
    assert semantic.prompts, "semantic gate did not run"
    assert all("(a + b)" not in p and "average_two" not in p for p in semantic.prompts)
    # The fix itself IS visible to the gates.
    assert any("r * 1;" in code for code in detector.seen)
    # No misattribution -> both judgment gates pass -> repair_ready.
    assert _val(cand, "violation_removal")["status"] == "pass"
    assert _val(cand, "semantic")["status"] == "pass"
    assert cand["status"] == "repair_ready"


def test_compile_fail_withholds_llm_gates_and_maps_fail() -> None:
    # Whole-file candidate compile FAILS -> no LLM gate spend (the semantic
    # backend must never be called), and the gates map exactly as certfix's own
    # compile-failed path did: compile fail (stderr detail), semantic fail
    # ("prior gates failed"), status validation_failed with hunks retained.
    class BoomSemantic:
        def generate(self, prompt: str, max_tokens: int = 4096, temperature: float = 0.0) -> str:
            raise AssertionError("semantic backend must not be called when compile failed")

        def is_available(self) -> bool:
            return True

    calls = {"n": 0}

    def runner(_code: str, _config: object) -> repair_adapter.CompileOutcome:
        calls["n"] += 1
        if calls["n"] == 1:
            return repair_adapter.CompileOutcome(ok=True, stderr="")  # baseline passes
        return repair_adapter.CompileOutcome(
            ok=False, stderr="augmented.c:7:9: error: candidate does not compile"
        )

    cand = _run(
        FixBackendFake(fixed_code=_whole_file_fix(WINDOW_SRC, [], ("* 1000", "* 1"))),
        WINDOW_SRC,
        config=_config(compile_enabled=True, semantic_enabled=True),
        finding=_finding(),
        compile_runner=_has_compiler,
        baseline_compile_runner=runner,
        semantic_backend=BoomSemantic(),
        function_id="fn-f-2",
    )
    compile_v = _val(cand, "compile")
    assert compile_v["status"] == "fail"
    assert "candidate does not compile" in compile_v["detail"]
    sem = _val(cand, "semantic")
    assert sem["status"] == "fail"  # prior-gate-failed shape, no LLM call made
    assert cand["status"] == "validation_failed"
    assert len(cand["hunks"]) == 1


# --- LLM-failure protection on the repair path (round 10) ---------------------
#
# Live finding: a provider returned HTTP 200 with the JSON body cut off at char
# 4653; certfix's `response.json()` raised JSONDecodeError and /repair returned
# a raw 500. run_repair must map ANY Exception from the LLM-dependent calls
# (run_simple_repair, the validate_fix_result LLM gates) to a candidate-shaped
# failure — 500s show raw HTTP errors in the extension, while a candidate rides
# the existing failure UX. RequestCancelled (BaseException) must pass through.


class _RaisingFixBackend:
    """A fix backend whose generate raises a scripted exception."""

    def __init__(self, exc: BaseException) -> None:
        self._exc = exc

    def generate(self, prompt: str, max_tokens: int = 4096, temperature: float = 0.0) -> str:
        raise self._exc

    def is_available(self) -> bool:
        return True


def _capture_adapter_logs(run):
    """Run ``run()`` with an INFO capture handler on repair_api.adapter.repair.

    Attached directly to the module logger (main.py sets propagate=False on the
    ``repair_api`` parent when imported elsewhere in the session, which would
    hide records from pytest's caplog). Returns the captured records.
    """
    import logging

    records: list = []

    class Capture(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            records.append(record)

    lg = logging.getLogger("repair_api.adapter.repair")
    handler = Capture()
    old_level = lg.level
    lg.addHandler(handler)
    lg.setLevel(logging.INFO)
    try:
        run()
    finally:
        lg.removeHandler(handler)
        lg.setLevel(old_level)
    return records


def test_repair_backend_json_decode_error_yields_repair_failed() -> None:
    # The observed live failure class: truncated 200 body -> JSONDecodeError.
    exc = json.JSONDecodeError("Expecting value", "x" * 4700, 4653)
    results: list = []
    records = _capture_adapter_logs(
        lambda: results.append(
            _run(
                _RaisingFixBackend(exc),
                SINGLE_FN,
                config=_config(),
                finding=_finding(),
                compile_runner=_no_compiler,
            )
        )
    )
    cand = results[0]
    assert cand["status"] == "repair_failed"
    assert cand["hunks"] == []
    assert cand["validations"] == []
    assert "usually transient" in cand["repair_explanation"]
    # Known provider class -> type-only INFO, never WARNING.
    assert not [r for r in records if r.levelno >= 30]  # no WARNING+
    infos = [r for r in records if "LLM call failed kind=JSONDecodeError" in r.getMessage()]
    assert infos and all(r.levelno == 20 for r in infos)  # INFO


def test_repair_backend_unknown_exception_warns_and_repair_failed() -> None:
    results: list = []
    records = _capture_adapter_logs(
        lambda: results.append(
            _run(
                _RaisingFixBackend(ZeroDivisionError("internal bug")),
                SINGLE_FN,
                config=_config(),
                finding=_finding(),
                compile_runner=_no_compiler,
            )
        )
    )
    cand = results[0]
    assert cand["status"] == "repair_failed"
    assert cand["hunks"] == []
    warns = [r for r in records if r.levelno == 30 and "UNEXPECTEDLY" in r.getMessage()]
    assert len(warns) == 1
    assert warns[0].exc_info  # traceback attached
    assert "ZeroDivisionError" in warns[0].getMessage()


def test_repair_request_cancelled_propagates() -> None:
    import pytest

    from repair_api import cancellation

    # BaseException-derived: must NOT be swallowed into repair_failed — the
    # endpoint relies on it to abort the request on client disconnect.
    with pytest.raises(cancellation.RequestCancelled):
        _run(
            _RaisingFixBackend(cancellation.RequestCancelled()),
            SINGLE_FN,
            config=_config(),
            finding=_finding(),
            compile_runner=_no_compiler,
        )


def test_validation_llm_failure_keeps_hunks_all_gates_skipped() -> None:
    # The provider fails INSIDE a validation gate (semantic). The expensive
    # hunks are KEPT: status=validation_failed, every gate skipped with a
    # transient-provider detail, so the reviewer can inspect and regenerate.
    class _RaisingSemantic:
        def generate(self, prompt: str, max_tokens: int = 4096, temperature: float = 0.0) -> str:
            raise json.JSONDecodeError("Expecting value", "doc", 7)

        def is_available(self) -> bool:
            return True

    cand = _run(
        FixBackendFake(fixed_code=_whole_file_fix(SINGLE_FN, [], ("* 1000", "* 1"))),
        SINGLE_FN,
        config=_config(semantic_enabled=True),
        finding=_finding(),
        compile_runner=_no_compiler,  # compile gate off so the semantic gate runs
        semantic_backend=_RaisingSemantic(),
    )
    assert cand["status"] == "validation_failed"
    assert len(cand["hunks"]) == 1  # the repair result survives
    assert "Validation could not run" in cand["repair_explanation"]
    assert len(cand["validations"]) == 5
    for v in cand["validations"]:
        assert v["status"] == "skipped"
        assert "usually transient" in v["detail"]


# --- per-call LLM usage lines (round 12a, measurement only) --------------------
#
# The budget-formula decision needs the prompt/completion/reasoning split per
# LLM call visible in the logs (zlib-deflate: ~26k reasoning tokens inside a
# ~30k budget starved the content). These tests pin the line FORMAT: numbers
# from the tracker delta, finish from the recorder, max_tokens as requested —
# and the degrade (0/0/0 + unknown) when a fake bypasses the tracker.


class _TrackedFixBackend(FixBackendFake):
    """A fix backend that simulates the httpx wrap: adds usage numbers to the
    global tracker and records a finish_reason during generate (same thread),
    exactly as a real OpenRouter call would."""

    def __init__(self, fixed_code: str, finish: str = "length") -> None:
        super().__init__(fixed_code=fixed_code)
        self._finish = finish

    def generate(self, prompt: str, max_tokens: int = 4096, temperature: float = 0.0) -> str:
        from repair_api import usage_tracker

        usage_tracker.tracker.add_from_response_json(
            {
                "usage": {
                    "prompt_tokens": 100,
                    "completion_tokens": 50,
                    "completion_tokens_details": {"reasoning_tokens": 30},
                }
            }
        )
        usage_tracker._record_finish_reason(self._finish)
        return super().generate(prompt, max_tokens=max_tokens, temperature=temperature)


def test_repair_llm_usage_line_with_tracked_backend() -> None:
    # The repair-stage line carries this call's DELTA (not totals), the
    # requested dynamic budget, and the recorded finish_reason.
    backend = _TrackedFixBackend(_whole_file_fix(SINGLE_FN, [], ("* 1000", "* 1")))
    records = _capture_adapter_logs(
        lambda: _run(backend, SINGLE_FN, config=_config(), finding=_finding(), compile_runner=_no_compiler)
    )
    lines = [r.getMessage() for r in records if "repair llm:" in r.getMessage()]
    assert len(lines) == 1
    line = lines[0]
    # SINGLE_FN is tiny -> the dynamic budget sits at the floor max(8192, base).
    assert "stage=repair" in line and "max_tokens=8192" in line
    assert "prompt=100" in line and "completion=50" in line and "reasoning=30" in line
    assert "finish=length" in line


def test_repair_llm_usage_line_unknown_without_tracker() -> None:
    # A fake that bypasses the tracker/recorder -> zero deltas, finish=unknown
    # (and a stale recorder value from a prior call must not leak: run_repair
    # resets before the call).
    from repair_api import usage_tracker

    usage_tracker._record_finish_reason("stop")  # stale value from a "previous" call
    backend = FixBackendFake(fixed_code=_whole_file_fix(SINGLE_FN, [], ("* 1000", "* 1")))
    records = _capture_adapter_logs(
        lambda: _run(backend, SINGLE_FN, config=_config(), finding=_finding(), compile_runner=_no_compiler)
    )
    lines = [r.getMessage() for r in records if "repair llm:" in r.getMessage()]
    assert len(lines) == 1
    assert "prompt=0" in lines[0] and "completion=0" in lines[0] and "reasoning=0" in lines[0]
    assert "finish=unknown" in lines[0]


def test_validation_semantic_stage_usage_line() -> None:
    # The windowed semantic gate runs inside validate_fix_result; the wrapper
    # backend must emit its own stage=semantic line with the gate's max_tokens
    # (RepairConfig.semantic_max_tokens) and the call's usage delta.
    class _TrackedSemantic:
        def generate(self, prompt: str, max_tokens: int = 4096, temperature: float = 0.0) -> str:
            from repair_api import usage_tracker

            usage_tracker.tracker.add_from_response_json(
                {
                    "usage": {
                        "prompt_tokens": 40,
                        "completion_tokens": 20,
                        "completion_tokens_details": {"reasoning_tokens": 5},
                    }
                }
            )
            usage_tracker._record_finish_reason("stop")
            return (
                '{"parse_ok": true, "auto_apply_ok": true, "behavior_preserved": true, '
                '"material_behavior_delta": false, "uncertain_material_behavior": false, '
                '"fail_type": "none", "confidence": "high", "reason": "ok"}'
            )

        def is_available(self) -> bool:
            return True

    records = _capture_adapter_logs(
        lambda: _run(
            FixBackendFake(fixed_code=_whole_file_fix(SINGLE_FN, [], ("* 1000", "* 1"))),
            SINGLE_FN,
            config=_config(semantic_enabled=True),
            finding=_finding(),
            compile_runner=_no_compiler,  # compile gate off so the semantic gate runs
            semantic_backend=_TrackedSemantic(),
        )
    )
    lines = [r.getMessage() for r in records if "repair llm:" in r.getMessage()]
    semantic_lines = [ln for ln in lines if "stage=semantic" in ln]
    assert len(semantic_lines) == 1
    line = semantic_lines[0]
    # RepairConfig.semantic_max_tokens defaults to 1024 in the test config.
    assert "max_tokens=1024" in line
    assert "prompt=40" in line and "completion=20" in line and "reasoning=5" in line
    assert "finish=stop" in line


# --- function-window repair (D-035) -------------------------------------------
#
# Above _WINDOW_REPAIR_MIN_LINES processed lines (and with a resolved target)
# the model rewrites a WINDOW = prelude + file-level lines above the target +
# the target function body; diff hunks map back through the window's line map
# and seam-crossing hunks are dropped. At or below the threshold the proven
# whole-file path is untouched.


def _make_big_source(n_functions: int = 100) -> str:
    """3 file-level lines + ``n_functions`` 4-line functions (~403 lines).

    The middle function is the recognizable target ``f_target`` with the usual
    ``x * 1000`` violation line.
    """
    parts = [
        "#include <stdio.h>\n",
        "#define GLOBAL_SCALE 2\n",
        "int g_counter = 0;\n",
    ]
    for i in range(n_functions):
        if i == n_functions // 2:
            parts.append("int f_target(int x) {\n    int y = x * 1000;\n    return y;\n}\n")
        else:
            parts.append(f"int fn_{i}(int a) {{\n    int b = a + {i};\n    return b;\n}}\n")
    return "".join(parts)


def _big_target(src: str):
    from repair_api.functions import build_inventory

    inventory = build_inventory(src)
    target = next(fn for fn in inventory if fn.name == "f_target")
    return inventory, target


def _processed_of(src: str) -> str:
    augmented = compose.compose_augmented_c([], src)
    processed, _m, _i = Preprocessor(keep_comments=False).process(augmented)
    return processed


class _PromptCapturingFixBackend(FixBackendFake):
    """FixBackendFake that also records the prompts it was handed."""

    def __init__(self, fixed_code: str) -> None:
        super().__init__(fixed_code=fixed_code)
        self.prompts: list[str] = []

    def generate(self, prompt: str, max_tokens: int = 4096, temperature: float = 0.0) -> str:
        self.prompts.append(prompt)
        return super().generate(prompt, max_tokens=max_tokens, temperature=temperature)


def test_build_repair_window_two_slice_structure_and_line_map() -> None:
    # Round 18: exactly two slices — the prelude and ONE contiguous
    # context+function region ending at the function's last line.
    src = _make_big_source()
    processed = _processed_of(src)
    _inventory, target = _big_target(src)
    w = repair_adapter._build_repair_window(processed, 4, target)
    fn_start_aug = target.start_line + 4  # 208
    fn_end_aug = target.end_line + 4  # 211
    context_start = fn_start_aug - repair_adapter._WINDOW_CONTEXT_ABOVE  # 88 > 5
    assert w.line_map == [1, 2, 3, 4] + list(range(context_start, fn_end_aug + 1))
    # Single seam (prelude end -> context start); the context itself has none.
    jumps = [
        (a, b) for a, b in zip(w.line_map, w.line_map[1:]) if b != a + 1
    ]
    assert jumps == [(4, context_start)]
    # The text is exactly those processed lines, in order.
    plines = processed.split("\n")
    assert w.text == "\n".join(plines[r - 1] for r in w.line_map)
    # Content: the target and its NEAR neighbours are in; far content is out.
    assert "x * 1000" in w.text
    assert "a + 49;" in w.text  # fn_49 (immediately above) rides the context
    assert "a + 7;" not in w.text  # far function excluded
    assert "GLOBAL_SCALE" not in w.text  # far file-level line excluded
    assert "fn_51" not in w.text  # below the target: never in the window


def test_map_window_hunks_contiguous_seam_and_insert_rules() -> None:
    # Window map: prelude 1-4, file-level 5-7, function 208-211 (seam 7 -> 208).
    line_map = [1, 2, 3, 4, 5, 6, 7, 208, 209, 210, 211]
    H = repair_adapter._Hunk

    # Contiguous replace inside the function slice: window row 9 -> aug 209.
    mapped, dropped = repair_adapter._map_window_hunks_to_augmented(
        [H(start_line=9, line_count=1, replacement_text="fixed")], line_map, "src"
    )
    assert dropped == 0 and len(mapped) == 1
    assert (mapped[0].start_line, mapped[0].line_count) == (209, 1)

    # Replace crossing the seam (rows 7-8 -> aug 7 then 208): dropped.
    mapped, dropped = repair_adapter._map_window_hunks_to_augmented(
        [H(start_line=7, line_count=2, replacement_text="x")], line_map, "src"
    )
    assert mapped == [] and dropped == 1

    # Insert mid-slice (anchor row 9; predecessor 208 -> 209 contiguous): maps.
    mapped, dropped = repair_adapter._map_window_hunks_to_augmented(
        [H(start_line=9, line_count=0, replacement_text="ins")], line_map, "src"
    )
    assert dropped == 0 and mapped[0].start_line == 209 and mapped[0].line_count == 0

    # Insert anchored exactly AT the seam (row 8; predecessor aug 7): dropped.
    mapped, dropped = repair_adapter._map_window_hunks_to_augmented(
        [H(start_line=8, line_count=0, replacement_text="ins")], line_map, "src"
    )
    assert mapped == [] and dropped == 1

    # Insert at the window end (row n+1): appends after the function's last line.
    mapped, dropped = repair_adapter._map_window_hunks_to_augmented(
        [H(start_line=12, line_count=0, replacement_text="tail")], line_map, "src"
    )
    assert dropped == 0 and mapped[0].start_line == 212

    # Insert before the window start (row 1): maps to aug 1 (prelude; the
    # downstream Original mapping drops it there).
    mapped, dropped = repair_adapter._map_window_hunks_to_augmented(
        [H(start_line=1, line_count=0, replacement_text="top")], line_map, "src"
    )
    assert dropped == 0 and mapped[0].start_line == 1


def test_small_file_keeps_whole_file_path() -> None:
    # At/below the threshold the backend must receive the WHOLE processed file
    # (both functions visible) and the usage line must say window=0.
    fixed = _two_fn_fixed(("* 1000", "* 1"))
    backend = _PromptCapturingFixBackend(fixed)
    records = _capture_adapter_logs(
        lambda: _run(
            backend,
            TWO_FN,
            config=_config(),
            finding=_finding(),
            compile_runner=_no_compiler,
            function_id="fn-f-2",
        )
    )
    prompt = backend.prompts[0]
    assert "x * 1000" in prompt and "z + 1" in prompt  # whole file: g included
    repair_lines = [r.getMessage() for r in records if "stage=repair" in r.getMessage()]
    assert len(repair_lines) == 1
    assert "window=0" in repair_lines[0]
    assert "window_lines=" not in repair_lines[0]


def test_large_file_routes_through_window_and_maps_hunk() -> None:
    # E2E shape: >400 lines -> the backend receives the WINDOW (target + file
    # level, no other functions), the fake fixes one line inside it, and the
    # candidate's hunk lands at the right Original line. The D-033 validation
    # (semantic) gate runs on its own window and passes; no prelude marker text
    # leaks into the hunks.
    src = _make_big_source()
    processed = _processed_of(src)
    inventory, target = _big_target(src)
    window = repair_adapter._build_repair_window(processed, 4, target)
    fixed_window = window.text.replace("x * 1000", "x * 1")
    assert fixed_window != window.text

    backend = _PromptCapturingFixBackend(fixed_window)
    semantic = _CapturingSemantic()
    finding = _finding()
    finding["location"] = {"start_line": target.start_line + 1, "end_line": target.start_line + 1}
    records = _capture_adapter_logs(
        lambda: _run(
            backend,
            src,
            config=_config(semantic_enabled=True),
            finding=finding,
            compile_runner=_no_compiler,
            semantic_backend=semantic,
            function_id=target.function_id,
        )
    )
    # The backend saw the window (round 18: target + nearby context), not the file.
    prompt = backend.prompts[0]
    assert "x * 1000" in prompt and "a + 49;" in prompt  # target + near neighbour
    assert "a + 7;" not in prompt and "GLOBAL_SCALE" not in prompt  # far content out
    assert "fn_51" not in prompt  # below the target: out
    # Usage line marks the window path with its size.
    repair_lines = [r.getMessage() for r in records if "stage=repair" in r.getMessage()]
    assert len(repair_lines) == 1
    assert "window=1" in repair_lines[0]
    assert f"window_lines={len(window.line_map)}" in repair_lines[0]


def test_large_file_window_candidate_hunk_in_original_coords() -> None:
    # The mapped hunk must land at the violation's Original line, validation
    # passes, and no prelude/marker text reaches the hunks.
    src = _make_big_source()
    processed = _processed_of(src)
    inventory, target = _big_target(src)
    window = repair_adapter._build_repair_window(processed, 4, target)
    fixed_window = window.text.replace("x * 1000", "x * 1")

    semantic = _CapturingSemantic()
    finding = _finding()
    finding["location"] = {"start_line": target.start_line + 1, "end_line": target.start_line + 1}
    cand = _run(
        _PromptCapturingFixBackend(fixed_window),
        src,
        config=_config(semantic_enabled=True),
        finding=finding,
        compile_runner=_no_compiler,
        semantic_backend=semantic,
        function_id=target.function_id,
    )
    assert cand["status"] == "repair_ready"
    assert len(cand["hunks"]) == 1
    hunk = cand["hunks"][0]
    # The violation line is target.start_line + 1 in ORIGINAL coordinates.
    assert hunk["start_line"] == target.start_line + 1
    assert hunk["line_count"] == 1
    assert "x * 1;" in hunk["replacement_text"]
    # Validation (D-033 window) ran and saw the fix, not far-away functions.
    seen = "\n".join(semantic.prompts)
    assert "x * 1" in seen
    assert "fn_7" not in seen
    # Marker containment: no prelude marker text in any hunk.
    for h in cand["hunks"]:
        assert "C Repair inferred context" not in h["replacement_text"]
        assert "Original source" not in h["replacement_text"]


def test_large_file_all_seam_dropped_yields_repair_failed() -> None:
    # A "fix" that only edits across the file-level/function seam maps to
    # nothing usable: the seam hunk is dropped (logged) and the candidate lands
    # in the existing no-in-scope-change repair_failed family. (certfix's
    # CODE_ONLY parse strips the window's leading blank prelude lines, which
    # adds a prelude-deletion artifact hunk; the existing prelude filter
    # discards it, so the run converges on that family's message — same
    # behaviour the whole-file path has always had for the artifact.)
    src = _make_big_source()
    processed = _processed_of(src)
    inventory, target = _big_target(src)
    window = repair_adapter._build_repair_window(processed, 4, target)
    # Round 18: the only seam is prelude end (row 4) <-> context start (row 5).
    # Replace those two rows with a single joined line: a replace hunk spanning
    # the seam.
    wlines = window.text.split("\n")
    seam_row = 4  # rows 1-4 prelude, 5.. contiguous context slice (1-based)
    wlines[seam_row - 1 : seam_row + 1] = ["int joined_seam_line = 0;"]
    fixed_window = "\n".join(wlines)

    finding = _finding()
    finding["location"] = {"start_line": target.start_line + 1, "end_line": target.start_line + 1}
    results: list = []
    records = _capture_adapter_logs(
        lambda: results.append(
            _run(
                _PromptCapturingFixBackend(fixed_window),
                src,
                config=_config(),
                finding=finding,
                compile_runner=_no_compiler,
                function_id=target.function_id,
            )
        )
    )
    cand = results[0]
    assert cand["status"] == "repair_failed"
    assert cand["hunks"] == []
    # The seam drop is visible in the diagnostics (no silent drop).
    assert any("hunk dropped (window seam)" in r.getMessage() for r in records)


def test_map_window_hunks_all_dropped_returns_empty() -> None:
    # Pure mapping check for the dedicated all-seam-dropped branch: every hunk
    # crosses a seam -> ([], n); run_repair's window path then returns the
    # mapping repair_failed when no other hunk (artifact or real) survives.
    line_map = [1, 2, 3, 4, 5, 6, 7, 208, 209, 210, 211]
    H = repair_adapter._Hunk
    hunks = [
        H(start_line=7, line_count=2, replacement_text="a"),
        H(start_line=6, line_count=3, replacement_text="b"),
    ]
    mapped, dropped = repair_adapter._map_window_hunks_to_augmented(hunks, line_map, "src")
    assert mapped == [] and dropped == 2


def test_large_file_without_resolved_target_stays_whole_file() -> None:
    # >400 lines but the target cannot be resolved (unknown id + out-of-range
    # location): the whole-file path runs (window requires a target function).
    src = _make_big_source()
    fixed = _whole_file_fix(src, [], ("x * 1000", "x * 1"))
    backend = _PromptCapturingFixBackend(fixed)
    finding = _finding()
    finding["location"] = {"start_line": 100000, "end_line": 100000}  # resolves nowhere
    records = _capture_adapter_logs(
        lambda: _run(
            backend,
            src,
            config=_config(),
            finding=finding,
            compile_runner=_no_compiler,
            function_id="fn-does-not-exist",
        )
    )
    prompt = backend.prompts[0]
    assert "fn_7" in prompt  # whole file went to the model
    repair_lines = [r.getMessage() for r in records if "stage=repair" in r.getMessage()]
    assert "window=0" in repair_lines[0]


# --- window-path same-prompt re-draw on finish=length (round 15) --------------
#
# Live: fill_window's reasoning overran the supposedly-hard cap (30,789 >
# 24,576) and read_buf failed to terminate with 9.7k tokens of content headroom
# — model pathologies a bigger budget cannot fix. On the WINDOW path a single
# same-prompt re-draw rides provider non-determinism to a different sample
# (proven on the infer path). finish=unknown is conservative (no re-draw);
# the whole-file path never re-draws (its length failures are oversize-family).


class _FinishScriptedFixBackend:
    """Per-call scripted (fixed_code, finish_reason). ``finish=None`` leaves the
    recorder untouched (reads back as unknown after run_repair's reset)."""

    def __init__(self, *script: tuple) -> None:
        self._script = list(script)
        self.calls = 0

    def generate(self, prompt: str, max_tokens: int = 4096, temperature: float = 0.0) -> str:
        from repair_api import usage_tracker

        code, finish = self._script[min(self.calls, len(self._script) - 1)]
        self.calls += 1
        if finish is not None:
            usage_tracker._record_finish_reason(finish)
        return "```c\n" + code + "\n```\n"

    def is_available(self) -> bool:
        return True


def _window_fixture():
    """(src, window, fixed_window, finding, function_id) for the big source."""
    src = _make_big_source()
    processed = _processed_of(src)
    inventory, target = _big_target(src)
    window = repair_adapter._build_repair_window(processed, 4, target)
    fixed_window = window.text.replace("x * 1000", "x * 1")
    finding = _finding()
    finding["location"] = {"start_line": target.start_line + 1, "end_line": target.start_line + 1}
    return src, window, fixed_window, finding, target.function_id


def test_window_length_redraws_once_then_succeeds() -> None:
    src, window, fixed_window, finding, function_id = _window_fixture()
    truncated = window.text[: len(window.text) // 2]  # cut mid-file, unusable
    backend = _FinishScriptedFixBackend((truncated, "length"), (fixed_window, "stop"))
    results: list = []
    records = _capture_adapter_logs(
        lambda: results.append(
            _run(
                backend,
                src,
                config=_config(),
                finding=finding,
                compile_runner=_no_compiler,
                function_id=function_id,
            )
        )
    )
    assert backend.calls == 2  # first attempt + one re-draw
    cand = results[0]
    assert cand["status"] == "repair_ready"
    assert len(cand["hunks"]) == 1
    repair_lines = [r.getMessage() for r in records if "stage=repair" in r.getMessage()]
    assert len(repair_lines) == 2  # one usage line per attempt
    assert "retry=0" in repair_lines[0] and "finish=length" in repair_lines[0]
    assert "retry=1" in repair_lines[1] and "finish=stop" in repair_lines[1]
    # No redraw_backend supplied (round-15 back-compat): same backend both
    # attempts, and no redraw marker on either line.
    assert all("redraw=" not in ln for ln in repair_lines)
    assert any("one same-prompt re-draw" in r.getMessage() for r in records)


def test_window_redraw_still_length_degrades() -> None:
    # Both attempts truncated (unchanged code + finish=length) -> exactly one
    # re-draw, then the existing truncation repair_failed path.
    src, window, _fixed, finding, function_id = _window_fixture()
    backend = _FinishScriptedFixBackend((window.text, "length"), (window.text, "length"))
    cand = _run(
        backend,
        src,
        config=_config(),
        finding=finding,
        compile_runner=_no_compiler,
        function_id=function_id,
    )
    assert backend.calls == 2  # no third attempt
    assert cand["status"] == "repair_failed"
    assert "truncated" in cand["repair_explanation"]


def test_window_unknown_finish_does_not_redraw() -> None:
    # The recorder was never populated (finish=unknown): conservative, no
    # re-draw even on the window path.
    src, _window, fixed_window, finding, function_id = _window_fixture()
    backend = _FinishScriptedFixBackend((fixed_window, None))
    cand = _run(
        backend,
        src,
        config=_config(),
        finding=finding,
        compile_runner=_no_compiler,
        function_id=function_id,
    )
    assert backend.calls == 1
    assert cand["status"] == "repair_ready"


def test_whole_file_length_does_not_redraw() -> None:
    # The whole-file path (small file) never re-draws: one call even on
    # finish=length; the existing truncation repair_failed message applies.
    processed = _processed_of(TWO_FN)
    backend = _FinishScriptedFixBackend((processed, "length"))  # unchanged -> no fix
    cand = _run(
        backend,
        TWO_FN,
        config=_config(),
        finding=_finding(),
        compile_runner=_no_compiler,
        function_id="fn-f-2",
    )
    assert backend.calls == 1  # no re-draw on the whole-file path
    assert cand["status"] == "repair_failed"
    assert "truncated" in cand["repair_explanation"]


# --- reasoning-off re-draw backend (round 16) ---------------------------------
#
# Live: both same-backend draws finished length with reasoning ~32k (the
# explicit cap fully ignored) — a same-condition re-draw cannot rescue that
# pathology. D-018 established the same route completes with reasoning OFF, so
# the window path's re-draw switches to the reasoning-off backend (the infer
# clone, reused) when one is provided. Quality without reasoning is judged by
# the (windowed, D-033) validation gates, not at the call site.


def test_window_length_redraw_uses_reasoning_off_backend() -> None:
    src, window, fixed_window, finding, function_id = _window_fixture()
    truncated = window.text[: len(window.text) // 2]
    primary = _FinishScriptedFixBackend((truncated, "length"))
    redraw = _FinishScriptedFixBackend((fixed_window, "stop"))
    results: list = []
    records = _capture_adapter_logs(
        lambda: results.append(
            _run(
                primary,
                src,
                config=_config(),
                finding=finding,
                compile_runner=_no_compiler,
                function_id=function_id,
                redraw_backend=redraw,
            )
        )
    )
    # The re-draw ran on the REASONING-OFF backend, not the primary again.
    assert primary.calls == 1
    assert redraw.calls == 1
    cand = results[0]
    assert cand["status"] == "repair_ready"
    assert len(cand["hunks"]) == 1
    repair_lines = [r.getMessage() for r in records if "stage=repair" in r.getMessage()]
    assert len(repair_lines) == 2
    assert "retry=0" in repair_lines[0] and "redraw=" not in repair_lines[0]
    assert "retry=1" in repair_lines[1] and "redraw=reasoning-off" in repair_lines[1]
    assert any("redraw_backend=reasoning-off" in r.getMessage() for r in records)


def test_window_redraw_backend_unused_when_first_draw_completes() -> None:
    # finish=stop on the first draw: the redraw backend must never be touched.
    src, _window, fixed_window, finding, function_id = _window_fixture()
    primary = _FinishScriptedFixBackend((fixed_window, "stop"))
    redraw = _FinishScriptedFixBackend((fixed_window, "stop"))
    cand = _run(
        primary,
        src,
        config=_config(),
        finding=finding,
        compile_runner=_no_compiler,
        function_id=function_id,
        redraw_backend=redraw,
    )
    assert primary.calls == 1
    assert redraw.calls == 0
    assert cand["status"] == "repair_ready"


def test_whole_file_never_touches_redraw_backend() -> None:
    # The whole-file path never re-draws, so a supplied redraw backend is
    # never consulted even on finish=length.
    class _BoomBackend:
        calls = 0

        def generate(self, prompt: str, max_tokens: int = 4096, temperature: float = 0.0) -> str:
            raise AssertionError("redraw backend must not be called on the whole-file path")

        def is_available(self) -> bool:
            return True

    processed = _processed_of(TWO_FN)
    primary = _FinishScriptedFixBackend((processed, "length"))  # unchanged -> no fix
    cand = _run(
        primary,
        TWO_FN,
        config=_config(),
        finding=_finding(),
        compile_runner=_no_compiler,
        function_id="fn-f-2",
        redraw_backend=_BoomBackend(),
    )
    assert primary.calls == 1
    assert cand["status"] == "repair_failed"
    assert "truncated" in cand["repair_explanation"]


# --- inter-function gap joins the function slice (round 17) --------------------
#
# curl-url live (0/3): comment-stripping blanks let the diff anchor slide, so a
# fix to the function's first lines fused into ONE hunk starting at the last
# row before the function slice — crossing the seam and getting dropped (3/3,
# window_start at the file-level/function boundary). The function slice now
# extends up to just after the previous function's end (bounded at 30 lines),
# so the gap rows are contiguous with the function head and the fused hunk
# maps; the file-level pass stops at the previous function's end (no dup rows).


def _make_gap_source(gap_pad: int = 0) -> str:
    """Header + helper fn + gap (blank / decl / blank [+ pad decls]) + target.

    Layout (gap_pad=0): 1 include, 2-4 helper, 5 blank, 6 gap_marker decl,
    7 blank, 8-11 f_target, then filler functions to exceed 400 lines.
    ``gap_pad`` inserts extra decl lines into the gap (to exceed the 30 cap).
    """
    parts = [
        "#include <stdio.h>\n",  # 1
        "static int helper(int a) {\n",  # 2
        "    return a + 1;\n",  # 3
        "}\n",  # 4
        "\n",  # 5
        "int gap_marker = 1;\n",  # 6
        "\n",  # 7
    ]
    for i in range(gap_pad):
        parts.append(f"int pad_{i} = {i};\n")
    parts.append("int f_target(int x) {\n    int y = x * 1000;\n    return y;\n}\n")
    for i in range(110):
        parts.append(f"int fn_{i}(int a) {{\n    int b = a + {i};\n    return b;\n}}\n")
    return "".join(parts)


def _gap_target(src: str):
    from repair_api.functions import build_inventory

    inventory = build_inventory(src)
    return inventory, next(fn for fn in inventory if fn.name == "f_target")


def test_window_close_function_context_contiguous_with_prelude() -> None:
    # Round 18: a target within the context distance of the prelude -> the
    # clamp starts the slice right after the prelude, so the WHOLE window is
    # contiguous (no seam at all). Everything above the target — helper body,
    # gap rows, include — rides the context.
    src = _make_gap_source()
    processed = _processed_of(src)
    _inventory, target = _gap_target(src)
    w = repair_adapter._build_repair_window(processed, 4, target)
    # target Original 8-11 -> aug 12-15; context start clamps to 5.
    assert w.line_map == list(range(1, 16))
    assert w.line_map == sorted(set(w.line_map))  # strict, no duplicates
    assert w.text.count("gap_marker") == 1
    assert "a + 1" in w.text  # helper body rides the contiguous context now


def test_window_fused_hunk_above_function_head_maps_contiguously() -> None:
    # curl live mode: an edit to the function's first lines fuses (via the
    # anchor sliding over blanks above the head) into one hunk that STARTS
    # above the function. With one contiguous context region the range cannot
    # touch a seam near the head -> it maps.
    src = _make_gap_source()
    processed = _processed_of(src)
    _inventory, target = _gap_target(src)
    w = repair_adapter._build_repair_window(processed, 4, target)
    # Window rows == aug rows here (fully contiguous map [1..15]). A fused
    # replace over rows 11-13 (last blank above the head + fn head + violation
    # line — the OLD seam neighbourhood) maps verbatim.
    fused = repair_adapter._Hunk(start_line=11, line_count=3, replacement_text="x\ny\nz")
    mapped, dropped = repair_adapter._map_window_hunks_to_augmented(
        [fused], w.line_map, "src"
    )
    assert dropped == 0 and len(mapped) == 1
    assert (mapped[0].start_line, mapped[0].line_count) == (11, 3)


def test_window_gap_edit_survives_end_to_end() -> None:
    # E2E: the model edits BOTH a gap decl and the violation line. Both hunks
    # map (the gap row is in the slice), the gap hunk passes the D-022 scope
    # filter as a global-scope change, and the candidate carries both.
    src = _make_gap_source()
    processed = _processed_of(src)
    inventory, target = _gap_target(src)
    w = repair_adapter._build_repair_window(processed, 4, target)
    fixed_window = w.text.replace("int gap_marker = 1;", "int gap_marker = 2;").replace(
        "x * 1000", "x * 1"
    )
    finding = _finding()
    finding["location"] = {"start_line": target.start_line + 1, "end_line": target.start_line + 1}
    cand = _run(
        _FinishScriptedFixBackend((fixed_window, "stop")),
        src,
        config=_config(),
        finding=finding,
        compile_runner=_no_compiler,
        function_id=target.function_id,
    )
    assert cand["status"] == "repair_ready"
    starts = sorted(h["start_line"] for h in cand["hunks"])
    assert starts == [6, target.start_line + 1]  # gap decl (Original 6) + fn body
    texts = "\n".join(h["replacement_text"] for h in cand["hunks"])
    assert "gap_marker = 2" in texts and "x * 1" in texts


def test_window_context_capped_at_120_lines() -> None:
    # A deep target: the contiguous context extends exactly
    # _WINDOW_CONTEXT_ABOVE lines above the function head; content above that
    # boundary is excluded, content at/below it is included.
    src = _make_big_source()
    processed = _processed_of(src)
    _inventory, target = _big_target(src)
    w = repair_adapter._build_repair_window(processed, 4, target)
    fn_start_aug = target.start_line + 4  # 208
    boundary = fn_start_aug - repair_adapter._WINDOW_CONTEXT_ABOVE  # aug 88
    assert w.line_map[4] == boundary  # context head right at the cap
    # Contiguous from the context head through the function end.
    slice_rows = w.line_map[4:]
    assert slice_rows == list(range(boundary, slice_rows[-1] + 1))
    # aug 88 = Original 84 = fn_20's first line: fn_20 body in, fn_19 body out.
    assert "a + 20;" in w.text
    assert "a + 19;" not in w.text


def test_window_first_function_keeps_pre_round17_shape() -> None:
    # No function precedes the target: the slice starts at the target itself
    # and the file-level pass covers everything above (the original shape).
    src = _make_gap_source()
    processed = _processed_of(src)
    inventory, _target = _gap_target(src)
    from repair_api.functions import build_inventory  # noqa: F401 — inventory reused

    helper = next(fn for fn in inventory if fn.name == "helper")
    w = repair_adapter._build_repair_window(processed, 4, helper)
    # prelude 1-4, file-level: only the include (Original 1 -> aug 5), then the
    # helper body (Original 2-4 -> aug 6-8) with no upward extension.
    assert w.line_map == [1, 2, 3, 4, 5, 6, 7, 8]
    assert "gap_marker" not in w.text  # below the target: not in this window


# --- Codex review round 19 -----------------------------------------------------


def test_truncated_nonempty_output_fails_close_on_window_path() -> None:
    # [MUST] finish=length on the FINAL attempt (after the re-draw) must fail
    # close even when the output is non-empty and differs — a truncated text
    # diffs into fabricated edits at the cut. Previously only empty/unchanged
    # outputs were caught.
    src, window, fixed_window, finding, function_id = _window_fixture()
    truncated_but_different = fixed_window[: len(fixed_window) - 40]  # cut tail
    backend = _FinishScriptedFixBackend(
        (truncated_but_different, "length"), (truncated_but_different, "length")
    )
    cand = _run(
        backend,
        src,
        config=_config(),
        finding=finding,
        compile_runner=_no_compiler,
        function_id=function_id,
    )
    assert backend.calls == 2  # first + one re-draw, both truncated
    assert cand["status"] == "repair_failed"
    assert cand["hunks"] == []
    assert "truncated" in cand["repair_explanation"]


def test_truncated_nonempty_output_fails_close_on_whole_file_path() -> None:
    # [MUST] same fail-close on the whole-file path's single attempt.
    fixed = _two_fn_fixed(("* 1000", "* 1"))
    truncated_but_different = fixed[: len(fixed) - 20]
    backend = _FinishScriptedFixBackend((truncated_but_different, "length"))
    cand = _run(
        backend,
        TWO_FN,
        config=_config(),
        finding=_finding(),
        compile_runner=_no_compiler,
        function_id="fn-f-2",
    )
    assert backend.calls == 1
    assert cand["status"] == "repair_failed"
    assert cand["hunks"] == []
    assert "truncated" in cand["repair_explanation"]


def test_finish_unknown_still_produces_candidate() -> None:
    # finish=unknown (recorder untouched) must NOT trip the fail-close.
    fixed = _two_fn_fixed(("* 1000", "* 1"))
    cand = _run(
        FixBackendFake(fixed_code=fixed),
        TWO_FN,
        config=_config(),
        finding=_finding(),
        compile_runner=_no_compiler,
        function_id="fn-f-2",
    )
    assert cand["status"] == "repair_ready"


def test_budget_ceiling_wins_over_configured_floor() -> None:
    # [MUST] clamp order: min(ceiling, max(floor, want)) — a floor above the
    # model ceiling must not produce a budget the model cannot return.
    budget = repair_adapter.estimate_repair_max_tokens(
        "int f(){}\n", base=30000, ceiling=10000
    )
    assert budget == 10000
    # Ordinary case unchanged: floor applies under the ceiling.
    assert repair_adapter.estimate_repair_max_tokens("int f(){}\n", base=9000, ceiling=10000) == 9000


def test_ceiling_cache_key_includes_provider_pin() -> None:
    # [SHOULD] the cache key is (model id, pin): a pin change after an auto
    # resolve (or vice versa) must trigger a fresh fetch, not a stale ceiling.
    calls = {"n": 0}

    def fetcher(_model_id: str, _api_key):
        calls["n"] += 1
        return {
            "data": {
                "endpoints": [
                    {"provider_name": "PinnedProv", "max_completion_tokens": 111},
                    {"provider_name": "OtherProv", "max_completion_tokens": 222},
                ]
            }
        }

    resolver = repair_adapter.ModelCeilingResolver(fetcher=fetcher)
    pin = {"provider": {"order": ["PinnedProv"], "allow_fallbacks": False}}
    assert resolver.resolve("m/x", extra_body=pin, api_key="k") == 111
    # Auto routing (no pin): a DIFFERENT cache entry -> fresh fetch -> max().
    assert resolver.resolve("m/x", extra_body=None, api_key="k") == 222
    assert calls["n"] == 2
    # Cached per key afterwards (no third fetch).
    assert resolver.resolve("m/x", extra_body=pin, api_key="k") == 111
    assert calls["n"] == 2
    # Pinned provider absent from the endpoints doc: NO fallback to other
    # providers' ceilings — degrades to the static fallback (pre-existing
    # behaviour, pinned here by test).
    missing_pin = {"provider": {"order": ["NoSuchProv"], "allow_fallbacks": False}}
    assert (
        resolver.resolve("m/x", extra_body=missing_pin, api_key="k")
        == repair_adapter._STATIC_CEILING_FALLBACK
    )


def _global_only_fixed() -> str:
    """Fixed text whose ONLY substantive change is a new GLOBAL declaration on
    the blank line between f and g (Original 6) — a hunk that intersects no
    function body. (A line-1 include change would sit adjacent to the prelude
    blanks and fuse with the CODE_ONLY leading-blank-strip artifact into a
    prelude-dropped hunk; the mid-file global line avoids that.)"""
    augmented = compose.compose_augmented_c([], TWO_FN)
    processed, _m, _i = Preprocessor(keep_comments=False).process(augmented)
    lines = processed.split("\n")
    assert lines[9] == ""  # aug 10 = Original 6, the blank between f and g
    lines[9] = "int global_marker = 1;"
    return "\n".join(lines)


def test_global_only_hunks_rejected_when_removal_not_run() -> None:
    # Round 21 semantics (revising round 19's unconditional rejection): a
    # global-only candidate needs a POSITIVE violation_removal pass. With the
    # gate disabled (not_run) nothing confirms the fix -> repair_failed.
    # Target = g (lines 7-10); the only change is a new global declaration on
    # the blank line between f and g (Original 6) — it intersects no function.
    fixed = _global_only_fixed()
    finding = _finding()
    finding["location"] = {"start_line": 8, "end_line": 8}  # inside g
    cand = _run(
        FixBackendFake(fixed_code=fixed),
        TWO_FN,
        config=_config(),  # violation_removal disabled -> not_run
        finding=finding,
        compile_runner=_no_compiler,
        function_id="fn-g-7",
    )
    assert cand["status"] == "repair_failed"
    assert cand["hunks"] == []
    assert "made no change to the target function" in cand["repair_explanation"]
    assert "could not be verified to remove the violation" in cand["repair_explanation"]


class _RemovalPassDetector:
    """Detector backend whose post-fix detect finds NOTHING -> removal pass."""

    def detect(self, code: str, rules=None):  # noqa: ANN001 — certfix duck type
        return []

    def is_available(self) -> bool:
        return True


class _RemovalFailDetector:
    """Detector that still finds the (denylisted) target rule -> removal fail.

    SIG34-C is on the test config's override_denylist, so the target-only
    override is DENIED deterministically (no audit LLM call).
    """

    def detect(self, code: str, rules=None):  # noqa: ANN001 — certfix duck type
        return [make_violation("SIG34-C", 8)]

    def is_available(self) -> bool:
        return True


def test_global_only_candidate_survives_when_removal_passes() -> None:
    # Round 21: removal PASS is the evidence a global-only change (DCL
    # declaration-family fixes, e.g. lua-lgc clearkey DCL37-C live) removes the
    # finding -> the candidate proceeds to the normal status decision.
    fixed = _global_only_fixed()
    finding = _finding()
    finding["location"] = {"start_line": 8, "end_line": 8}
    cand = _run(
        FixBackendFake(fixed_code=fixed),
        TWO_FN,
        config=_config(violation_removal_enabled=True),
        finding=finding,
        compile_runner=_no_compiler,
        violation_backend=_RemovalPassDetector(),
        function_id="fn-g-7",
    )
    assert _val(cand, "violation_removal")["status"] == "pass"
    assert cand["status"] == "repair_ready"  # gates decide; nothing else failed
    assert len(cand["hunks"]) == 1  # the global #include hunk survives


def test_global_only_candidate_rejected_when_removal_fails() -> None:
    fixed = _global_only_fixed()
    finding = _finding("SIG34-C")  # denylisted rule -> deterministic removal fail
    finding["location"] = {"start_line": 8, "end_line": 8}
    cand = _run(
        FixBackendFake(fixed_code=fixed),
        TWO_FN,
        config=_config(violation_removal_enabled=True),
        finding=finding,
        compile_runner=_no_compiler,
        violation_backend=_RemovalFailDetector(),
        function_id="fn-g-7",
    )
    assert cand["status"] == "repair_failed"
    assert cand["hunks"] == []
    assert "could not be verified to remove the violation" in cand["repair_explanation"]


def test_global_only_candidate_rejected_when_removal_skipped() -> None:
    # Gate enabled but no detector backend -> mapped "skipped" -> cannot
    # confirm the global-only change -> repair_failed.
    fixed = _global_only_fixed()
    finding = _finding()
    finding["location"] = {"start_line": 8, "end_line": 8}
    cand = _run(
        FixBackendFake(fixed_code=fixed),
        TWO_FN,
        config=_config(violation_removal_enabled=True),
        finding=finding,
        compile_runner=_no_compiler,
        violation_backend=None,
        function_id="fn-g-7",
    )
    assert cand["status"] == "repair_failed"
    assert cand["hunks"] == []
    assert "could not be verified to remove the violation" in cand["repair_explanation"]
