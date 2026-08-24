"""Two-stage stub-fallback compile probe (Phase A gap: header-less .c).

A context-poor single ``.c`` whose ``#include "x.h"`` project headers are absent
stops at the *include* stage before any type/declaration error surfaces, so the
compile probe reports 0 missing symbols and context inference has nothing to work
with. The two-stage probe stubs the missing LOCAL (quoted) headers into a temp
dir and re-probes so the real errors surface.

The stub stage is ITERATIVE: gcc stops at the first missing include (fatal ends
the TU), so each re-probe reveals only the next missing header; the loop stubs
cumulatively until the include stage is passed (safety cap ``_MAX_STUB_ROUNDS``).

Covers (no LLM; the real-gcc tests skip when gcc is absent):
- missing-local-header extraction: quoted only, system ``<...>`` excluded, multiple.
- the two-stage probe with a fake runner (stub dir on -I flips the second probe).
- the iterative loop: chained missing includes revealed one at a time (fake and
  real gcc), and the round-cap degrade path.
- an end-to-end real-gcc probe: first probe fails on a missing quoted header, the
  stub lets the include pass, and ``unknown type`` symbols are then extracted.
- the single-probe fast path (already-compiling and already-symbol-yielding cases
  never stub — unless a missing local header coexists with the symbols, where the
  fatal include truncated the TU and stubbing is required for full diagnostics).
"""

from __future__ import annotations

import shutil

import pytest

from repair_api.adapter import repair as repair_adapter

# gcc's fatal-include diagnostic is identical for quoted and angle includes (the
# name is bare in both), so the source is what distinguishes local from system.
FATAL_LOCAL = 'x.c:1:10: fatal error: zutil.h: No such file or directory\n'
FATAL_SYSTEM = 'x.c:2:10: fatal error: no_such_sys.h: No such file or directory\n'


# --- _extract_missing_local_headers -----------------------------------------


def test_extract_missing_local_headers_quoted_only() -> None:
    source = '#include "zutil.h"\nint f(void){return 0;}\n'
    assert repair_adapter._extract_missing_local_headers(FATAL_LOCAL, source) == ["zutil.h"]


def test_extract_missing_local_headers_excludes_system_header() -> None:
    # gcc reported the header missing, but it was included with <...> in the source
    # -> it is a system/environment gap, not missing external context. Not stubbed.
    source = "#include <no_such_sys.h>\nint f(void){return 0;}\n"
    assert repair_adapter._extract_missing_local_headers(FATAL_SYSTEM, source) == []


def test_extract_missing_local_headers_mixed_keeps_only_quoted() -> None:
    source = '#include "zutil.h"\n#include <no_such_sys.h>\nint f(void){return 0;}\n'
    stderr = FATAL_LOCAL + FATAL_SYSTEM
    assert repair_adapter._extract_missing_local_headers(stderr, source) == ["zutil.h"]


def test_extract_missing_local_headers_multiple_in_source_order() -> None:
    source = '#include "b.h"\n#include "a.h"\nint f(void){return 0;}\n'
    stderr = (
        'x.c:1:10: fatal error: a.h: No such file or directory\n'
        'x.c:2:10: fatal error: b.h: No such file or directory\n'
    )
    # Ordered by the source's include order (b before a), not by stderr order.
    assert repair_adapter._extract_missing_local_headers(stderr, source) == ["b.h", "a.h"]


def test_extract_missing_local_headers_none_when_no_fatal() -> None:
    source = '#include "zutil.h"\n'
    assert repair_adapter._extract_missing_local_headers("", source) == []


def test_quoted_include_names_dedup_and_order() -> None:
    source = '#include "a.h"\n#include <sys.h>\n#include "a.h"\n#include "b.h"\n'
    assert repair_adapter._quoted_include_names(source) == ["a.h", "b.h"]


# --- probe_with_stub_fallback (fake runner) ---------------------------------


def test_probe_fast_path_when_first_probe_compiles() -> None:
    def runner(_code, _config):
        return repair_adapter.CompileOutcome(ok=True, stderr="")

    result = repair_adapter.probe_with_stub_fallback(
        processed="int f(void){return 0;}\n",
        source="int f(void){return 0;}\n",
        compile_config=object(),
        baseline_compile_runner=runner,
    )
    assert result.outcome.ok is True
    assert result.stubbed_headers == []
    assert result.missing_symbols == []


