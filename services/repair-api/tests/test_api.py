"""Endpoint tests via FastAPI TestClient (PHASE3A_DESIGN §2, V2_CONTEXT_BUILDER §1).

Covers /health identity + capabilities, /context/infer (item synthesis from
missing symbols + empty draft for self-contained sources), /context/check
(compiles true/false + missing_symbols + 409), /context/confirm idempotency,
/scan happy path (fake backend) + schema conformance + 409 cases, /repair happy
path + 409/422 + include-path forwarding, and Bearer-token auth. No LLM is called:
detection uses a fake backend and the fix/infer backends are injected fakes; the
compile probe uses real gcc (present in CI).
"""

from __future__ import annotations

import json
from pathlib import Path

import jsonschema
import pytest
from conftest import ScriptedFake, sha256_prefixed
from fastapi.testclient import TestClient

import certfix
from repair_api.main import create_app

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURES = REPO_ROOT / "tests" / "fixtures"
SCHEMAS = REPO_ROOT / "packages" / "contract" / "schemas"
SENSOR = (FIXTURES / "source" / "sample_sensor.c").read_text()


def _load_schema(name: str) -> dict:
    return json.loads((SCHEMAS / name).read_text())


def _source_document(content: str = SENSOR) -> dict:
    return {
        "source_id": "src-sample-sensor",
        "filename": "sample_sensor.c",
        "language": "c",
        "content": content,
        "content_hash": sha256_prefixed(content),
        "size_bytes": len(content.encode("utf-8")),
        "origin": "web_upload",
    }


@pytest.fixture
def client() -> TestClient:
    # Inject a fake backend so /scan never touches an LLM.
    fake = ScriptedFake({"void copy_label": ["STR31-C"], "int scale_reading": ["INT32-C"]})
    app = create_app(backend_factory=lambda: fake)
    return TestClient(app)


# --- /health ----------------------------------------------------------------


def test_health_identity(client: TestClient) -> None:
    resp = client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    # Identity is now `harness` (D-017a rename), not `engine`.
    assert body["harness"] == {"id": "certfix", "version": certfix.__version__}
    assert body["adapter"] == {"id": "certfix-inprocess", "version": "0.1.0"}
    assert "engine" not in body


def test_health_shape_and_capabilities(client: TestClient) -> None:
    """/health returns the extended shape (VSCODE_PIVOT_PLAN §2)."""
    body = client.get("/health").json()

    # No stray keys; exactly the documented top-level fields.
    assert set(body.keys()) == {
        "status",
        "harness",
        "adapter",
        "contract_version",
        "capabilities",
    }
    assert body["contract_version"] == "1"

    caps = body["capabilities"]
    # Additive fields join the base capabilities: model / provider_order (D-019),
    # reasoning_effort (D-028), detection_reasoning (D-029), provider_policy
    # (D-019 follow-up), and rule_titles (D-039 legal kill-switch).
    assert set(caps.keys()) == {
        "rule_profile",
        "rules_count",
        "gates",
        "routes",
        "model",
        "provider_order",
        "reasoning_effort",
        "detection_reasoning",
        "provider_policy",
        "rule_titles",
    }
    assert caps["rule_profile"] == "cert-c"
    assert caps["gates"] == [
        "format",
        "compile",
        "violation_removal",
        "semantic",
        "regression",
    ]
    assert caps["routes"] == ["api"]
    # rules_count: dynamic from the bundled catalog; 115 per docs/SUPPORTED_RULES.md.
    assert isinstance(caps["rules_count"], int)
    assert caps["rules_count"] == 115


def test_health_reports_bundled_effective_model_and_provider(client: TestClient) -> None:
    """/health surfaces the effective model / provider (D-019), default = bundled."""
    caps = client.get("/health").json()["capabilities"]
    # Bundled deepseek-v4-flash-openrouter.yaml: DeepInfra-pinned deepseek-v4-flash.
    assert caps["model"] == "deepseek/deepseek-v4-flash-0731"
    assert caps["provider_order"] == ["DeepInfra"]


