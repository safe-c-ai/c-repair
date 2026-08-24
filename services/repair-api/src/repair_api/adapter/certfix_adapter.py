"""CertFix in-process scan adapter (PHASE3A_DESIGN.md §3).

Responsibilities:
- Compose Augmented C (compose.py) and build the Original-C function inventory
  (functions.py).
- Run CertFix's ``Detector.check_file`` on the Augmented C written to a per-job
  temp dir, then map violation line numbers back to Original coordinates by
  subtracting ``prelude_line_count``.
- Map violations to contract ``finding`` objects with the D-003 reduction (one
  finding per function, the minimum line), ``UNKNOWN-CERT-C`` -> ``uncertain``,
  and ``assumption_dependent`` set when any augmentation item is unconfirmed
  (D-020: a reviewed/confirmed completion is not a lingering assumption).

Security (PHASE3A_DESIGN.md §7): source content is never logged; only content
hash and line numbers appear in diagnostics. The per-job temp dir is always
removed. Detection is only exercised through an injected ``InferenceBackend``
in tests, so no LLM is invoked in unit tests.

Backend injection (DI): ``run_scan`` accepts a ``backend`` (an
``InferenceBackend``) so tests can substitute a fake. The real backend is built
lazily by the FastAPI layer via ``certfix.inference.factory``.
"""

from __future__ import annotations

import hashlib
import logging
import os
import re
import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional, Protocol, Sequence

import certfix
from certfix.core.detector import Detector

from repair_api import compose
from repair_api.functions import FunctionInfo, build_inventory

logger = logging.getLogger("repair_api.adapter")

# Identity constants (PHASE3A_DESIGN.md §3-5).
ADAPTER_ID = "certfix-inprocess"
ADAPTER_VERSION = "0.1.0"
RULE_PROFILE_ID = "cert-c"
RULE_PROFILE_VERSION = "certfix-0.4.1-bundled"

UNKNOWN_RULE_ID = "UNKNOWN-CERT-C"

# Attribution sentinel for a detection failure whose chunk could not be matched
# to an inventory function (see ``_DetectFailureWrapper`` / ``_attribute_failure``).
UNKNOWN_FUNCTION = "unknown"

# Fixed human-facing wording for an uncertain finding raised when the detector
# could NOT analyze a function because the provider errored (D-030 free-pool
# failure mode). Kept as constants so the test and the mapping share one source.
DETECTION_FAILED_SUMMARY = "Detection failed (provider error)"
DETECTION_FAILED_EXPLANATION = (
    "The detector could not analyze this function because the LLM provider "
    "returned an error (this can happen on free/shared model pools). This is "
    "NOT a clean result — re-scan to retry."
)

# Fallback rule count if the bundled catalog cannot be read dynamically.
# Source: certfix docs/SUPPORTED_RULES.md (115 bundled CERT-C rule targets).
FALLBACK_RULES_COUNT = 115

# Legal kill-switch (D-039): env var that suppresses the human RULE TITLE in
# scan/repair *responses*. When ``CREPAIR_RULE_TITLES=off`` the display-only
# ``rule_summary`` derived from a CERT-C rule title is emptied (""), so the
# extension shows the rule ID alone ("STR31-C"). Detection / repair behaviour is
# COMPLETELY unchanged: this only touches the response's display field. certfix's
# own internal prompts build the title from certfix's catalog independently of
# ``rule_titles()`` here, so they still receive the title as before. Default: on.
RULE_TITLES_ENV = "CREPAIR_RULE_TITLES"
_RULE_TITLES_OFF = "off"


def rule_titles_enabled(env: Optional[dict] = None) -> bool:
    """Whether rule TITLES are surfaced in responses (D-039 legal kill-switch).

    Returns False only when ``CREPAIR_RULE_TITLES`` is set to ``off`` (case-
    insensitive, whitespace-trimmed). Any other value — including unset, empty, or
    ``on`` — leaves titles ON (the default). This gates only the display-only
    ``rule_summary`` string; rule IDs and detection/repair behaviour are unaffected.
    """
    env = os.environ if env is None else env
    raw = env.get(RULE_TITLES_ENV)
    if isinstance(raw, str) and raw.strip().lower() == _RULE_TITLES_OFF:
        return False
    return True


def _load_catalog() -> Optional[dict]:
    """Load certfix's bundled CERT-C catalog JSON, or None if unavailable.

    Uses the same ``importlib.resources`` path as ``rules_count`` /
    ``rule_titles`` so both track the installed harness.
    """
    try:
        import json
        from importlib import resources

        data_ref = resources.files("certfix.data").joinpath(
            "cert_c_rules_with_examples.json"
        )
        return json.loads(data_ref.read_text(encoding="utf-8"))
    except Exception:  # pragma: no cover - defensive; caller falls back
        logger.info("catalog unavailable (importlib.resources read failed)")
        return None


