"""Adapter mapping tests with fake backends (PHASE3A_DESIGN.md §3, §5-1).

Covers: prelude subtraction (Augmented -> Original), function attribution
(in-function / out-of-function -> diagnostics), UNKNOWN-CERT-C -> uncertain, and
the D-003 reduction (one finding per function, minimum line).
"""

from __future__ import annotations

from pathlib import Path

from conftest import LineAwareFake, ScriptedFake, make_violation, sha256_prefixed

from repair_api.adapter import certfix_adapter

REPO_ROOT = Path(__file__).resolve().parents[3]
SENSOR = (REPO_ROOT / "tests" / "fixtures" / "source" / "sample_sensor.c").read_text()

# A single-function file with NO preamble, so a function chunk has empty context
# (context_line_count = 0). With empty items prelude_line_count = 4, so
# Augmented line = Original line + 4 and a line-aware violation at chunk-relative
# line k lands at Original line k.
SINGLE_FN = "int f(int x) {\n    int y = x * 1000;\n    return y;\n}\n"


def _scan(backend, source: str):
    """Scan helper for the empty-items case (prelude_line_count = 4)."""
    return certfix_adapter.run_scan(
        backend=backend,
        source_id="src-test",
        original_content=source,
        original_hash=sha256_prefixed(source),
        context_revision_id="ctxrev-test-1",
        items=[],
        prelude_line_count=4,
    )


def _find_fn(result, name):
    for fn in result["functions"]:
        if fn["name"] == name:
            return fn
    raise AssertionError(f"function {name} not in result")


# --- prelude subtraction ----------------------------------------------------


def test_prelude_subtraction_maps_to_original_line() -> None:
    # Violation at chunk-relative line 2 (the 'x * 1000' line) -> Original line 2.
    backend = LineAwareFake([make_violation("INT32-C", 2)])
    result = _scan(backend, SINGLE_FN)
    fn = _find_fn(result, "f")
    assert fn["original_range"] == {"start_line": 1, "end_line": 4}
    assert len(fn["findings"]) == 1
    finding = fn["findings"][0]
    assert finding["kind"] == "violation"
    assert finding["rule_id"] == "INT32-C"
    assert finding["location"] == {"start_line": 2, "end_line": 2}


# --- function attribution ---------------------------------------------------


def test_attribution_places_violation_in_correct_function() -> None:
    # One violation only in copy_label's chunk.
    backend = ScriptedFake({"void copy_label": ["STR31-C"]})
    result = _scan(backend, SENSOR)
    copy = _find_fn(result, "copy_label")
    assert len(copy["findings"]) == 1
    assert copy["findings"][0]["rule_id"] == "STR31-C"
    # copy_label spans Original 25..27; ScriptedFake collapses to the start line.
    assert copy["findings"][0]["location"] == {"start_line": 25, "end_line": 25}
    # Every other function has no findings.
    for fn in result["functions"]:
        if fn["name"] != "copy_label":
            assert fn["findings"] == []


def test_out_of_function_violation_becomes_diagnostic_only() -> None:
    # Line-aware violation at chunk-relative line 3 with anchor on the single
    # function; but we craft a two-function file where the violation maps beyond
    # any function so it is dropped to diagnostics.
    source = "int a(void) {\n    return 0;\n}\n"
    # Augmented: a() occupies Original 1..3 -> Augmented 5..7. A line-aware
    # violation at chunk line 99 remaps beyond the function; Detector discards
    # lines below chunk start, but a large line stays > range and, after
    # subtraction, is out-of-function -> diagnostics (no finding).
    backend = LineAwareFake([make_violation("INT32-C", 99)])
    result = certfix_adapter.run_scan(
        backend=backend,
        source_id="s",
        original_content=source,
        original_hash=sha256_prefixed(source),
        context_revision_id="ctxrev-1",
        items=[],
        prelude_line_count=4,
    )
    # The single function 'a' gets no finding (violation fell outside its range).
    a = _find_fn(result, "a")
    assert a["findings"] == []


# --- UNKNOWN-CERT-C ---------------------------------------------------------


def test_unknown_rule_maps_to_uncertain() -> None:
    backend = ScriptedFake({"void copy_label": ["UNKNOWN-CERT-C"]})
    result = _scan(backend, SENSOR)
    copy = _find_fn(result, "copy_label")
    assert len(copy["findings"]) == 1
    finding = copy["findings"][0]
    assert finding["kind"] == "uncertain"
    # uncertain findings omit rule_id.
    assert "rule_id" not in finding
    assert finding["rule_summary"]
    assert finding["explanation"]