def test_health_reports_no_provider_policy_by_default(client: TestClient) -> None:
    """Without CREPAIR_PROVIDER_POLICY, /health reports provider_policy "none" (D-019 follow-up)."""
    caps = client.get("/health").json()["capabilities"]
    assert caps["provider_policy"] == "none"


def test_health_reports_effective_provider_policy(monkeypatch) -> None:
    """CREPAIR_PROVIDER_POLICY with an empty order surfaces in /health (D-019 follow-up)."""
    monkeypatch.setenv("CREPAIR_PROVIDER_ORDER", "")  # empty pin => policy applies
    monkeypatch.setenv("CREPAIR_PROVIDER_POLICY", "private-cheap")
    app = create_app(backend_factory=lambda: ScriptedFake({}))
    caps = TestClient(app).get("/health").json()["capabilities"]
    assert caps["provider_policy"] == "private-cheap"
    assert caps["provider_order"] == []  # ZDR + cheapest-first automatic routing


def test_health_reports_rule_titles_on_by_default(client: TestClient) -> None:
    """Without CREPAIR_RULE_TITLES, /health reports rule_titles "on" (D-039)."""
    caps = client.get("/health").json()["capabilities"]
    assert caps["rule_titles"] == "on"


def test_health_reports_rule_titles_off_when_env_set(monkeypatch) -> None:
    """CREPAIR_RULE_TITLES=off surfaces as rule_titles "off" in /health (D-039)."""
    monkeypatch.setenv("CREPAIR_RULE_TITLES", "off")
    app = create_app(backend_factory=lambda: ScriptedFake({}))
    caps = TestClient(app).get("/health").json()["capabilities"]
    assert caps["rule_titles"] == "off"


def test_health_rule_titles_on_for_unrecognized_value(monkeypatch) -> None:
    """Any value other than 'off' (e.g. 'on', a typo) keeps rule_titles on (D-039)."""
    monkeypatch.setenv("CREPAIR_RULE_TITLES", "on")
    app = create_app(backend_factory=lambda: ScriptedFake({}))
    caps = TestClient(app).get("/health").json()["capabilities"]
    assert caps["rule_titles"] == "on"


def test_health_reports_env_overridden_model_and_provider(monkeypatch) -> None:
    """CREPAIR_* env overrides are reflected in /health capabilities (D-019)."""
    monkeypatch.setenv("CREPAIR_MODEL_ID", "anthropic/claude-3.5-sonnet")
    monkeypatch.setenv("CREPAIR_PROVIDER_ORDER", "")  # explicit empty => automatic
    app = create_app(backend_factory=lambda: ScriptedFake({}))
    caps = TestClient(app).get("/health").json()["capabilities"]
    assert caps["model"] == "anthropic/claude-3.5-sonnet"
    assert caps["provider_order"] == []  # automatic routing (pin removed)


def test_health_reports_bundled_reasoning_effort(client: TestClient) -> None:
    """/health surfaces the fix-role reasoning effort + detection off (D-028/D-029)."""
    caps = client.get("/health").json()["capabilities"]
    # Bundled config pins the fix role at xhigh; detection reasoning is fixed off.
    assert caps["reasoning_effort"] == "xhigh"
    assert caps["detection_reasoning"] == "off"


def test_health_reports_env_overridden_reasoning_effort(monkeypatch) -> None:
    """CREPAIR_REASONING_EFFORT affects the fix role only, not detection (D-029)."""
    monkeypatch.setenv("CREPAIR_REASONING_EFFORT", "low")
    app = create_app(backend_factory=lambda: ScriptedFake({}))
    caps = TestClient(app).get("/health").json()["capabilities"]
    assert caps["reasoning_effort"] == "low"
    # Detection stays off regardless of the override (D-029).
    assert caps["detection_reasoning"] == "off"