def rules_count() -> int:
    """Number of CERT-C rule targets the bundled harness supports.

    Read dynamically from certfix's bundled catalog
    (``certfix.data/cert_c_rules_with_examples.json`` -> ``total_rules``) so the
    value tracks the installed harness. Falls back to ``FALLBACK_RULES_COUNT``
    (115; certfix docs/SUPPORTED_RULES.md) if the catalog is unavailable.
    """
    catalog = _load_catalog()
    if catalog is not None:
        total = catalog.get("total_rules")
        if isinstance(total, int) and total > 0:
            return total
    return FALLBACK_RULES_COUNT


# Cached rule_id -> title map (built once from the bundled catalog). ``None``
# until first built; an empty dict is a valid "catalog unavailable" result and
# is NOT rebuilt on every call.
_RULE_TITLES: Optional[dict] = None


def rule_titles() -> dict:
    """Map ``rule_id`` -> human title from the bundled catalog (cached).

    The catalog groups rules under ``categories[].rules[]`` where each rule has
    ``id`` and ``title`` (e.g. ``ERR33-C`` -> "Detect and handle standard library
    errors"). Returns an empty dict if the catalog cannot be read; callers then
    fall back to a generic ``rule_summary``.
    """
    global _RULE_TITLES
    if _RULE_TITLES is not None:
        return _RULE_TITLES
    titles: dict = {}
    catalog = _load_catalog()
    if catalog is not None:
        for category in catalog.get("categories", []) or []:
            for rule in category.get("rules", []) or []:
                rid = rule.get("id")
                title = rule.get("title")
                if isinstance(rid, str) and isinstance(title, str) and title:
                    titles[rid] = title
    _RULE_TITLES = titles
    return _RULE_TITLES


class _BackendLike(Protocol):
    """Minimal structural type: what Detector needs from a backend."""

    def detect(self, code: str, rules: Optional[List[str]] = None): ...


class _DetectFailureWrapper:
    """Wrap a backend so per-chunk ``detect`` failures are captured, then re-raised.

    certfix's ``Detector.check_file`` catches any exception from
    ``backend.detect`` per chunk, logs it, and CONTINUES with the next chunk — so
    a chunk that never returned violations is indistinguishable from a clean
    function downstream, silently degrading a real error into a CLEAN display
    (the bug this fixes). This wrapper sits between the Detector and the real
    backend: on an exception it records the failing chunk's ``code`` (to attribute
    it back to a function later) and RE-RAISES, leaving certfix's per-chunk
    catch/continue behaviour bit-identical. On success it is a pass-through.

    ``detect`` mirrors the backend signature (``code``, ``rules``); any extra
    positional/keyword args certfix might pass are forwarded verbatim so this is a
    faithful proxy. Attributes copied through ``__getattr__`` include
    ``line_aware_detection``, which the Detector reads off the backend.
    """

    def __init__(self, backend: _BackendLike) -> None:
        self._backend = backend
        # Codes of chunks whose detect() raised. Never contains source in logs;
        # only used for in-process function attribution (§7).
        self.failed_codes: List[str] = []

    def __getattr__(self, name: str):
        # Delegate everything we don't define (e.g. line_aware_detection) so the
        # Detector sees the real backend's surface.
        return getattr(self._backend, name)

    def detect(self, code, rules=None, *args, **kwargs):
        try:
            return self._backend.detect(code, rules, *args, **kwargs)
        except Exception:
            self.failed_codes.append(code)
            raise


@dataclass(frozen=True)
class _MappedViolation:
    """A violation remapped to Original coordinates."""

    rule_id: str
    line: int  # Original C, 1-indexed
    message: str


def _content_hash_hex(content: str) -> str:
    """SHA-256 hex of the UTF-8 bytes (no prefix). For diagnostics only."""
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def _assumption_dependent(items: Sequence[object]) -> bool:
    """assumption_dependent per D-020 (semantics refined from provenance).

    True when the scan depends on any UNCONFIRMED item — i.e. an item whose
    ``confirmed`` is falsey. A completion the user reviewed and confirmed is NOT a
    lingering assumption (design §2 / D-020), regardless of its provenance; an
    llm_inferred item that was confirmed no longer marks findings assumption-
    dependent. Empty items -> false. Findings only depend on the confirmed
    revision, so a set that still carries unconfirmed items (Skip-review path)
    yields assumption-dependent findings.
    """
    for item in items:
        confirmed = item["confirmed"] if isinstance(item, dict) else getattr(item, "confirmed")
        if not confirmed:
            return True
    return False