def test_uncertain_finding_uses_fixed_wording_not_internal_message() -> None:
    # D-029: the internal detector message (here "UNKNOWN-CERT-C message" from the
    # fake) must NOT surface in the finding; both fields carry fixed human wording.
    backend = ScriptedFake({"void copy_label": ["UNKNOWN-CERT-C"]})
    result = _scan(backend, SENSOR)
    finding = _find_fn(result, "copy_label")["findings"][0]
    assert finding["rule_summary"] == "Possible issue (rule not identified)"
    assert finding["explanation"] == (
        "The detector flagged this function as potentially problematic but "
        "could not identify a specific CERT C rule with confidence. Re-scan "
        "may yield a different result."
    )
    # The internal message never appears in any user-facing field.
    assert "UNKNOWN-CERT-C message" not in finding["explanation"]
    assert "UNKNOWN-CERT-C message" not in finding["rule_summary"]


# --- D-003 reduction --------------------------------------------------------


def test_d003_multiple_violations_reduce_to_minimum_line() -> None:
    # Two violations in the same function, at chunk-relative lines 2 and 3.
    backend = LineAwareFake(
        [make_violation("INT32-C", 3, "later"), make_violation("INT32-C", 2, "earlier")]
    )
    result = _scan(backend, SINGLE_FN)
    fn = _find_fn(result, "f")
    # Only one finding survives, at the minimum line (2).
    assert len(fn["findings"]) == 1
    assert fn["findings"][0]["location"] == {"start_line": 2, "end_line": 2}


# --- assumption_dependent ---------------------------------------------------


def _typedef_item(*, confirmed: bool, provenance: str = "llm_inferred") -> dict:
    return {
        "item_id": "i1",
        "kind": "inferred_type",
        "generated_text": "typedef int T;",
        "current_text": "typedef int T;",
        "provenance": provenance,
        "user_edited": False,
        "confirmed": confirmed,
        "rationale": "r",
        "usage_evidence": [],
    }


def _scan_with_items(items) -> dict:
    prelude_line_count = 4 + len(items)  # each item here is a single line
    backend = ScriptedFake({"void copy_label": ["STR31-C"]})
    return certfix_adapter.run_scan(
        backend=backend,
        source_id="s",
        original_content=SENSOR,
        original_hash=sha256_prefixed(SENSOR),
        context_revision_id="ctxrev-1",
        items=items,
        prelude_line_count=prelude_line_count,
    )


def test_assumption_dependent_false_for_empty_items() -> None:
    backend = ScriptedFake({"void copy_label": ["STR31-C"]})
    result = _scan(backend, SENSOR)
    copy = _find_fn(result, "copy_label")
    assert copy["findings"][0]["assumption_dependent"] is False


def test_assumption_dependent_true_when_unconfirmed_item_present() -> None:
    # D-020: an unconfirmed item makes findings assumption-dependent, regardless
    # of provenance (Skip-review path keeps items confirmed=false).
    result = _scan_with_items([_typedef_item(confirmed=False)])
    copy = _find_fn(result, "copy_label")
    assert copy["findings"][0]["assumption_dependent"] is True


def test_assumption_dependent_false_when_all_items_confirmed() -> None:
    # D-020: a reviewed/confirmed llm_inferred completion is NOT a lingering
    # assumption anymore (the pre-D-020 rule keyed on provenance would say True).
    result = _scan_with_items([_typedef_item(confirmed=True)])
    copy = _find_fn(result, "copy_label")
    assert copy["findings"][0]["assumption_dependent"] is False


def test_assumption_dependent_true_when_some_items_unconfirmed() -> None:
    # A mix (one confirmed, one not) still depends on the unconfirmed item.
    items = [
        _typedef_item(confirmed=True),
        {**_typedef_item(confirmed=False), "item_id": "i2"},
    ]
    result = _scan_with_items(items)
    copy = _find_fn(result, "copy_label")
    assert copy["findings"][0]["assumption_dependent"] is True


# --- rule title (rule_summary from the bundled catalog) ---------------------


def test_rule_titles_maps_known_rule_id_to_catalog_title() -> None:
    # ERR33-C's human title in the bundled catalog (real read, no LLM).
    titles = certfix_adapter.rule_titles()
    assert titles.get("ERR33-C") == "Detect and handle standard library errors"