def test_health_reasoning_effort_off(monkeypatch) -> None:
    """CREPAIR_REASONING_EFFORT=off surfaces as 'off' for the fix role (D-028/D-029)."""
    monkeypatch.setenv("CREPAIR_REASONING_EFFORT", "off")
    app = create_app(backend_factory=lambda: ScriptedFake({}))
    caps = TestClient(app).get("/health").json()["capabilities"]
    assert caps["reasoning_effort"] == "off"
    assert caps["detection_reasoning"] == "off"


# --- /context/infer ---------------------------------------------------------

# A context-poor source whose external symbols gcc reports as missing. The infer
# path compile-probes this (real gcc is present in CI), extracts the symbols and
# asks the injected fake backend for declarations.
INFER_SRC = (
    "int over_threshold(void) {\n"
    "    Sensor s;\n"
    "    int v = read_sensor(0);\n"
    "    if (v > THRESHOLD) {\n"
    "        return limit;\n"
    "    }\n"
    "    return v;\n"
    "}\n"
)

# A self-contained source that compiles as-is -> infer must return an empty draft.
SELF_CONTAINED_SRC = "int add(int a, int b) {\n    return a + b;\n}\n"

_INFER_RESPONSE = (
    "### symbol: Sensor\n```c\ntypedef struct { int ch; } Sensor;\n```\n"
    "### symbol: read_sensor\n```c\nint read_sensor(int channel);\n```\n"
    "### symbol: THRESHOLD\n```c\n#define THRESHOLD 100\n```\n"
    "### symbol: limit\n```c\nextern int limit;\n```\n"
)


class _InferBackendFake:
    """Fake fix-role backend returning a scripted infer response verbatim."""

    def __init__(self, out: str) -> None:
        self._out = out

    def generate(self, prompt: str, max_tokens: int = 1024, temperature: float = 0.0) -> str:
        return self._out

    def is_available(self) -> bool:
        return True


def _infer_deps(out: str = _INFER_RESPONSE):
    """A RepairDeps whose fix backend scripts an infer response; real gcc probes."""
    from certfix.config import CompileValidationConfig

    from repair_api.adapter import repair as repair_adapter
    from repair_api.main import RepairDeps

    config = repair_adapter.RepairConfig(
        simple_repair_profile="qwen36_27b_complete_repair_rule_guided_v1",
        simple_max_tokens=4096,
        model_name="fake-model-1",
        compile_config=CompileValidationConfig(),
        compile_enabled=True,  # real gcc present in CI -> probe runs
        violation_removal_enabled=False,
        violation_removal_method="non_target_advisory",
        violation_removal_max_tokens=512,
        violation_removal_override_denylist=[],
        semantic_enabled=False,
    )
    return RepairDeps(backend=_InferBackendFake(out), config=config)


def _infer_client(out: str = _INFER_RESPONSE) -> TestClient:
    return TestClient(
        create_app(backend_factory=lambda: ScriptedFake({}), repair_factory=lambda: _infer_deps(out))
    )


def test_context_infer_synthesizes_items_from_missing_symbols() -> None:
    src = _source_document(INFER_SRC)
    resp = _infer_client().post("/context/infer", json={"source_document": src})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "draft"
    assert body["context_revision_id"] is None
    assert body["original_hash"] == src["content_hash"]
    jsonschema.validate(body, _load_schema("context-augmentation-set.schema.json"))

    kinds = {it["generated_text"]: it["kind"] for it in body["items"]}
    assert kinds["typedef struct { int ch; } Sensor;"] == "inferred_type"
    assert kinds["int read_sensor(int channel);"] == "external_function_declaration"
    assert kinds["#define THRESHOLD 100"] == "inferred_macro"
    assert kinds["extern int limit;"] == "external_global"
    # Draft items are unconfirmed and llm-inferred (D-020).
    assert all(it["confirmed"] is False for it in body["items"])
    assert all(it["provenance"] == "llm_inferred" for it in body["items"])
    # prelude_line_count matches the compose rule (4 + item line counts).
    from repair_api import compose as _compose

    assert body["prelude_line_count"] == _compose.synthesized_prelude_line_count(body["items"])