def test_probe_fast_path_when_first_probe_already_yields_symbols() -> None:
    # First probe fails but already surfaced a type error (no missing header) ->
    # single probe, no stubbing.
    stderr = "x.c:1:1: error: unknown type name 'Foo'\n"

    calls = {"n": 0}

    def runner(_code, _config):
        calls["n"] += 1
        return repair_adapter.CompileOutcome(ok=False, stderr=stderr)

    result = repair_adapter.probe_with_stub_fallback(
        processed="Foo x;\n",
        source="Foo x;\n",
        compile_config=object(),
        baseline_compile_runner=runner,
    )
    assert calls["n"] == 1  # no re-probe
    assert result.stubbed_headers == []
    assert result.missing_symbols == ["Foo"]


def test_probe_two_stage_stubs_then_surfaces_symbols() -> None:
    # A fake runner that returns the include fatal error UNTIL the stub dir is on
    # the config's include_paths, then returns a type error (as a real re-probe
    # would once the include resolves).
    source = '#include "zutil.h"\nFoo x;\n'

    def runner(_code, config):
        include_paths = list(getattr(config, "include_paths", []) or [])
        stub_present = any("cfx-stub-" in p for p in include_paths)
        if stub_present:
            return repair_adapter.CompileOutcome(
                ok=False, stderr="x.c:2:1: error: unknown type name 'Foo'\n"
            )
        return repair_adapter.CompileOutcome(ok=False, stderr=FATAL_LOCAL)

    # A minimal config object exposing include_paths (deepcopy-able).
    class Cfg:
        def __init__(self):
            self.include_paths = []

    result = repair_adapter.probe_with_stub_fallback(
        processed=source,
        source=source,
        compile_config=Cfg(),
        baseline_compile_runner=runner,
    )
    assert result.stubbed_headers == ["zutil.h"]
    assert result.missing_symbols == ["Foo"]


def test_probe_iterates_chained_missing_includes_with_fake_runner() -> None:
    # gcc reports only the FIRST missing include per probe. A fake runner that
    # reveals a.h -> b.h -> c.h one fatal at a time must drive three stub rounds;
    # once all three are stubbed the type error surfaces.
    import os

    source = '#include "a.h"\n#include "b.h"\n#include "c.h"\nFoo x;\n'

    def _stubbed_names(config) -> set:
        names: set = set()
        for p in list(getattr(config, "include_paths", []) or []):
            if "cfx-stub-" in p and os.path.isdir(p):
                names.update(os.listdir(p))
        return names

    def runner(_code, config):
        have = _stubbed_names(config)
        for h in ("a.h", "b.h", "c.h"):
            if h not in have:
                return repair_adapter.CompileOutcome(
                    ok=False,
                    stderr=f"x.c:1:10: fatal error: {h}: No such file or directory\n",
                )
        return repair_adapter.CompileOutcome(
            ok=False, stderr="x.c:4:1: error: unknown type name 'Foo'\n"
        )

    class Cfg:
        def __init__(self):
            self.include_paths = []

    result = repair_adapter.probe_with_stub_fallback(
        processed=source,
        source=source,
        compile_config=Cfg(),
        baseline_compile_runner=runner,
    )
    assert result.stubbed_headers == ["a.h", "b.h", "c.h"]
    assert result.missing_symbols == ["Foo"]


def test_probe_round_cap_degrades_to_first_outcome() -> None:
    # A pathological input that reveals a NEW missing quoted header on every
    # re-probe never converges; after _MAX_STUB_ROUNDS re-probes the probe
    # degrades to the FIRST probe's outcome (no symbols) while still reporting
    # the headers stubbed so far.
    n_headers = repair_adapter._MAX_STUB_ROUNDS + 3
    headers = [f"h{i:02d}.h" for i in range(n_headers)]
    source = "".join(f'#include "{h}"\n' for h in headers) + "Foo x;\n"

    calls = {"n": 0}

    def runner(_code, _config):
        # Call k fails on the k-th header (never runs out within the cap).
        h = headers[min(calls["n"], n_headers - 1)]
        calls["n"] += 1
        return repair_adapter.CompileOutcome(
            ok=False, stderr=f"x.c:1:10: fatal error: {h}: No such file or directory\n"
        )

    class Cfg:
        def __init__(self):
            self.include_paths = []

    result = repair_adapter.probe_with_stub_fallback(
        processed=source,
        source=source,
        compile_config=Cfg(),
        baseline_compile_runner=runner,
    )
    # 1 first probe + _MAX_STUB_ROUNDS re-probes, then degrade.
    assert calls["n"] == 1 + repair_adapter._MAX_STUB_ROUNDS
    assert result.outcome.ok is False
    assert "h00.h" in result.outcome.stderr  # the FIRST probe's stderr
    assert result.missing_symbols == []
    # The cap stubbed one new header per round before degrading.
    assert result.stubbed_headers == headers[: repair_adapter._MAX_STUB_ROUNDS]


