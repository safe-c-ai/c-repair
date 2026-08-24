"""Pydantic models mirroring the contract JSON Schemas (CONTRACT.md §2).

Field names and enums are kept in exact correspondence with
``packages/contract/schemas/*.schema.json``. Every model sets
``extra="forbid"`` which is the Pydantic equivalent of ``additionalProperties:
false`` in the schemas. The authoritative artifacts remain the JSON Schemas;
schema-conformance of responses is asserted in tests via ``jsonschema`` against
those files.
"""

from __future__ import annotations

from typing import List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


class _Strict(BaseModel):
    """Base with additionalProperties:false semantics."""

    model_config = ConfigDict(extra="forbid")


# --- shared definitions -----------------------------------------------------


class IdVersion(_Strict):
    id: str
    version: str


class Range(_Strict):
    start_line: int = Field(ge=1)
    end_line: int = Field(ge=1)


# --- source-document.schema.json --------------------------------------------


class SourceDocument(_Strict):
    source_id: str
    filename: str
    language: Literal["c"]
    content: str
    content_hash: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    size_bytes: int = Field(ge=0)
    origin: Literal["web_upload", "vscode_document", "fixture"]


# --- context-augmentation-set.schema.json -----------------------------------


class UsageEvidence(_Strict):
    line: int = Field(ge=1)
    snippet: str


class AugmentationItem(_Strict):
    item_id: str
    kind: Literal[
        "inferred_type",
        "external_global",
        "external_function_declaration",
        "external_function_stub",
        "inferred_macro",
        "opaque_type",
        "validation_helper",
        "other",
    ]
    generated_text: str
    current_text: str
    provenance: Literal[
        "exact_same_file",
        "derived_from_usage",
        "llm_inferred",
        "user_corrected",
    ]
    user_edited: bool
    confirmed: bool
    rationale: str
    usage_evidence: List[UsageEvidence]


class ContextAugmentationSet(_Strict):
    set_id: str
    source_id: str
    original_hash: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    status: Literal["draft", "confirmed"]
    context_revision_id: Optional[str]
    prelude_line_count: int = Field(ge=0)
    items: List[AugmentationItem]


# --- function-scan-result.schema.json ---------------------------------------


class Finding(_Strict):
    finding_id: str
    kind: Literal["violation", "uncertain"]
    rule_id: Optional[str] = None
    rule_summary: str
    explanation: str
    location: Range
    assumption_dependent: bool


class ScanFunction(_Strict):
    function_id: str
    name: str
    original_range: Range
    findings: List[Finding]


class FunctionScanResult(_Strict):
    scan_id: str
    source_id: str
    original_hash: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    context_revision_id: str
    rule_profile: IdVersion
    adapter: IdVersion
    harness: IdVersion
    functions: List[ScanFunction]


# --- repair-candidate.schema.json -------------------------------------------


class Hunk(_Strict):
    hunk_id: str
    start_line: int = Field(ge=1)
    line_count: int = Field(ge=0)
    replacement_text: str


class Validation(_Strict):
    name: str
    status: Literal["pass", "fail", "skipped", "not_run"]
    detail: Optional[str] = None


class RepairCandidate(_Strict):
    candidate_id: str
    finding_id: str
    function_id: str
    source_id: str
    original_hash: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    context_revision_id: str
    status: Literal["repair_ready", "repair_failed", "validation_failed"]
    repair_explanation: str
    hunks: List[Hunk]
    validations: List[Validation]
    model_identity: Optional[str] = None


# --- request/response envelopes (not contract objects themselves) -----------


class InferRequest(_Strict):
    source_document: SourceDocument
    # Optional compile include paths (D-020). Additive bridge-API field (the 6
    # contract schemas are unchanged). Merged into the effective compile config's
    # include_paths (dedup, order-preserving) before probing the prelude-less
    # Original, so symbols that live in project headers are resolved and excluded
    # from the inferred context. No effect when the compile gate would not run.
    compile_include_paths: List[str] = Field(default_factory=list)


class ConfirmRequest(_Strict):
    context_augmentation_set: ContextAugmentationSet