def test_context_infer_self_contained_source_is_empty_draft() -> None:
    src = _source_document(SELF_CONTAINED_SRC)
    resp = _infer_client().post("/context/infer", json={"source_document": src})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "draft"
    assert body["context_revision_id"] is None
    assert body["items"] == []
    assert body["prelude_line_count"] == 4
    jsonschema.validate(body, _load_schema("context-augmentation-set.schema.json"))


def test_context_infer_prefers_infer_backend_over_fix_backend() -> None:
    # When the factory supplies a dedicated infer backend (fix role with
    # reasoning disabled), /context/infer must use IT — the fix backend's
    # (different) response must not appear in the draft.
    deps = _infer_deps(_INFER_RESPONSE)  # fix backend would emit all 4 items
    deps.infer_backend = _InferBackendFake(
        "### symbol: THRESHOLD\n```c\n#define THRESHOLD 100\n```\n"
    )
    client = TestClient(
        create_app(backend_factory=lambda: ScriptedFake({}), repair_factory=lambda: deps)
    )
    resp = client.post("/context/infer", json={"source_document": _source_document(INFER_SRC)})
    assert resp.status_code == 200, resp.text
    gen = [it["generated_text"] for it in resp.json()["items"]]
    assert gen == ["#define THRESHOLD 100"]


def test_context_infer_falls_back_to_fix_backend_without_infer_backend() -> None:
    # RepairDeps without infer_backend (the pre-infer-role shape, and every test
    # fake): the endpoint falls back to the fix backend and still infers.
    resp = _infer_client().post(
        "/context/infer", json={"source_document": _source_document(INFER_SRC)}
    )
    assert resp.status_code == 200, resp.text
    assert len(resp.json()["items"]) == 4


def test_context_infer_stubs_missing_local_header_and_synthesizes_items() -> None:
    # Real gcc: the source's ``#include "proj_defs.h"`` is absent, so a naive probe
    # would stop at the include and infer 0 symbols. The two-stage probe stubs the
    # header, the type/undeclared errors surface, and the fix backend completes them.
    src = _source_document('#include "proj_defs.h"\n' + INFER_SRC)
    resp = _infer_client().post("/context/infer", json={"source_document": src})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "draft"
    kinds = {it["generated_text"]: it["kind"] for it in body["items"]}
    assert kinds["typedef struct { int ch; } Sensor;"] == "inferred_type"
    assert kinds["int read_sensor(int channel);"] == "external_function_declaration"
    jsonschema.validate(body, _load_schema("context-augmentation-set.schema.json"))


# --- /context/check ---------------------------------------------------------


def _check_confirmed_set(items=None) -> dict:
    return {
        "set_id": "augset-check",
        "source_id": "src-sample-sensor",
        "original_hash": sha256_prefixed(INFER_SRC),
        "status": "draft",
        "context_revision_id": None,
        "prelude_line_count": 4,
        "items": items or [],
    }