def _attribute(line: int, inventory: Sequence[FunctionInfo]) -> Optional[FunctionInfo]:
    """Return the function whose Original range contains ``line``, or None."""
    for fn in inventory:
        if fn.start_line <= line <= fn.end_line:
            return fn
    return None


def _attribute_failure(code: str, inventory: Sequence[FunctionInfo]) -> Optional[FunctionInfo]:
    """Attribute a failed detection ``code`` blob to an inventory function.

    ``certfix.core.detector.check_file`` passes the backend a per-chunk blob of
    ``context + "\\n\\n" + chunk.code`` (see detector.py): non-function preceding
    context first, then the function chunk itself, whose FIRST line is the
    function's signature (``<ret> name(<params>) {`` — splitter._FUNC_START_RE
    captures exactly that ``name``). ``chunk.name`` — the reliable identifier —
    never reaches the backend (only ``code``/``rules`` do), so we recover the
    function by locating its signature line in the blob.

    Matching: for each inventory function we test whether the blob contains a
    *definition* line for ``name`` — i.e. a line matching ``…name ( … {`` (an open
    brace on the same line) or ``…name ( …`` immediately followed by a line whose
    first non-blank char is ``{``. Requiring the brace excludes bare prototypes /
    call sites that share the name, which can legitimately appear in the preceding
    context. ``\\bname\\s*\\(`` anchors on a word boundary so ``foo`` does not
    match ``do_foo(``.

    Ambiguity: the chunk's own definition is what actually failed and, because
    context precedes it, is the LAST matching definition in the blob; on multiple
    matches we therefore pick the match at the greatest offset (and, as a stable
    tiebreak at equal offset, the longest name). Returns ``None`` when no
    definition line matches (caller records the failure as ``UNKNOWN_FUNCTION``).
    """
    best: Optional[FunctionInfo] = None
    best_key: tuple[int, int] = (-1, -1)
    lines = code.split("\n")
    for fn in inventory:
        # A word-boundary'd "name(" — the signature form the splitter matched.
        sig = re.compile(r"\b" + re.escape(fn.name) + r"\s*\(")
        offset = -1
        for idx, line in enumerate(lines):
            if not sig.search(line):
                continue
            # Definition requires an opening brace on this line, or the next
            # non-blank line beginning with "{" (K&R / same-line brace styles).
            if "{" in line:
                is_def = True
            else:
                is_def = False
                for nxt in lines[idx + 1 :]:
                    stripped = nxt.strip()
                    if not stripped:
                        continue
                    is_def = stripped.startswith("{")
                    break
            if is_def:
                # Byte offset of this line's start in the blob (for last-wins).
                offset = sum(len(lines[j]) + 1 for j in range(idx))
        if offset < 0:
            continue
        key = (offset, len(fn.name))
        if key > best_key:
            best_key = key
            best = fn
    return best