class CheckRequest(_Strict):
    source_document: SourceDocument
    context_augmentation_set: ContextAugmentationSet
    # Optional compile include paths (D-020). Same additive field as elsewhere;
    # merged into the compile config for the Augmented-C probe.
    compile_include_paths: List[str] = Field(default_factory=list)


class CheckResponse(_Strict):
    # Whether the composed Augmented C compiles with the current context.
    compiles: bool
    # External symbols still unresolved after composition (empty when it compiles,
    # or when no compiler is available / the gate is disabled).
    missing_symbols: List[str]
    # Local (quoted) headers that were STUBBED with empty files to get the
    # Augmented C past its include stage so the check is meaningful. Additive
    # bridge-envelope field (the 6 contract schemas are unchanged); defaults to
    # empty so an all-headers-present file behaves exactly as before. A non-empty
    # list means those project headers were absent in this single-file context and
    # the still-missing symbols are what the confirmed context must additionally
    # declare.
    stubbed_headers: List[str] = Field(default_factory=list)


class ScanRequest(_Strict):
    source_document: SourceDocument
    context_augmentation_set: ContextAugmentationSet
    # Optional compile include paths (D-020). Additive bridge-API field (the 6
    # contract schemas are unchanged). The scan path does not run the compile
    # gate, so this is accepted but IGNORED here — present for symmetry / future
    # use. Only the repair path applies it.
    compile_include_paths: List[str] = Field(default_factory=list)


class RepairRequest(_Strict):
    source_document: SourceDocument
    context_augmentation_set: ContextAugmentationSet
    function_id: str
    # The scan-result finding to repair. The bridge is stateless, so the client
    # carries the finding back (its rule_id and location drive the repair). Its
    # shape is the contract Finding (function-scan-result.schema.json).
    finding: Finding
    # Optional compile include paths (D-020). Additive bridge-API field (the 6
    # contract schemas are unchanged). Merged into the effective compile config's
    # include_paths (dedup, order-preserving) and used as ``-I`` args for BOTH the
    # baseline (unrepaired) pre-check and the candidate compile gate, so a real
    # project's .c whose missing declarations live in project headers can compile.
    compile_include_paths: List[str] = Field(default_factory=list)


class IdentityRef(_Strict):
    id: str
    version: str


class Capabilities(_Strict):
    rule_profile: str
    rules_count: int
    gates: List[str]
    routes: List[str]
    # Effective LLM identity (D-019). ``model`` is the resolved OpenRouter model
    # id; ``provider_order`` is the effective provider pin — an empty list means
    # OpenRouter automatic routing (no pin). Additive fields; contract_version
    # stays "1" and the 6 contract schemas are untouched.
    model: str
    provider_order: List[str]
    # Effective reasoning effort (D-028/D-029). This is the **fix role's** effective
    # value (repair + validation): one of "xhigh"/"high"/"medium"/"low" when
    # reasoning is configured, "off" when disabled, or "default" when the config
    # specifies no reasoning at all. CREPAIR_REASONING_EFFORT / crepair.reasoningEffort
    # only affect this value (D-029). Additive field.
    reasoning_effort: str
    # Effective detection-role reasoning (D-029), reported separately so a client
    # can show that detection reasoning is independent of the fix-role setting.
    # Bundled config fixes this off; it is never affected by the reasoning override.
    detection_reasoning: str
    # Effective provider policy (D-019 follow-up): "private-cheap" / "balanced" when a
    # recognized CREPAIR_PROVIDER_POLICY took effect (custom mode, empty order), or
    # "none" when no policy applied (unset, unrecognized, or an explicit pin won).
    # Additive field; contract_version stays "1".
    provider_policy: str = "none"
    # Whether CERT-C rule TITLES are surfaced in responses (D-039 legal kill-switch):
    # "on" (default) or "off" when CREPAIR_RULE_TITLES=off empties the display
    # rule_summary so consumers show the rule ID alone. Detection / repair behaviour
    # is unaffected. Additive field; contract_version stays "1".
    rule_titles: Literal["on", "off"] = "on"


class HealthResponse(_Strict):
    status: str
    harness: IdentityRef
    adapter: IdentityRef
    contract_version: str
    capabilities: Capabilities