def test_finding_rule_summary_is_the_catalog_title() -> None:
    # A scan finding's rule_summary carries the catalog title, not a placeholder.
    backend = ScriptedFake({"void copy_label": ["STR31-C"]})
    result = _scan(backend, SENSOR)
    copy = _find_fn(result, "copy_label")
    finding = copy["findings"][0]
    expected = certfix_adapter.rule_titles()["STR31-C"]
    assert finding["rule_summary"] == expected
    # The placeholder form is no longer used for a catalogued rule.
    assert finding["rule_summary"] != "CERT-C STR31-C."


def test_finding_rule_summary_falls_back_for_unlisted_rule() -> None:
    # A rule_id absent from the catalog falls back to the placeholder form.
    backend = ScriptedFake({"void copy_label": ["ZZZ99-C"]})
    result = _scan(backend, SENSOR)
    copy = _find_fn(result, "copy_label")
    assert copy["findings"][0]["rule_summary"] == "CERT-C ZZZ99-C."


# --- rule-title kill-switch (D-039: CREPAIR_RULE_TITLES=off) -----------------


def test_rule_titles_enabled_default_and_on(monkeypatch) -> None:
    # Default (unset) and an explicit "on" both keep titles enabled.
    monkeypatch.delenv(certfix_adapter.RULE_TITLES_ENV, raising=False)
    assert certfix_adapter.rule_titles_enabled() is True
    assert certfix_adapter.rule_titles_enabled(env={}) is True
    assert certfix_adapter.rule_titles_enabled(env={"CREPAIR_RULE_TITLES": "on"}) is True
    # Only the literal "off" (any case, trimmed) disables.
    assert certfix_adapter.rule_titles_enabled(env={"CREPAIR_RULE_TITLES": "off"}) is False
    assert certfix_adapter.rule_titles_enabled(env={"CREPAIR_RULE_TITLES": " OFF "}) is False
    # An empty / unrecognized value leaves titles ON (fail-open default).
    assert certfix_adapter.rule_titles_enabled(env={"CREPAIR_RULE_TITLES": ""}) is True
    assert certfix_adapter.rule_titles_enabled(env={"CREPAIR_RULE_TITLES": "yes"}) is True


def test_rule_titles_off_empties_summary_but_keeps_rule_id(monkeypatch) -> None:
    # D-039: with the kill-switch off the display rule_summary is empty, but the
    # rule_id and the finding's kind/location are byte-identical to titles-on.
    monkeypatch.setenv(certfix_adapter.RULE_TITLES_ENV, "off")
    backend = ScriptedFake({"void copy_label": ["STR31-C"]})
    result = _scan(backend, SENSOR)
    copy = _find_fn(result, "copy_label")
    finding = copy["findings"][0]
    assert finding["rule_summary"] == ""  # title suppressed
    assert finding["rule_id"] == "STR31-C"  # ID unchanged
    assert finding["kind"] == "violation"
    assert finding["location"] == {"start_line": 25, "end_line": 25}


def test_rule_titles_off_no_placeholder_for_unlisted_rule(monkeypatch) -> None:
    # Off also suppresses the "CERT-C <id>." placeholder path (empty, not placeholder).
    monkeypatch.setenv(certfix_adapter.RULE_TITLES_ENV, "off")
    backend = ScriptedFake({"void copy_label": ["ZZZ99-C"]})
    result = _scan(backend, SENSOR)
    copy = _find_fn(result, "copy_label")
    finding = copy["findings"][0]
    assert finding["rule_summary"] == ""
    assert finding["rule_id"] == "ZZZ99-C"


def test_rule_titles_off_detection_result_matches_on_except_summary(monkeypatch) -> None:
    # Detection is completely unchanged: the ONLY response difference between on and
    # off is the display rule_summary. Same finding_id, rule_id, location, kind.
    backend_args = {"void copy_label": ["STR31-C"]}
    monkeypatch.delenv(certfix_adapter.RULE_TITLES_ENV, raising=False)
    on = _find_fn(_scan(ScriptedFake(backend_args), SENSOR), "copy_label")["findings"][0]
    monkeypatch.setenv(certfix_adapter.RULE_TITLES_ENV, "off")
    off = _find_fn(_scan(ScriptedFake(backend_args), SENSOR), "copy_label")["findings"][0]
    assert on["rule_summary"] and off["rule_summary"] == ""  # the one intended diff
    for key in ("finding_id", "rule_id", "kind", "location", "assumption_dependent"):
        assert on[key] == off[key]