def run_scan(
    *,
    backend: _BackendLike,
    source_id: str,
    original_content: str,
    original_hash: str,
    context_revision_id: str,
    items: Sequence[object],
    prelude_line_count: int,
    harness_version: Optional[str] = None,
) -> dict:
    """Run a full-file scan and return a FunctionScanResult dict.

    Args:
        backend: Injected CertFix InferenceBackend (fake in tests, real API
            backend in production). Detector is constructed internally around it.
        source_id: SourceDocument.source_id (echoed into the result).
        original_content: Original C source (byte-unchanged).
        original_hash: ``sha256:`` prefixed hash of the Original C.
        context_revision_id: Confirmed context revision id.
        items: Confirmed augmentation items (may be empty).
        prelude_line_count: Prelude line count for the Augmented C.
        harness_version: certfix version; defaults to ``certfix.__version__``.

    Returns:
        A dict matching function-scan-result.schema.json.
    """
    harness_version = harness_version or certfix.__version__

    # 1. Function inventory (Original coordinates).
    inventory = build_inventory(original_content, prelude_line_count)

    # 2. Compose Augmented C and detect on a per-job temp dir.
    augmented = compose.compose_augmented_c(items, original_content)
    violations, failed_codes = _detect(backend, augmented)

    # 2b. Attribute each failed chunk to an inventory function (or UNKNOWN). A
    #     failed chunk means the detector never analyzed that function, so a
    #     "CLEAN" (no-finding) result for it would be a false negative (§ bug).
    src_hash_short = _content_hash_hex(original_content)[:12]
    failed_function_ids: set[str] = set()
    unattributed_failures = 0
    for code in failed_codes:
        fn = _attribute_failure(code, inventory)
        if fn is None:
            unattributed_failures += 1
            logger.info(
                "scan diagnostic: detection failed, function unattributed "
                "src=%s function=%s",
                src_hash_short,
                UNKNOWN_FUNCTION,
            )
            continue
        failed_function_ids.add(fn.function_id)
        logger.info(
            "scan diagnostic: detection failed src=%s function=%s",
            src_hash_short,
            fn.name,
        )
    if unattributed_failures:
        # Unattributed failures leave real gaps, but we cannot say WHICH function
        # was missed. Marking every finding-less function uncertain would be
        # over-broad (mostly-clean files would light up entirely), so we log the
        # count for diagnostics and add no finding — the attributed failures above
        # still surface, and a re-scan is the operator's recovery path.
        logger.info(
            "scan diagnostic: %d detection failure(s) could not be attributed "
            "to a function src=%s",
            unattributed_failures,
            src_hash_short,
        )

    # 3. Remap Augmented -> Original coordinates (subtract prelude_line_count).
    #    Drop anything inside/above the prelude (Original line < 1).
    mapped: List[_MappedViolation] = []
    for v in violations:
        original_line = v.line - prelude_line_count
        if original_line < 1:
            logger.info(
                "scan diagnostic: violation dropped (prelude range) "
                "src=%s augmented_line=%d original_line=%d",
                src_hash_short,
                v.line,
                original_line,
            )
            continue
        mapped.append(
            _MappedViolation(rule_id=v.rule_id, line=original_line, message=v.message or "")
        )

    assumption_dependent = _assumption_dependent(items)
    # Legal kill-switch (D-039): when titles are off, pass an empty map so every
    # violation finding's display ``rule_summary`` is blank (the extension shows
    # the rule ID alone). Rule IDs and the detection just performed are unchanged.
    titles = rule_titles() if rule_titles_enabled() else {}
    titles_enabled = rule_titles_enabled()

    # 4. Attribute to functions; collect per-function violation lists.
    per_function: dict[str, List[_MappedViolation]] = {fn.function_id: [] for fn in inventory}
    for mv in mapped:
        fn = _attribute(mv.line, inventory)
        if fn is None:
            # Out-of-function violation -> diagnostics only (§3-4, V1 spec).
            logger.info(
                "scan diagnostic: out-of-function violation src=%s original_line=%d",
                src_hash_short,
                mv.line,
            )
            continue
        per_function[fn.function_id].append(mv)

    # 5. Build findings, applying the D-003 reduction: one finding per function
    #    (minimum line); the rest are diagnostics only.
    functions_out = []
    for fn in inventory:
        fn_violations = sorted(per_function[fn.function_id], key=lambda m: m.line)
        findings = []
        if fn_violations:
            primary = fn_violations[0]
            for extra in fn_violations[1:]:
                logger.info(
                    "scan diagnostic: D-003 reduced extra violation "
                    "src=%s function=%s original_line=%d",
                    src_hash_short,
                    fn.function_id,
                    extra.line,
                )
            findings.append(
                _to_finding(fn, primary, assumption_dependent, titles, titles_enabled)
            )
        elif fn.function_id in failed_function_ids:
            # No violation, but this function's chunk FAILED to detect: not clean.
            # Surface a single uncertain "Detection failed" finding so it is never
            # shown as CLEAN. If it already had a finding (detected before the
            # failure, e.g. a retry path) we skip this — D-003's 0..1 per function
            # is preserved and the existing finding already carries information.
            findings.append(_detection_failed_finding(fn))
        functions_out.append(
            {
                "function_id": fn.function_id,
                "name": fn.name,
                "original_range": {"start_line": fn.start_line, "end_line": fn.end_line},
                "findings": findings,
            }
        )

    scan_id = "scan-" + _content_hash_hex(original_hash + context_revision_id)[:12]

    return {
        "scan_id": scan_id,
        "source_id": source_id,
        "original_hash": original_hash,
        "context_revision_id": context_revision_id,
        "rule_profile": {"id": RULE_PROFILE_ID, "version": RULE_PROFILE_VERSION},
        "adapter": {"id": ADAPTER_ID, "version": ADAPTER_VERSION},
        "harness": {"id": "certfix", "version": harness_version},
        "functions": functions_out,
    }