def test_probe_no_local_header_and_no_symbols_returns_empty() -> None:
    # Fails only on a SYSTEM header -> nothing to stub, no symbols.
    source = "#include <no_such_sys.h>\nint f(void){return 0;}\n"

    def runner(_code, _config):
        return repair_adapter.CompileOutcome(ok=False, stderr=FATAL_SYSTEM)

    result = repair_adapter.probe_with_stub_fallback(
        processed=source,
        source=source,
        compile_config=object(),
        baseline_compile_runner=runner,
    )
    assert result.stubbed_headers == []
    assert result.missing_symbols == []


# --- end-to-end with REAL gcc (no LLM) --------------------------------------


@pytest.mark.skipif(shutil.which("gcc") is None, reason="gcc not on PATH")
def test_probe_real_gcc_stub_surfaces_unknown_type() -> None:
    # A single .c that includes a missing local header and uses an undeclared type.
    # Stage 1 (no stub): gcc stops at the include with a fatal error -> 0 symbols.
    # Stage 2 (stub dir on -I): the include resolves, the body compiles far enough
    # for 'unknown type name' to surface -> symbol extracted.
    from certfix.config import CompileValidationConfig

    source = (
        '#include "cfx_missing_header.h"\n'
        "mytype_t make(void);\n"
        "int use(void) { return make() ? 1 : 0; }\n"
    )

    result = repair_adapter.probe_with_stub_fallback(
        processed=source,
        source=source,
        compile_config=CompileValidationConfig(),
        baseline_compile_runner=repair_adapter.default_baseline_compile_runner,
    )
    assert result.stubbed_headers == ["cfx_missing_header.h"]
    assert "mytype_t" in result.missing_symbols


@pytest.mark.skipif(shutil.which("gcc") is None, reason="gcc not on PATH")
def test_probe_real_gcc_chained_missing_includes_all_stubbed() -> None:
    # The zlib-inflate.c shape: SEVERAL missing quoted includes. Real gcc stops at
    # the first one, so a single stub round would leave the rest fatal and no
    # symbols would surface (the live-verification bug). The iterative loop must
    # stub all three, pass the include stage, and extract the type errors.
    from certfix.config import CompileValidationConfig

    source = (
        '#include "cfx_chain_one.h"\n'
        '#include "cfx_chain_two.h"\n'
        '#include "cfx_chain_three.h"\n'
        "state_t st;\n"
        "int run(void) { return step(&st); }\n"
    )

    result = repair_adapter.probe_with_stub_fallback(
        processed=source,
        source=source,
        compile_config=CompileValidationConfig(),
        baseline_compile_runner=repair_adapter.default_baseline_compile_runner,
    )
    # All three headers stubbed, in include order (gcc revealed them one by one).
    assert result.stubbed_headers == [
        "cfx_chain_one.h",
        "cfx_chain_two.h",
        "cfx_chain_three.h",
    ]
    # With the include stage passed, the real declaration errors surface.
    assert "state_t" in result.missing_symbols
    assert "step" in result.missing_symbols


@pytest.mark.skipif(shutil.which("gcc") is None, reason="gcc not on PATH")
def test_probe_real_gcc_single_probe_when_self_contained() -> None:
    # A self-contained file compiles on the first probe -> no stub dir, no symbols.
    from certfix.config import CompileValidationConfig

    source = "int add(int a, int b) { return a + b; }\n"
    result = repair_adapter.probe_with_stub_fallback(
        processed=source,
        source=source,
        compile_config=CompileValidationConfig(),
        baseline_compile_runner=repair_adapter.default_baseline_compile_runner,
    )
    assert result.outcome.ok is True
    assert result.stubbed_headers == []
    assert result.missing_symbols == []