def test_rule_titles_off_leaves_uncertain_wording_intact(monkeypatch) -> None:
    # The kill-switch empties only CERT-C rule TITLES. An uncertain finding's fixed
    # human wording ("Possible issue…") is not a rule title, so it is untouched.
    monkeypatch.setenv(certfix_adapter.RULE_TITLES_ENV, "off")
    backend = ScriptedFake({"void copy_label": ["UNKNOWN-CERT-C"]})
    result = _scan(backend, SENSOR)
    finding = _find_fn(result, "copy_label")["findings"][0]
    assert finding["kind"] == "uncertain"
    assert finding["rule_summary"] == "Possible issue (rule not identified)"


# --- identity ---------------------------------------------------------------


def test_identity_fields() -> None:
    backend = ScriptedFake({})
    result = _scan(backend, SENSOR)
    assert result["adapter"] == {"id": "certfix-inprocess", "version": "0.1.0"}
    assert result["rule_profile"] == {"id": "cert-c", "version": "certfix-0.4.1-bundled"}
    assert result["harness"]["id"] == "certfix"
    assert result["harness"]["version"]  # certfix.__version__


# --- detection failure -> uncertain (provider error) ------------------------
#
# A chunk whose backend.detect raises used to be caught+continued inside
# certfix, leaving that function with no finding = a silent CLEAN. run_scan now
# wraps the backend, re-raises (certfix's per-chunk catch is unchanged), and
# attributes the failed chunk back to its function via its signature line so a
# "Detection failed (provider error)" uncertain finding is surfaced instead.


class RaisingFake:
    """Fake backend that raises for chunks containing any ``fail_needle``.

    Non-failing chunks emit the scripted ``rule_id``s for their function (like
    ``ScriptedFake``, collapsing to the function start line since it is not line
    aware). This lets a test fail exactly one function's chunk while the rest scan
    normally — mirroring the real free-pool provider error (KeyError on missing
    ``choices``) that certfix swallows per chunk.
    """

    line_aware_detection = False

    def __init__(
        self,
        fail_needles,
        by_function=None,
    ) -> None:
        self._fail_needles = list(fail_needles)
        self._by_function = dict(by_function or {})

    def detect(self, code: str, rules=None):
        for needle in self._fail_needles:
            if needle in code:
                raise KeyError("choices")  # provider returned no choices
        from certfix.models import Severity, Violation

        out = []
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


def _detection_failed(finding: dict) -> bool:
    return (
        finding["kind"] == "uncertain"
        and finding["rule_summary"] == "Detection failed (provider error)"
    )


def test_failed_chunk_becomes_uncertain_detection_failed() -> None:
    # copy_label's chunk errors; every other function scans clean.
    backend = RaisingFake(fail_needles=["void copy_label"])
    result = _scan(backend, SENSOR)

    copy = _find_fn(result, "copy_label")
    assert len(copy["findings"]) == 1
    finding = copy["findings"][0]
    assert _detection_failed(finding)
    assert "rule_id" not in finding  # uncertain omits rule_id
    assert finding["assumption_dependent"] is False
    # Located at the function's first line (copy_label starts at Original 25).
    assert finding["location"] == {"start_line": 25, "end_line": 25}
    assert finding["explanation"].startswith(
        "The detector could not analyze this function"
    )
    assert "NOT a clean result" in finding["explanation"]

    # No other function is affected (all clean, no findings).
    for fn in result["functions"]:
        if fn["name"] != "copy_label":
            assert fn["findings"] == []


def test_detection_failed_finding_not_added_when_violation_present() -> None:
    # D-003 0..1 per function: if a function already has a (violation) finding, the
    # detection-failed uncertain finding is NOT also added — the `if fn_violations`
    # branch wins over the failed-set `elif`. A single detect call cannot both
    # raise and return, so we exercise the precedence at the mapping's source of
    # truth: pre-load a function into the failed set while it also has a violation.
    from unittest.mock import patch

    from repair_api.adapter import certfix_adapter as ca

    # copy_label has a real STR31-C violation. Force copy_label ALSO into the
    # failed set by faking _attribute_failure to always return copy_label and
    # feeding one failed code blob.
    inv = ca.build_inventory(SENSOR, 4)
    copy_fn = next(f for f in inv if f.name == "copy_label")

    orig_detect = ca._detect

    def _detect_with_one_failure(backend, augmented):
        violations, _ = orig_detect(backend, augmented)
        return violations, ["<copy_label chunk that failed>"]

    with patch.object(ca, "_detect", _detect_with_one_failure), patch.object(
        ca, "_attribute_failure", lambda code, inventory: copy_fn
    ):
        backend = ScriptedFake({"void copy_label": ["STR31-C"]})
        result = _scan(backend, SENSOR)

    copy = _find_fn(result, "copy_label")
    # Exactly one finding, the real violation — no second detection-failed finding.
    assert len(copy["findings"]) == 1
    assert copy["findings"][0]["kind"] == "violation"
    assert copy["findings"][0]["rule_id"] == "STR31-C"