def _detect(backend: _BackendLike, augmented: str) -> tuple[List, List[str]]:
    """Write Augmented C to a per-job temp dir and run Detector.check_file.

    Returns ``(violations, failed_codes)`` where ``failed_codes`` are the per-chunk
    code blobs whose ``detect`` raised (captured by ``_DetectFailureWrapper`` while
    leaving certfix's per-chunk catch/continue intact). The temp dir is always
    removed. Never logs source content (§7).
    """
    wrapped = _DetectFailureWrapper(backend)
    tmp_dir = tempfile.mkdtemp(prefix="crepair-scan-")
    try:
        aug_path = Path(tmp_dir) / "augmented.c"
        aug_path.write_text(augmented, encoding="utf-8")
        detector = Detector(wrapped)  # generic function-chunk path
        return detector.check_file(aug_path), wrapped.failed_codes
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def _detection_failed_finding(fn: FunctionInfo) -> dict:
    """Build the uncertain finding for a function whose detection chunk errored.

    kind ``uncertain`` with NO ``rule_id`` (nothing was identified — the analysis
    never ran), located at the function's first line, and ``assumption_dependent``
    False: the uncertainty is a provider failure, not a dependence on unconfirmed
    augmentation. Fixed human wording (DETECTION_FAILED_*) tells the operator this
    is NOT a clean result and to re-scan.
    """
    finding_id = "find-" + hashlib.sha256(
        f"{fn.function_id}:detection-failed:{fn.start_line}".encode("utf-8")
    ).hexdigest()[:12]
    return {
        "finding_id": finding_id,
        "kind": "uncertain",
        "rule_summary": DETECTION_FAILED_SUMMARY,
        "explanation": DETECTION_FAILED_EXPLANATION,
        "location": {"start_line": fn.start_line, "end_line": fn.start_line},
        "assumption_dependent": False,
    }


def _to_finding(
    fn: FunctionInfo,
    mv: _MappedViolation,
    assumption_dependent: bool,
    titles: Optional[dict] = None,
    titles_enabled: bool = True,
) -> dict:
    """Map one remapped violation to a contract finding.

    UNKNOWN-CERT-C -> uncertain (rule_id omitted). Otherwise -> violation, with
    ``rule_summary`` set to the rule's human title from the bundled catalog
    (``titles[rule_id]``, e.g. "Detect and handle standard library errors"). When
    the title is unavailable (catalog missing, or an unlisted rule_id) the summary
    falls back to the prior placeholder ``CERT-C <rule_id>.`` form.

    Legal kill-switch (D-039): when ``titles_enabled`` is False
    (``CREPAIR_RULE_TITLES=off``) the ``rule_summary`` is an EMPTY string — no
    catalog title and no ``CERT-C <rule_id>.`` placeholder — so consumers show the
    rule ID alone. ``rule_id`` and the finding's location/kind are unchanged; only
    the display title text is dropped.

    For an uncertain finding the internal detector ``message`` (an implementation
    string such as "Qwen3.6 prompt-profile detection (stage1_… -> rule_title_match)")
    is deliberately NOT surfaced (D-029): it is a debug artifact, not a
    human-facing explanation. It is dropped here (kept only as a DEBUG log) and
    replaced with fixed human-readable wording.
    """
    titles = titles or {}
    finding_id = "find-" + hashlib.sha256(
        f"{fn.function_id}:{mv.rule_id}:{mv.line}".encode("utf-8")
    ).hexdigest()[:12]

    if mv.rule_id == UNKNOWN_RULE_ID:
        # D-029: never leak the internal detector message into user-facing text.
        if mv.message:
            logger.debug("uncertain finding: internal detector message suppressed")
        return {
            "finding_id": finding_id,
            "kind": "uncertain",
            "rule_summary": "Possible issue (rule not identified)",
            "explanation": (
                "The detector flagged this function as potentially problematic but "
                "could not identify a specific CERT C rule with confidence. Re-scan "
                "may yield a different result."
            ),
            "location": {"start_line": mv.line, "end_line": mv.line},
            "assumption_dependent": assumption_dependent,
        }

    if not titles_enabled:
        # D-039: title suppressed — empty display summary; the rule ID is retained.
        rule_summary = ""
    else:
        title = titles.get(mv.rule_id)
        rule_summary = title if title else f"CERT-C {mv.rule_id}."
    return {
        "finding_id": finding_id,
        "kind": "violation",
        "rule_id": mv.rule_id,
        "rule_summary": rule_summary,
        "explanation": mv.message or f"Potential {mv.rule_id} violation detected.",
        "location": {"start_line": mv.line, "end_line": mv.line},
        "assumption_dependent": assumption_dependent,
    }