def test_probe_stubs_when_symbols_and_missing_header_coexist() -> None:
    # A missing quoted include is FATAL and truncates the TU, so symbols seen
    # alongside it (e.g. from a composed prelude ABOVE the include) are only the
    # pre-include errors — the body was never checked. The probe must NOT take
    # the single-probe fast path on those partial symbols: it stubs, re-probes,
    # and reports the symbols of the stubbed (full-TU) outcome instead.
    # (Observed on curl-url.c: 77 prelude items -> a few prelude-internal
    # unknown types masked the whole body; check said stubbed=0.)
    source = 'PreludeType p;\n#include "zutil.h"\nBodyType x;\n'
    prelude_and_fatal = "x.c:1:1: error: unknown type name 'PreludeType'\n" + FATAL_LOCAL
    full_after_stub = (
        "x.c:1:1: error: unknown type name 'PreludeType'\n"
        "x.c:3:1: error: unknown type name 'BodyType'\n"
    )

    def runner(_code, config):
        include_paths = list(getattr(config, "include_paths", []) or [])
        if any("cfx-stub-" in p for p in include_paths):
            return repair_adapter.CompileOutcome(ok=False, stderr=full_after_stub)
        return repair_adapter.CompileOutcome(ok=False, stderr=prelude_and_fatal)

    class Cfg:
        def __init__(self):
            self.include_paths = []

    result = repair_adapter.probe_with_stub_fallback(
        processed=source,
        source=source,
        compile_config=Cfg(),
        baseline_compile_runner=runner,
    )
    assert result.stubbed_headers == ["zutil.h"]
    assert result.missing_symbols == ["PreludeType", "BodyType"]


# --- _write_stub_headers containment (path traversal / absolute names) --------
#
# Header names come from the UNTRUSTED source's ``#include "..."`` lines. A
# naive ``base / name`` join lets ``../../x.h`` escape the stub dir, and pathlib
# makes ``base / "/abs/path.h"`` the absolute path itself — write_text would
# then truncate an arbitrary file. Every write must be contained in stub_dir.


def test_write_stub_headers_skips_traversal_and_absolute_names(tmp_path) -> None:
    import logging

    stub_dir = tmp_path / "stub"
    stub_dir.mkdir()
    victim = tmp_path / "victim.h"
    victim.write_text("PRECIOUS\n", encoding="utf-8")

    records: list = []

    class Capture(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            records.append(record)

    lg = logging.getLogger("repair_api.adapter.repair")
    handler = Capture()
    lg.addHandler(handler)
    old_level = lg.level
    lg.setLevel(logging.INFO)
    try:
        repair_adapter._write_stub_headers(
            str(stub_dir),
            [
                "../escape.h",  # traversal -> skipped
                str(victim),  # absolute -> skipped (would truncate the victim)
                "sub/ok.h",  # normal nested -> written
                "my header.h",  # space in the name -> written (safe)
            ],
        )
    finally:
        lg.removeHandler(handler)
        lg.setLevel(old_level)

    # Safe names were written inside the stub dir (nested dirs created).
    assert (stub_dir / "sub" / "ok.h").is_file()
    assert (stub_dir / "my header.h").is_file()
    # Nothing escaped: no file appeared next to the stub dir, and the absolute
    # target was not touched (not truncated, content intact).
    assert not (tmp_path / "escape.h").exists()
    assert victim.read_text(encoding="utf-8") == "PRECIOUS\n"
    assert set(tmp_path.iterdir()) == {stub_dir, victim}

    # The skips are reported as a COUNT-only warning: names (source content)
    # never appear in the log.
    warnings = [r for r in records if r.levelno == logging.WARNING]
    assert len(warnings) == 1
    message = warnings[0].getMessage()
    assert "2 unsafe stub path(s) skipped" in message
    assert "escape.h" not in message and "victim" not in message


def test_write_stub_headers_normal_names_unaffected(tmp_path) -> None:
    # The containment check must not disturb the ordinary path: plain and
    # nested header names still produce stubs with the standard content.
    stub_dir = tmp_path / "stub"
    stub_dir.mkdir()
    repair_adapter._write_stub_headers(str(stub_dir), ["zutil.h", "deep/nested/hdr.h"])
    assert (stub_dir / "zutil.h").read_text(encoding="utf-8") == (
        "/* stub for context inference */\n"
    )
    assert (stub_dir / "deep" / "nested" / "hdr.h").is_file()