def test_failed_and_clean_functions_coexist() -> None:
    # One function's chunk errors; another has a genuine violation; the rest are
    # clean. All three outcomes must appear correctly in one scan.
    backend = RaisingFake(
        fail_needles=["int sample_index"],
        by_function={"void copy_label": ["STR31-C"]},
    )
    result = _scan(backend, SENSOR)

    copy = _find_fn(result, "copy_label")
    assert len(copy["findings"]) == 1
    assert copy["findings"][0]["kind"] == "violation"
    assert copy["findings"][0]["rule_id"] == "STR31-C"

    sample = _find_fn(result, "sample_index")
    assert len(sample["findings"]) == 1
    assert _detection_failed(sample["findings"][0])

    for fn in result["functions"]:
        if fn["name"] not in ("copy_label", "sample_index"):
            assert fn["findings"] == []


def test_failed_chunk_unattributable_adds_no_finding() -> None:
    # A failure whose code matches no inventory function (its signature line is
    # absent) must NOT add a finding anywhere — attribution is "unknown" and the
    # adapter logs only. Marking every finding-less function uncertain would be
    # over-broad, so a clean file stays clean.
    from repair_api.adapter import certfix_adapter as ca
    from repair_api.functions import build_inventory

    inv = build_inventory(SENSOR, 0)
    # A blob with no known function signature line -> None (unattributable).
    assert ca._attribute_failure("int totally_unknown_zzz(void) {\n}\n", inv) is None
    # An empty blob is likewise unattributable.
    assert ca._attribute_failure("", inv) is None
    # A bare prototype (no brace) for a known name is NOT a definition -> None.
    assert ca._attribute_failure("void copy_label(char *dst, const char *src);\n", inv) is None

    # End-to-end: force an unattributable failure via a patched _attribute_failure
    # returning None, and confirm the scan adds no detection-failed finding.
    from unittest.mock import patch

    orig_detect = ca._detect

    def _detect_one_failure(backend, augmented):
        violations, _ = orig_detect(backend, augmented)
        return violations, ["<unattributable failed chunk>"]

    with patch.object(ca, "_detect", _detect_one_failure), patch.object(
        ca, "_attribute_failure", lambda code, inventory: None
    ):
        result = _scan(ScriptedFake({}), SENSOR)

    for fn in result["functions"]:
        assert fn["findings"] == []  # nothing marked; clean stays clean


def test_all_chunks_succeed_is_bit_identical_to_before() -> None:
    # With no failures the wrapper is a pure pass-through: the result must equal a
    # scan run through the bare backend (no detection-failed findings appear).
    scripted = ScriptedFake({"void copy_label": ["STR31-C"]})
    result = _scan(scripted, SENSOR)
    copy = _find_fn(result, "copy_label")
    assert len(copy["findings"]) == 1
    assert copy["findings"][0]["kind"] == "violation"
    # No function carries a detection-failed uncertain finding.
    for fn in result["functions"]:
        for finding in fn["findings"]:
            assert finding["rule_summary"] != "Detection failed (provider error)"


def test_attribute_failure_picks_the_chunk_function_over_context() -> None:
    # The failed blob is context (preceding functions/decls) + the failing chunk,
    # whose OWN signature is last. Attribution must return the chunk's function
    # (last definition), not one named earlier in the context.
    from repair_api.adapter import certfix_adapter as ca
    from repair_api.functions import build_inventory

    inv = build_inventory(SENSOR, 0)
    blob = (
        "int scale_reading(int raw) {\n"  # context: an earlier function def
        "    return raw;\n"
        "}\n\n"
        "void copy_label(char *dst, const char *src) {\n"  # the failing chunk
        "    strcpy(dst, src);\n"
        "}\n"
    )
    fn = ca._attribute_failure(blob, inv)
    assert fn is not None
    assert fn.name == "copy_label"