def test_context_check_compiles_false_lists_missing_symbols() -> None:
    src = _source_document(INFER_SRC)
    resp = _infer_client().post(
        "/context/check",
        json={"source_document": src, "context_augmentation_set": _check_confirmed_set()},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["compiles"] is False
    assert body["missing_symbols"] == ["Sensor", "read_sensor", "THRESHOLD", "limit"]


def test_context_check_compiles_true_when_context_completes_source() -> None:
    # Provide declarations for every missing symbol -> the Augmented C compiles.
    def _item(item_id: str, text: str, kind: str) -> dict:
        return {
            "item_id": item_id,
            "kind": kind,
            "generated_text": text,
            "current_text": text,
            "provenance": "llm_inferred",
            "user_edited": False,
            "confirmed": True,
            "rationale": "r",
            "usage_evidence": [],
        }

    items = [
        _item("a1", "typedef struct { int ch; } Sensor;", "inferred_type"),
        _item("a2", "int read_sensor(int channel);", "external_function_declaration"),
        _item("a3", "#define THRESHOLD 100", "inferred_macro"),
        _item("a4", "int limit;", "external_global"),
    ]
    src = _source_document(INFER_SRC)
    resp = _infer_client().post(
        "/context/check",
        json={"source_document": src, "context_augmentation_set": _check_confirmed_set(items)},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["compiles"] is True
    assert body["missing_symbols"] == []


# A context-poor source whose declarations would live in a quoted project header
# absent in this single-file context: the check's two-stage probe must stub it.
INFER_SRC_WITH_INCLUDE = '#include "proj_defs.h"\n' + INFER_SRC


def _check_set_for(source: str, items=None) -> dict:
    return {
        "set_id": "augset-check",
        "source_id": "src-sample-sensor",
        "original_hash": sha256_prefixed(source),
        "status": "draft",
        "context_revision_id": None,
        "prelude_line_count": 4,
        "items": items or [],
    }


def test_context_check_reports_stubbed_headers() -> None:
    # Real gcc: the first probe stops at the missing quoted header; the stub lets
    # the include pass so the type/undeclared symbols surface. stubbed_headers names
    # the header; missing_symbols lists what the context must still declare.
    src = _source_document(INFER_SRC_WITH_INCLUDE)
    resp = _infer_client().post(
        "/context/check",
        json={
            "source_document": src,
            "context_augmentation_set": _check_set_for(INFER_SRC_WITH_INCLUDE),
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["compiles"] is False
    assert body["stubbed_headers"] == ["proj_defs.h"]
    assert body["missing_symbols"] == ["Sensor", "read_sensor", "THRESHOLD", "limit"]


def test_context_check_no_stubbed_headers_field_defaults_empty() -> None:
    # The all-symbols-missing but no-include case reports an empty stubbed_headers.
    src = _source_document(INFER_SRC)
    resp = _infer_client().post(
        "/context/check",
        json={"source_document": src, "context_augmentation_set": _check_confirmed_set()},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["stubbed_headers"] == []


def test_context_check_409_on_hash_mismatch() -> None:
    src = _source_document(INFER_SRC)
    bad_set = _check_confirmed_set()
    bad_set["original_hash"] = "sha256:" + "0" * 64
    resp = _infer_client().post(
        "/context/check",
        json={"source_document": src, "context_augmentation_set": bad_set},
    )
    assert resp.status_code == 409


# --- /context/confirm -------------------------------------------------------


def _draft_set() -> dict:
    src = _source_document()
    return {
        "set_id": "augset-src-sample-sensor",
        "source_id": src["source_id"],
        "original_hash": src["content_hash"],
        "status": "draft",
        "context_revision_id": None,
        "prelude_line_count": 4,
        "items": [],
    }


def test_context_confirm_is_idempotent(client: TestClient) -> None:
    body = {"context_augmentation_set": _draft_set()}
    r1 = client.post("/context/confirm", json=body)
    r2 = client.post("/context/confirm", json=body)
    assert r1.status_code == 200 and r2.status_code == 200
    s1, s2 = r1.json(), r2.json()
    assert s1["status"] == "confirmed"
    assert s1["context_revision_id"] is not None
    assert s1["context_revision_id"] == s2["context_revision_id"]
    jsonschema.validate(s1, _load_schema("context-augmentation-set.schema.json"))


# --- /scan ------------------------------------------------------------------


def _confirmed_set() -> dict:
    s = _draft_set()
    s["status"] = "confirmed"
    # revision must be non-null and match what confirm would produce, but /scan
    # only checks status + hash, not the revision value.
    s["context_revision_id"] = "ctxrev-abc123def456"
    return s


def test_scan_happy_path_conforms_to_schema(client: TestClient) -> None:
    resp = client.post(
        "/scan",
        json={
            "source_document": _source_document(),
            "context_augmentation_set": _confirmed_set(),
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    jsonschema.validate(body, _load_schema("function-scan-result.schema.json"))

    # Structural expectations from the injected fake.
    by_name = {fn["name"]: fn for fn in body["functions"]}
    assert by_name["copy_label"]["findings"][0]["rule_id"] == "STR31-C"
    assert by_name["scale_reading"]["findings"][0]["rule_id"] == "INT32-C"
    assert by_name["average_two"]["findings"] == []
    assert body["context_revision_id"] == "ctxrev-abc123def456"


def test_scan_rule_titles_off_empties_summary_end_to_end(monkeypatch) -> None:
    # D-039: with the bridge run under CREPAIR_RULE_TITLES=off, a /scan response's
    # findings carry an EMPTY rule_summary while the rule_id is unchanged, and the
    # body still validates against the contract schema (empty string is allowed).
    monkeypatch.setenv("CREPAIR_RULE_TITLES", "off")
    fake = ScriptedFake({"void copy_label": ["STR31-C"], "int scale_reading": ["INT32-C"]})
    app = create_app(backend_factory=lambda: fake)
    resp = TestClient(app).post(
        "/scan",
        json={
            "source_document": _source_document(),
            "context_augmentation_set": _confirmed_set(),
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    jsonschema.validate(body, _load_schema("function-scan-result.schema.json"))
    by_name = {fn["name"]: fn for fn in body["functions"]}
    copy_finding = by_name["copy_label"]["findings"][0]
    assert copy_finding["rule_id"] == "STR31-C"  # ID unchanged
    assert copy_finding["rule_summary"] == ""  # title suppressed
    assert by_name["scale_reading"]["findings"][0]["rule_summary"] == ""


def test_scan_rule_titles_on_by_default_keeps_summary(client: TestClient) -> None:
    # Default (no env): the finding's rule_summary carries the catalog title, so
    # the kill-switch is genuinely opt-in and the normal path is unchanged.
    resp = client.post(
        "/scan",
        json={
            "source_document": _source_document(),
            "context_augmentation_set": _confirmed_set(),
        },
    )
    assert resp.status_code == 200, resp.text
    by_name = {fn["name"]: fn for fn in resp.json()["functions"]}
    assert by_name["copy_label"]["findings"][0]["rule_summary"]  # non-empty title


def test_scan_409_when_set_is_draft(client: TestClient) -> None:
    resp = client.post(
        "/scan",
        json={
            "source_document": _source_document(),
            "context_augmentation_set": _draft_set(),  # status=draft
        },
    )
    assert resp.status_code == 409


def test_scan_409_when_hash_mismatch(client: TestClient) -> None:
    confirmed = _confirmed_set()
    confirmed["original_hash"] = "sha256:" + "0" * 64  # deliberate mismatch
    resp = client.post(
        "/scan",
        json={
            "source_document": _source_document(),
            "context_augmentation_set": confirmed,
        },
    )
    assert resp.status_code == 409


def test_scan_rejects_confirmed_with_null_revision(client: TestClient) -> None:
    confirmed = _confirmed_set()
    confirmed["context_revision_id"] = None
    resp = client.post(
        "/scan",
        json={
            "source_document": _source_document(),
            "context_augmentation_set": confirmed,
        },
    )
    assert resp.status_code == 409


# --- /repair ----------------------------------------------------------------


def _violation_finding() -> dict:
    return {
        "finding_id": "find-copy-str31",
        "kind": "violation",
        "rule_id": "STR31-C",
        "rule_summary": "CERT-C STR31-C.",
        "explanation": "strcpy into a fixed buffer.",
        "location": {"start_line": 25, "end_line": 25},
        "assumption_dependent": False,
    }


def _uncertain_finding() -> dict:
    return {
        "finding_id": "find-uncertain",
        "kind": "uncertain",
        "rule_summary": "Potential issue.",
        "explanation": "undetermined rule",
        "location": {"start_line": 25, "end_line": 25},
        "assumption_dependent": False,
    }


def _repair_deps():
    """A RepairDeps whose fake fix backend rewrites copy_label's strcpy line.

    The fix is built by preprocessing the composed Augmented C and editing the
    target line, mirroring what a CODE_ONLY model returns. No LLM is called.
    """
    from certfix.config import CompileValidationConfig
    from certfix.core.preprocessor import Preprocessor
    from conftest import FixBackendFake

    from repair_api import compose
    from repair_api.adapter import repair as repair_adapter
    from repair_api.main import RepairDeps

    augmented = compose.compose_augmented_c([], SENSOR)
    processed, _m, _i = Preprocessor(keep_comments=False).process(augmented)
    lines = processed.split("\n")
    idx = next(i for i, l in enumerate(lines) if "strcpy" in l)
    lines[idx] = lines[idx].replace("strcpy", "strncpy") + "  /* bounded */"
    fixed = "\n".join(lines)

    config = repair_adapter.RepairConfig(
        simple_repair_profile="qwen36_27b_complete_repair_rule_guided_v1",
        simple_max_tokens=4096,
        model_name="fake-model-1",
        compile_config=CompileValidationConfig(),
        compile_enabled=False,  # compile skipped in-test (no compiler dependency)
        violation_removal_enabled=False,
        violation_removal_method="non_target_advisory",
        violation_removal_max_tokens=512,
        violation_removal_override_denylist=["SIG34-C", "STR31-C"],
        semantic_enabled=False,
    )
    return RepairDeps(backend=FixBackendFake(fixed_code=fixed), config=config)


def _repair_client() -> TestClient:
    app = create_app(
        backend_factory=lambda: ScriptedFake({}),
        repair_factory=_repair_deps,
    )
    return TestClient(app)


def test_repair_happy_path_returns_candidate_conforming_to_schema() -> None:
    c = _repair_client()
    resp = c.post(
        "/repair",
        json={
            "source_document": _source_document(),
            "context_augmentation_set": _confirmed_set(),
            "function_id": "fn-copy_label-25",
            "finding": _violation_finding(),
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    jsonschema.validate(body, _load_schema("repair-candidate.schema.json"))
    assert body["status"] == "repair_ready"
    assert body["finding_id"] == "find-copy-str31"
    assert body["function_id"] == "fn-copy_label-25"
    assert len(body["hunks"]) >= 1
    # compile gate disabled in this test's config -> recorded skipped.
    assert any(v["name"] == "compile" and v["status"] == "skipped" for v in body["validations"])


def test_repair_409_when_set_is_draft() -> None:
    c = _repair_client()
    resp = c.post(
        "/repair",
        json={
            "source_document": _source_document(),
            "context_augmentation_set": _draft_set(),  # status=draft
            "function_id": "fn-copy_label-25",
            "finding": _violation_finding(),
        },
    )
    assert resp.status_code == 409


def test_repair_409_when_hash_mismatch() -> None:
    c = _repair_client()
    confirmed = _confirmed_set()
    confirmed["original_hash"] = "sha256:" + "0" * 64
    resp = c.post(
        "/repair",
        json={
            "source_document": _source_document(),
            "context_augmentation_set": confirmed,
            "function_id": "fn-copy_label-25",
            "finding": _violation_finding(),
        },
    )
    assert resp.status_code == 409


def test_repair_422_when_finding_is_uncertain() -> None:
    c = _repair_client()
    resp = c.post(
        "/repair",
        json={
            "source_document": _source_document(),
            "context_augmentation_set": _confirmed_set(),
            "function_id": "fn-copy_label-25",
            "finding": _uncertain_finding(),
        },
    )
    assert resp.status_code == 422


def test_repair_forwards_compile_include_paths(monkeypatch) -> None:
    # The /repair endpoint must pass the request's compile_include_paths through
    # to the adapter's run_repair (D-020). Spy on run_repair; no LLM, no compiler.
    from repair_api.adapter import repair as repair_adapter

    captured: dict = {}
    real = repair_adapter.run_repair

    def spy(*args, **kwargs):
        captured["compile_include_paths"] = kwargs.get("compile_include_paths")
        return real(*args, **kwargs)

    monkeypatch.setattr(repair_adapter, "run_repair", spy)

    c = _repair_client()
    resp = c.post(
        "/repair",
        json={
            "source_document": _source_document(),
            "context_augmentation_set": _confirmed_set(),
            "function_id": "fn-copy_label-25",
            "finding": _violation_finding(),
            "compile_include_paths": ["/proj/include", "/proj/vendor"],
        },
    )
    assert resp.status_code == 200, resp.text
    assert captured["compile_include_paths"] == ["/proj/include", "/proj/vendor"]


def test_repair_defaults_compile_include_paths_to_empty(monkeypatch) -> None:
    # Omitting the field yields [] (default) — pre-D-020 behaviour is unchanged.
    from repair_api.adapter import repair as repair_adapter

    captured: dict = {}
    real = repair_adapter.run_repair

    def spy(*args, **kwargs):
        captured["compile_include_paths"] = kwargs.get("compile_include_paths")
        return real(*args, **kwargs)

    monkeypatch.setattr(repair_adapter, "run_repair", spy)

    c = _repair_client()
    resp = c.post(
        "/repair",
        json={
            "source_document": _source_document(),
            "context_augmentation_set": _confirmed_set(),
            "function_id": "fn-copy_label-25",
            "finding": _violation_finding(),
        },
    )
    assert resp.status_code == 200, resp.text
    assert captured["compile_include_paths"] == []


def test_scan_accepts_but_ignores_compile_include_paths(client: TestClient) -> None:
    # /scan accepts the additive field (does not 422) but does not use it.
    resp = client.post(
        "/scan",
        json={
            "source_document": _source_document(),
            "context_augmentation_set": _confirmed_set(),
            "compile_include_paths": ["/proj/include"],
        },
    )
    assert resp.status_code == 200, resp.text
    jsonschema.validate(resp.json(), _load_schema("function-scan-result.schema.json"))


def test_repair_401_in_token_mode_without_header() -> None:
    app = create_app(
        backend_factory=lambda: ScriptedFake({}),
        repair_factory=_repair_deps,
        bridge_token="secret-token-xyz",
    )
    c = TestClient(app)
    resp = c.post(
        "/repair",
        json={
            "source_document": _source_document(),
            "context_augmentation_set": _confirmed_set(),
            "function_id": "fn-copy_label-25",
            "finding": _violation_finding(),
        },
    )
    assert resp.status_code == 401


# --- extra="forbid" validation ----------------------------------------------


def test_extra_fields_are_rejected(client: TestClient) -> None:
    src = _source_document()
    src["unexpected_field"] = "x"
    resp = client.post("/context/infer", json={"source_document": src})
    assert resp.status_code == 422


# --- Bearer token auth (D-017d) ---------------------------------------------


def _token_client() -> TestClient:
    fake = ScriptedFake({})
    app = create_app(backend_factory=lambda: fake, bridge_token="secret-token-xyz")
    return TestClient(app)


def test_token_mode_correct_token_is_200() -> None:
    c = _token_client()
    resp = c.get("/health", headers={"Authorization": "Bearer secret-token-xyz"})
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


def test_token_mode_missing_header_is_401() -> None:
    c = _token_client()
    resp = c.get("/health")
    assert resp.status_code == 401


def test_token_mode_wrong_token_is_401() -> None:
    c = _token_client()
    resp = c.get("/health", headers={"Authorization": "Bearer wrong-token"})
    assert resp.status_code == 401


def test_token_mode_malformed_header_is_401() -> None:
    c = _token_client()
    # Raw token without the "Bearer " scheme prefix must be rejected.
    resp = c.get("/health", headers={"Authorization": "secret-token-xyz"})
    assert resp.status_code == 401


def test_token_mode_protects_all_endpoints() -> None:
    c = _token_client()
    # A POST endpoint is also gated, not just /health.
    resp = c.post("/context/infer", json={"source_document": _source_document()})
    assert resp.status_code == 401


def test_no_token_mode_is_unauthenticated(client: TestClient) -> None:
    # The default `client` fixture creates the app without a bridge_token, so no
    # Authorization header is required (dev mode).
    assert client.get("/health").status_code == 200


def test_empty_token_env_disables_auth() -> None:
    # An empty/whitespace token is treated as unset -> no auth required.
    fake = ScriptedFake({})
    app = create_app(backend_factory=lambda: fake, bridge_token="   ")
    c = TestClient(app)
    assert c.get("/health").status_code == 200
