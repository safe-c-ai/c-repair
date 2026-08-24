"""CertFix in-process repair + validation adapter (SPIKE §7, PHASE3A_DESIGN §3,
VSCODE_PIVOT_PLAN §3 correction c).

Strategy (SPIKE §4/§7, confirmed):

1. Compose the Augmented C (prelude + Original, byte-unchanged) and run it through
   certfix's line-structure-preserving ``Preprocessor(keep_comments=False)`` to
   obtain a comment-stripped, **line-count-preserving** full text (``processed``).
   ``strip_c_comments`` is deliberately NOT used because it collapses line
   structure and would break the coordinate mapping.
2. Run certfix's ``run_simple_repair`` (fix-role backend, ``rules=[rule_id]``,
   ``prompt_profile`` from config) over ``processed`` to get the whole-file
   ``fixed_code``.
3. ``difflib`` the two whole texts in the processed (== Augmented) coordinate
   space and coalesce contiguous changed lines into contract hunks
   ``{start_line, line_count, replacement_text}``.
4. Subtract ``prelude_line_count`` from every hunk to reach Original coordinates,
   and DROP any hunk that touches the prelude range (Original ``start_line <= 0``,
   or an insertion whose anchor lands inside the prelude). Dropped hunks are
   logged as diagnostics (hash + line numbers only, never source content).
5. Run certfix's ``validate_fix_result`` and map ``FixValidatorResult`` to the
   contract ``validations[]`` (format / compile / violation_removal / semantic /
   regression). When no compiler is present (or the compile gate is disabled),
   record ``compile: skipped`` rather than failing.
6. Derive status: no fix / empty hunks -> ``repair_failed``; hunks with
   ``auto_apply_ok`` -> ``repair_ready``; hunks but a hard gate failed ->
   ``validation_failed`` (hunks are retained so the reviewer can still inspect).

Dependency injection: both the fix ``backend`` and a ``compile_runner`` are
injectable so unit tests can substitute a fake backend (fixed fixed_code) and a
fake / absent compiler. No LLM is ever called in unit tests.

Security (PHASE3A_DESIGN §7): source content is never logged; only the content
hash (short) and line numbers appear in diagnostics.
"""

from __future__ import annotations

import copy
import difflib
import hashlib
import logging
import os
import re
import shutil
import tempfile
import threading
from dataclasses import dataclass, field, replace as dataclasses_replace
from pathlib import Path
from typing import Callable, List, Optional, Protocol, Sequence

import certfix

from repair_api import compose, usage_tracker
from repair_api.adapter import certfix_adapter
from repair_api.functions import FunctionInfo, build_inventory

logger = logging.getLogger("repair_api.adapter.repair")


# --- dynamic repair max_tokens (task §1) ------------------------------------
#
# Whole-file repair emits the ENTIRE fixed file plus reasoning tokens. A fixed
# 4096-token budget silently truncates any file that is even moderately large,
# producing an unparseable / empty candidate that looks like "no fix". We size
# the completion budget from the input instead.

# Characters per token for C source. Empirical rule of thumb: OpenAI-family and
# Qwen BPE tokenizers land around 3.5–4 chars/token on typical C (identifiers +
# punctuation + whitespace); C source skews slightly denser than prose, so 3.5
# is the conservative (higher token estimate) choice. Kept intentionally simple
# — a real tokenizer is not a dependency of the bridge, and over-estimating the
# budget is cheap (unused headroom is not billed) while under-estimating causes
# the exact truncation this function exists to prevent.
_CHARS_PER_TOKEN = 3.5

# The generated whole file is roughly the same size as the input, but the model
# also (a) rewrites, not just echoes, and (b) may add a few lines. 1.3x gives
# headroom for that growth without ballooning the budget.
_OUTPUT_GROWTH_FACTOR = 1.3

# Static fallback ceiling (tokens). The REAL ceiling is the effective model's
# ``max_completion_tokens`` (resolved lazily from OpenRouter, see
# ``ModelCeilingResolver``): certfix's old "~200 line function" limit was an
# SFT-era artefact; the true whole-file-repair limit is the model's max output
# length. This constant is used only when that lookup is unavailable (no key,
# fetch/timeout failure, or the field is absent).
_STATIC_CEILING_FALLBACK = 24576


def estimate_code_tokens(code: str) -> int:
    """Approximate the token count of ``code`` (chars / 3.5, rounded up).

    Deliberately tokenizer-free (see ``_CHARS_PER_TOKEN``): a coarse char-based
    estimate is enough to size a completion budget, and it keeps the bridge free
    of a tokenizer dependency. Never negative; empty code is 0 tokens.
    """
    if not code:
        return 0
    import math

    return math.ceil(len(code) / _CHARS_PER_TOKEN)


# D-034: effort level -> explicit reasoning token cap. Instrumented live runs
# (2026-08-22, 2k-line repairs) showed 3/3 finish=length with reasoning spends
# of 47k/87k/58k tokens: with an effort-style setting the reasoning ADAPTS to
# whatever budget is available and starves the content, so enlarging the budget
# (the former 12b content-term doubling) is self-defeating. An explicit
# ``reasoning: {max_tokens: N}`` IS honored (A/B probed), so the bridge converts
# the effort level to a hard cap right before sending, and the completion
# budget adds exactly that cap on top of the content term.
#
# Round-15 caveat (measured on fill_window): a provider can treat the explicit
# cap as ADVISORY — a reasoning spend of 30,789 was observed against the xhigh
# cap of 24,576. The cap still shapes typical behaviour, but the EFFECTIVE
# defence is on the budget side: the completion budget reserves the content
# term beyond the allowance, and the D-035 window path adds one same-prompt
# re-draw on finish=length (provider non-determinism usually yields a
# terminating sample).
REASONING_EFFORT_CAPS = {
    "max": 32768,
    "xhigh": 24576,
    "high": 16384,
    "medium": 8192,
    "low": 4096,
    "minimal": 1024,
}


def reasoning_effort_to_cap(extra_body: object) -> object:
    """Convert ``reasoning: {effort: X}`` to ``reasoning: {max_tokens: CAP[X]}``.

    D-034: applied to the FINAL fix role (after CREPAIR_REASONING_EFFORT /
    config_override), so the user-facing config keeps the effort semantics and
    the bridge caps the thinking spend at send time. Returns a NEW extra_body
    dict (input never mutated) with only ``reasoning`` replaced; all other keys
    (provider pin etc.) are preserved. Left unchanged (returned as-is):

    - a non-dict / missing ``reasoning`` (nothing to convert),
    - ``{enabled: false}`` (off stays off),
    - an explicit ``max_tokens`` already present (respected verbatim),
    - an unknown effort level (fail-open: the provider sees the original).
    """
    if not isinstance(extra_body, dict):
        return extra_body
    reasoning = extra_body.get("reasoning")
    if not isinstance(reasoning, dict):
        return extra_body
    if reasoning.get("enabled") is False:
        return extra_body
    if "max_tokens" in reasoning:
        return extra_body
    effort = reasoning.get("effort")
    cap = REASONING_EFFORT_CAPS.get(effort) if isinstance(effort, str) else None
    if cap is None:
        return extra_body
    converted = dict(extra_body)
    converted["reasoning"] = {"max_tokens": cap}
    return converted


def estimate_repair_max_tokens(
    processed_code: str,
    base: int,
    reasoning_overhead: int = 4096,
    floor: int = 8192,
    ceiling: int = _STATIC_CEILING_FALLBACK,
    reasoning_allowance: int = 0,
) -> int:
    """Size the whole-file-repair completion budget from the input code.

    Whole-file repair must emit the entire fixed file (≈ the input size) plus the
    model's (capped) reasoning tokens. The budget is (D-034)::

        clamp(effective_floor,
              code_tokens * 1.3 + reasoning_allowance + reasoning_overhead,
              ceiling)

    where ``code_tokens`` is ``estimate_code_tokens(processed_code)``, the ``1.3``
    factor (``_OUTPUT_GROWTH_FACTOR``) leaves room for the fix growing the file,
    ``reasoning_allowance`` is the fix role's EXPLICIT reasoning token cap (the
    D-034 effort->cap conversion; 0 when reasoning is off), and
    ``reasoning_overhead`` is a small fixed margin. With the cap enforced on the
    provider side, content room is structurally guaranteed: reasoning can spend
    at most the allowance, and the content term is reserved beyond it. (The
    former adaptive-reasoning content doubling — 12b — is withdrawn: effort-style
    reasoning adapted to ANY budget and starved the content anyway.)

    ``base`` (the configured ``simple_max_tokens``) is treated as a *floor*: the
    dynamic budget never drops below ``max(floor, base)``, so a deployment that
    configured a larger simple_max_tokens keeps at least that much. ``ceiling``
    caps the budget at the effective model's ``max_completion_tokens`` (resolved
    at the call site; defaults to the static fallback for unit tests) so the
    request never asks for more output than the model can return — the caller
    checks ``repair_budget_exceeds_ceiling`` separately to fail fast instead of
    silently truncating at the ceiling. The fail-fast check deliberately stays
    content-only: as long as the CONTENT fits under the ceiling the repair is
    attempted, with reasoning absorbing whatever headroom remains.

    Clamp order (round 19, Codex MUST): ``min(ceiling, max(effective_floor,
    want))`` — the CEILING wins when a configured floor exceeds the model's
    output limit (the old floor-first order could return a budget above what
    the model can produce, guaranteeing truncation). The degenerate case is
    logged once per call so an over-configured floor is visible.
    """
    code_tokens = estimate_code_tokens(processed_code)
    want = int(code_tokens * _OUTPUT_GROWTH_FACTOR) + reasoning_allowance + reasoning_overhead
    effective_floor = max(floor, base)
    if effective_floor > ceiling:
        logger.info(
            "repair diagnostic: budget floor exceeds model ceiling -> clamped "
            "(floor=%d ceiling=%d)",
            effective_floor,
            ceiling,
        )
    return min(ceiling, max(effective_floor, want))


def _fix_reasoning_cap(extra_body: object) -> int:
    """The fix role's explicit reasoning token cap, or 0 when reasoning is off.

    Reads the (normally already converted, D-034) ``reasoning.max_tokens``;
    defensively converts an effort-form value first so a RepairConfig built
    directly with ``{effort: X}`` (tests, custom configs) still yields the cap.
    Used as ``estimate_repair_max_tokens``'s ``reasoning_allowance``.
    """
    if not isinstance(extra_body, dict):
        return 0
    converted = reasoning_effort_to_cap(extra_body)
    reasoning = converted.get("reasoning") if isinstance(converted, dict) else None
    if not isinstance(reasoning, dict) or reasoning.get("enabled") is False:
        return 0
    max_tokens = reasoning.get("max_tokens")
    if isinstance(max_tokens, bool) or not isinstance(max_tokens, int) or max_tokens <= 0:
        return 0
    return max_tokens


def repair_budget_exceeds_ceiling(
    processed_code: str,
    reasoning_overhead: int = 4096,
    ceiling: int = _STATIC_CEILING_FALLBACK,
) -> bool:
    """Whether the file is too large to fit a whole-file repair within ``ceiling``.

    True when the *unclamped* required budget (``code_tokens * 1.3 +
    reasoning_overhead``) exceeds ``ceiling`` — i.e. even at the ceiling (the
    effective model's ``max_completion_tokens``) the file could not be
    regenerated whole. The caller returns ``repair_failed`` before calling the
    LLM (no wasted spend). Uses the same terms as ``estimate_repair_max_tokens``
    so the two agree exactly.
    """
    code_tokens = estimate_code_tokens(processed_code)
    want = int(code_tokens * _OUTPUT_GROWTH_FACTOR) + reasoning_overhead
    return want > ceiling


# --- model output-ceiling resolution (task §1 correction) -------------------
#
# The whole-file-repair ceiling is the effective model's max output length, not a
# fixed constant. We resolve it from OpenRouter's model-endpoints API:
#
#   GET https://openrouter.ai/api/v1/models/{author}/{slug}/endpoints
#
# The model id is ``author/slug`` (the ``:free`` suffix, when present, stays in
# the slug). The response's ``data.endpoints[]`` each carry a
# ``max_completion_tokens``; when the config pins a provider (``provider.order``
# with ``allow_fallbacks: false``) we take that provider's endpoint value, else
# (auto-routing) the MAX across all endpoints (the best case a routed request
# could hit). Any failure — no key, non-200, timeout (10s), unparseable, or the
# field absent everywhere — falls back to the static ceiling. Numbers only: the
# response is parsed for the integer and discarded; nothing is logged from it.

_OPENROUTER_MODELS_ENDPOINTS_URL = "https://openrouter.ai/api/v1/models/{model_id}/endpoints"
_MODEL_ENDPOINTS_TIMEOUT_S = 10.0

# A model-endpoints fetcher: (model_id, api_key) -> parsed JSON dict (or None on
# failure). Injectable so tests never touch the network.
ModelEndpointsFetcher = Callable[[str, Optional[str]], Optional[dict]]


def _default_model_endpoints_fetcher(model_id: str, api_key: Optional[str]) -> Optional[dict]:
    """Fetch OpenRouter's endpoints doc for ``model_id``; None on any failure.

    Uses a short (10s) timeout and a bare GET. The ``:free`` suffix (if any) is
    part of the slug and is left in ``model_id`` verbatim. Never raises.
    """
    try:
        import httpx

        url = _OPENROUTER_MODELS_ENDPOINTS_URL.format(model_id=model_id)
        headers = {}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        response = httpx.get(url, headers=headers, timeout=_MODEL_ENDPOINTS_TIMEOUT_S)
        if response.status_code != 200:
            return None
        data = response.json()
        return data if isinstance(data, dict) else None
    except Exception:  # noqa: BLE001 — any fetch/parse failure -> fallback ceiling
        return None


def _pinned_provider_name(extra_body: object) -> Optional[str]:
    """The single pinned provider name when routing is fixed, else None.

    A provider is "pinned" when ``extra_body.provider`` sets ``allow_fallbacks``
    False and lists exactly one provider in ``order`` — then only that provider's
    endpoint can serve the request, so its ``max_completion_tokens`` is the real
    ceiling. Any other shape (fallbacks allowed, multiple providers, absent) means
    auto-routing, so we return None and the caller takes the max across endpoints.
    """
    if not isinstance(extra_body, dict):
        return None
    provider = extra_body.get("provider")
    if not isinstance(provider, dict):
        return None
    if provider.get("allow_fallbacks", True):
        return None
    order = provider.get("order")
    if isinstance(order, list) and len(order) == 1 and isinstance(order[0], str) and order[0]:
        return order[0]
    return None


def _parse_max_completion_tokens(
    data: object, pinned_provider: Optional[str]
) -> Optional[int]:
    """Extract the ceiling from an OpenRouter endpoints doc; None if unavailable.

    ``data.data.endpoints[]`` (OpenRouter nests the list under ``data``) each may
    carry ``max_completion_tokens`` and a ``provider_name``/``name``. When
    ``pinned_provider`` is set, return that provider's value (match on
    ``provider_name`` or ``name``); otherwise return the MAX across all endpoints
    that report a positive integer. Returns None when nothing usable is present so
    the caller falls back to the static ceiling.
    """
    if not isinstance(data, dict):
        return None
    inner = data.get("data")
    endpoints = inner.get("endpoints") if isinstance(inner, dict) else None
    if not isinstance(endpoints, list):
        return None

    values: List[int] = []
    for ep in endpoints:
        if not isinstance(ep, dict):
            continue
        raw = ep.get("max_completion_tokens")
        if isinstance(raw, bool) or not isinstance(raw, int) or raw <= 0:
            continue
        if pinned_provider is not None:
            name = ep.get("provider_name") or ep.get("name")
            if isinstance(name, str) and name == pinned_provider:
                return raw
            continue
        values.append(raw)
    if pinned_provider is not None:
        # Pinned provider had no usable endpoint value.
        return None
    return max(values) if values else None


class ModelCeilingResolver:
    """Lazily resolves + caches each model id's whole-file-repair output ceiling.

    One instance lives for the bridge process (module-level ``model_ceiling``). The
    per-model-id result is fetched at most once (cached, thread-safe); every later
    repair reuses it. On any failure the static fallback is cached too, so a broken
    lookup is not retried on every request.
    """

    def __init__(self, fetcher: Optional[ModelEndpointsFetcher] = None) -> None:
        self._fetcher = fetcher or _default_model_endpoints_fetcher
        self._cache: dict[str, int] = {}
        self._lock = threading.Lock()

    def resolve(
        self,
        model_id: str,
        *,
        extra_body: object = None,
        api_key: Optional[str] = None,
    ) -> int:
        """Return the output ceiling (tokens) for ``model_id`` (cached, lazy).

        ``extra_body`` is the fix role's ``api.extra_body`` (to detect a pinned
        provider); ``api_key`` is the OpenRouter key (from the role's
        ``api_key_env``). Falls back to the static ceiling on any failure, and
        caches whatever it resolves so the fetch happens at most once per
        (model id, pin) pair — the PIN is part of the cache key (round 19,
        Codex): a pinned provider's endpoint ceiling differs from the
        auto-routing max, so a provider-pin change must not be served a stale
        ceiling resolved under the previous pin.
        """
        if not model_id or model_id == "unknown":
            return _STATIC_CEILING_FALLBACK
        pinned = _pinned_provider_name(extra_body)
        cache_key = f"{model_id}::{pinned or 'auto'}"
        with self._lock:
            cached = self._cache.get(cache_key)
        if cached is not None:
            return cached

        ceiling = _STATIC_CEILING_FALLBACK
        # No key -> skip the fetch and use the static fallback. The bridge holds
        # OPENROUTER_API_KEY in its env in production; without a key we do not make
        # an unauthenticated call (also keeps the test suite fully offline).
        data = self._fetcher(model_id, api_key) if api_key else None
        if data is not None:
            parsed = _parse_max_completion_tokens(data, pinned)
            if isinstance(parsed, int) and parsed > 0:
                ceiling = parsed

        with self._lock:
            # Another thread may have raced; keep the first cached value.
            self._cache.setdefault(cache_key, ceiling)
            return self._cache[cache_key]


# The single resolver the repair path shares (process-lifetime cache).
model_ceiling = ModelCeilingResolver()


# --- injectable backend / compiler protocols --------------------------------


class _BackendLike(Protocol):
    """Minimal structural type for a certfix InferenceBackend used by repair."""

    def generate(self, prompt: str, *, max_tokens: int = ..., temperature: float = ...) -> str: ...

    def is_available(self) -> bool: ...


# --- backend failure classification (shared with infer.py) -------------------


def _is_expected_backend_failure(exc: Exception) -> bool:
    """Whether ``exc`` is a KNOWN provider/transport failure class.

    Known classes (observed or plausible from the LLM call path): certfix's
    ``InferenceError`` (API failure after retries), ``KeyError``/``IndexError``
    (malformed provider body, e.g. no ``choices``), httpx transport errors,
    ``json.JSONDecodeError`` (non-JSON / truncated body — observed live on
    /repair: HTTP 200 with the JSON cut off mid-stream), ``TimeoutError`` and
    ``OSError`` (network/socket). Anything else is treated as UNEXPECTED —
    likely an internal bug — and logged louder by the callers. Import failures
    of the optional dependencies degrade to "not matched" (never raise).

    Shared by the repair path (this module) and infer (``repair_api.infer``
    imports it from here — this module must not import infer, which imports us).
    """
    import json

    if isinstance(exc, (KeyError, IndexError, TimeoutError, OSError, json.JSONDecodeError)):
        return True
    try:
        import httpx

        if isinstance(exc, httpx.HTTPError):
            return True
    except Exception:  # noqa: BLE001 — optional import, classification only
        pass
    try:
        from certfix.exceptions import InferenceError

        if isinstance(exc, InferenceError):
            return True
    except Exception:  # noqa: BLE001 — optional import, classification only
        pass
    return False


def _log_llm_failure(stage: str, exc: Exception) -> None:
    """Log an LLM-call failure with class-dependent loudness (round 10).

    KNOWN provider/transport failures: exception TYPE only at INFO (a provider
    error body can echo request content — detail/traceback go to DEBUG).
    Anything else is probably an internal bug: WARNING WITH the traceback so it
    cannot pass silently as an ordinary provider hiccup. ``BaseException``s
    (``RequestCancelled``) never reach here — callers catch ``Exception`` only,
    so cancellation keeps propagating.
    """
    if _is_expected_backend_failure(exc):
        logger.info("repair diagnostic: %s LLM call failed kind=%s", stage, type(exc).__name__)
        logger.debug("repair diagnostic: %s LLM failure detail", stage, exc_info=True)
    else:
        logger.warning(
            "repair diagnostic: %s LLM call failed UNEXPECTEDLY kind=%s (possible bug)",
            stage,
            type(exc).__name__,
            exc_info=True,
        )


# The user-facing explanation for a provider failure during the repair call
# itself (round 10). Kept transient-oriented: the observed live failure was an
# HTTP 200 whose JSON body was cut off mid-stream — a retry usually succeeds.
_PROVIDER_FAILURE_EXPLANATION = (
    "The LLM provider returned an invalid response during repair; this is "
    "usually transient — try again."
)

# The per-gate detail used when the VALIDATION stage's LLM call failed: the
# hunks are kept (status validation_failed) and every gate reads skipped with
# this reason, so the reviewer knows nothing was actually judged.
_VALIDATION_PROVIDER_FAILURE_DETAIL = (
    "validation could not run: the LLM provider returned an invalid response "
    "(usually transient) — regenerate the repair to re-validate."
)


# --- per-call LLM usage logging (round 12a, measurement only) ----------------
#
# zlib-deflate live: 3/3 repairs came back as a near-empty whole-file
# replacement (scope drop -> repair_failed) with ~26k reasoning tokens per call
# against a ~30k dynamic budget — reasoning likely starved the content
# (the D-018 exhaustion mode re-appearing on large files). Before changing the
# budget formula we need the split VISIBLE per call: prompt / completion /
# reasoning token deltas + finish_reason + the requested max_tokens, one INFO
# line per LLM call (numbers only, never content).


def _usage_snapshot() -> dict:
    """The global usage tracker's snapshot; empty dict when unavailable.

    Honesty note (round 19): the tracker is PROCESS-GLOBAL, so a before/after
    delta computed from two snapshots attributes every token any CONCURRENT
    request spent in between to this call. The per-call usage lines are
    therefore approximate under concurrency — diagnostics, not billing.
    """
    try:
        return usage_tracker.tracker.snapshot()
    except Exception:  # noqa: BLE001 — diagnostics must never break a request
        return {}


def _log_llm_usage(
    stage: str,
    src_hash_short: str,
    function_id: str,
    max_tokens: object,
    before: dict,
    window: Optional[bool] = None,
    window_lines: int = 0,
    retry: Optional[int] = None,
    redraw: Optional[str] = None,
) -> None:
    """One INFO line with the usage DELTA of the LLM call that just finished.

    ``before`` is the tracker snapshot taken before the call; the delta against
    the current snapshot is this call's spend (clamped at >= 0 — the tracker is
    process-global, so a concurrent request could otherwise skew a reading
    negative). Honesty note (round 19): for the same reason the delta may also
    INCLUDE tokens a concurrent request spent between the two snapshots — the
    numbers are approximate under concurrency (diagnostics, not billing).
    Fakes that never touch the tracker read a 0/0/0 delta and
    ``finish=unknown``; a tracker/recorder failure degrades the same way.
    ``max_tokens`` is the budget REQUESTED for the call (``-`` when the call
    site does not know it, e.g. a detection-path call).

    ``window`` (D-035, repair stage only): ``False`` appends ``window=0``
    (whole-file path), ``True`` appends ``window=1 window_lines=N``; ``None``
    (validation-gate lines) appends nothing. ``retry`` (round 15, repair stage
    only): appends ``retry=N`` — 0 for the first attempt, 1 for the
    same-prompt re-draw; ``None`` (validation lines) appends nothing.
    ``redraw`` (round 16): appends ``redraw=<label>`` on the re-draw line when
    the attempt ran on a substitute backend (``reasoning-off``); ``None``
    appends nothing.
    """
    after = _usage_snapshot()

    def _delta(key: str) -> int:
        try:
            return max(0, int(after.get(key, 0)) - int(before.get(key, 0)))
        except Exception:  # noqa: BLE001 — diagnostics only
            return 0

    try:
        finish = usage_tracker.last_finish_reason()
    except Exception:  # noqa: BLE001 — diagnostics only
        finish = None
    message = (
        "repair llm: src=%s function=%s stage=%s max_tokens=%s prompt=%d "
        "completion=%d reasoning=%d finish=%s"
    )
    args: List[object] = [
        src_hash_short,
        function_id,
        stage,
        max_tokens if max_tokens is not None else "-",
        _delta("prompt_tokens"),
        _delta("completion_tokens"),
        _delta("reasoning_tokens"),
        finish if isinstance(finish, str) and finish else "unknown",
    ]
    if window is not None:
        message += " window=%d"
        args.append(1 if window else 0)
        if window:
            message += " window_lines=%d"
            args.append(window_lines)
    if retry is not None:
        message += " retry=%d"
        args.append(retry)
    if redraw is not None:
        message += " redraw=%s"
        args.append(redraw)
    logger.info(message, *args)


class _UsageLoggingBackend:
    """Wraps a validation backend to log a usage line per LLM call (round 12a).

    ``generate`` and ``detect`` are intercepted: the tracker snapshot is taken
    before, the finish-reason recorder is reset, the call is forwarded
    VERBATIM (``*args/**kwargs`` — no default re-declaration that could drift
    from certfix's), and the delta line is emitted in a ``finally`` so a call
    that raises still logs its spend. Every other attribute delegates to the
    wrapped backend. Used for the windowed violation_removal ("removal") and
    semantic ("semantic") gates inside validate_fix_result, which the adapter
    cannot instrument from outside.
    """

    def __init__(self, inner: object, stage: str, src_hash_short: str, function_id: str) -> None:
        self._inner = inner
        self._stage = stage
        self._src = src_hash_short
        self._function_id = function_id

    def _call_logged(self, method: str, max_tokens: object, args: tuple, kwargs: dict):
        before = _usage_snapshot()
        try:
            usage_tracker.reset_finish_reason()
        except Exception:  # noqa: BLE001 — diagnostics only
            pass
        try:
            return getattr(self._inner, method)(*args, **kwargs)
        finally:
            _log_llm_usage(self._stage, self._src, self._function_id, max_tokens, before)

    def generate(self, *args, **kwargs):  # noqa: ANN002, ANN003 — verbatim passthrough
        return self._call_logged("generate", kwargs.get("max_tokens"), args, kwargs)

    def detect(self, *args, **kwargs):  # noqa: ANN002, ANN003 — verbatim passthrough
        return self._call_logged("detect", None, args, kwargs)

    def is_available(self) -> bool:
        return self._inner.is_available()

    def __getattr__(self, name: str):
        return getattr(self._inner, name)


@dataclass(frozen=True)
class CompileProbe:
    """Outcome of probing for a usable compiler.

    ``available`` False means no compiler binary was found (or the compile gate
    is disabled); the adapter then records ``compile: skipped`` and does not run
    the certfix compile gate (which would raise ``FileNotFoundError``, since
    ``run_compile_check`` only guards against timeouts, not a missing binary).
    """

    available: bool
    detail: str


# A compile runner: given the compiler command name, report whether it is usable.
# The default probes PATH via ``shutil.which``; tests inject a fake.
CompileRunner = Callable[[str], CompileProbe]


def default_compile_runner(command: str) -> CompileProbe:
    """Probe PATH for ``command`` (e.g. ``gcc``). No compilation is performed here.

    The actual compile gate (``certfix.core.validation.run_compile_check``) runs
    only when this returns ``available=True``.
    """
    resolved = shutil.which(command)
    if resolved is None:
        return CompileProbe(available=False, detail=f"compiler '{command}' not found on PATH")
    return CompileProbe(available=True, detail=f"compiler '{command}' available")


@dataclass(frozen=True)
class CompileOutcome:
    """Result of actually compiling a whole-file source (baseline pre-check).

    ``ok`` is True when the compiler returned success. ``stderr`` carries the raw
    compiler diagnostics used to extract missing symbols. Tests inject a fake
    ``baseline_compile_runner`` returning this directly (no gcc, no LLM).

    ``missing_headers`` mirrors certfix's ``CompileCheckResult.missing_headers``
    (the header names gcc reported as ``No such file or directory``), passed
    through by ``default_baseline_compile_runner``. It is *advisory* only: the
    quote-vs-angle include style is not visible in that list (certfix's regex
    captures the bare name for both ``"x.h"`` and ``<x.h>``), so the two-stage
    probe re-derives the missing LOCAL (quoted) headers from ``stderr`` +
    the source via ``_extract_missing_local_headers``. Kept here so a caller that
    only has the outcome can still tell an include failure from a type error, and
    so the field survives when a fake runner leaves it at its default (``()``).
    """

    ok: bool
    stderr: str = ""
    missing_headers: tuple = ()


# A baseline compile runner: given whole-file code + the compile config, actually
# compile it and report the outcome. The default delegates to certfix's
# ``run_compile_check``; tests inject a fake so no real compiler runs.
BaselineCompileRunner = Callable[[str, object], CompileOutcome]


def default_baseline_compile_runner(code: str, compile_config: object) -> CompileOutcome:
    """Compile ``code`` with certfix's compile gate and return a CompileOutcome.

    Only called after the availability probe reports the compiler present and the
    compile gate is enabled, so ``run_compile_check`` will not raise on a missing
    binary. Never logs source content.
    """
    from certfix.config import CompileValidationConfig
    from certfix.core.validation import run_compile_check

    cfg = compile_config if isinstance(compile_config, CompileValidationConfig) else None
    result = run_compile_check(code, cfg)
    return CompileOutcome(
        ok=result.ok,
        stderr=result.stderr or "",
        missing_headers=tuple(getattr(result, "missing_headers", ()) or ()),
    )


# --- compile include-path merge (D-020) -------------------------------------


def _dedup_preserve_order(paths: Sequence[str]) -> List[str]:
    """De-duplicate ``paths`` keeping first-seen order; drop blank entries.

    Blank / whitespace-only entries are dropped (they would emit a useless ``-I``
    arg). No existence check is performed — a nonexistent path is simply passed to
    gcc, which reports it as a warning/error (D-020: パスの存在チェックはしない).
    """
    seen: List[str] = []
    for p in paths:
        if not isinstance(p, str):
            continue
        trimmed = p.strip()
        if trimmed and trimmed not in seen:
            seen.append(trimmed)
    return seen


def _merge_compile_config(compile_config: object, extra_include_paths: Sequence[str]) -> object:
    """Return a compile config whose ``include_paths`` has ``extra`` merge-appended.

    The request's include paths are appended after the config's existing ones,
    de-duplicated with order preserved (D-020: 追加 merge・重複排除・順序保持). When
    there is nothing to add (no extras, or all already present) the original
    config object is returned unchanged. Otherwise a deep copy is made so a shared
    / cached ``CompileValidationConfig`` is never mutated (mirrors config_override).
    """
    extras = _dedup_preserve_order(extra_include_paths)
    if not extras:
        return compile_config

    existing = list(getattr(compile_config, "include_paths", []) or [])
    merged = _dedup_preserve_order([*existing, *extras])
    if merged == existing:
        # Every extra was already present -> no change needed.
        return compile_config

    merged_config = copy.deepcopy(compile_config)
    # Best-effort: only assign when the attribute exists (real CompileValidationConfig).
    if hasattr(merged_config, "include_paths"):
        merged_config.include_paths = merged
    return merged_config


# Patterns that name a symbol missing because of absent external context, in
# order of specificity. Each capturing group is the symbol name.
_MISSING_SYMBOL_PATTERNS = (
    re.compile(r"unknown type name ['‘]([A-Za-z_]\w*)['’]"),
    re.compile(r"implicit declaration of function ['‘]([A-Za-z_]\w*)['’]"),
    re.compile(r"['‘]([A-Za-z_]\w*)['’] undeclared"),
)


def _extract_missing_symbols(stderr: str) -> List[str]:
    """Extract missing external symbols from compiler stderr, de-duplicated.

    Recognizes the common "external context absent" signatures gcc/clang emit:
    ``unknown type name 'X'``, ``implicit declaration of function 'Y'`` and
    ``'Z' undeclared``. Preserves first-seen order and drops duplicates. Returns
    an empty list when nothing matches (caller then uses a generic message).
    """
    seen: List[str] = []
    for pattern in _MISSING_SYMBOL_PATTERNS:
        for match in pattern.finditer(stderr or ""):
            name = match.group(1)
            if name and name not in seen:
                seen.append(name)
    return seen


# --- deterministic missing standard-include completion ----------------------
#
# A recurring, model-independent failure (user sample11, deepseek + gpt-5.6):
# an INT32-C repair uses ``int64_t`` / ``INT_MAX`` but does not add
# ``#include <stdint.h>`` / ``<limits.h>``, so the whole-file compile gate fails
# with ``unknown type name 'int64_t'``. gcc names the missing header explicitly
# in a note: ``'int64_t' is defined in header '<stdint.h>'; did you forget to
# '#include <stdint.h>'?``. When the missing header is a well-known STANDARD C
# header we can repair the omission deterministically (no LLM): parse the note,
# insert the ``#include`` after the last existing include, and recompile ONCE.
#
# Scope is intentionally narrow: only a fixed ALLOW-LIST of standard headers is
# ever auto-added, so we never invent a project/system header the environment
# may not have. The insertion is a global (file-level) hunk in Original
# coordinates, valid under D-022 because it rides a candidate that already
# changes the target function (SIG: the include is what the fix needs to
# compile).

# The standard C headers we are willing to auto-add. Anything gcc names outside
# this set is left to the reviewer (a non-standard header is an environment /
# context problem, not a deterministic omission we can safely patch).
_AUTO_INCLUDE_ALLOWLIST = (
    "stdint.h",
    "limits.h",
    "stddef.h",
    "stdbool.h",
    "string.h",
    "stdlib.h",
    "stdio.h",
    "math.h",
    "errno.h",
    "float.h",
    "inttypes.h",
)

# gcc "missing standard header" notes. Both phrasings name the header inside an
# angle-bracket clause; either is sufficient. Quotes are matched loosely
# (straight ' or curly ‘’) since gcc uses curly quotes by default. The header
# name is captured from ``<name>``.
_MISSING_INCLUDE_NOTE_PATTERNS = (
    re.compile(r"defined in header\s+['‘]?<([A-Za-z0-9_./+-]+\.h)>['’]?"),
    re.compile(r"did you forget to\s+['‘]?#include\s+<([A-Za-z0-9_./+-]+\.h)>['’]?"),
)


def _extract_suggested_standard_includes(stderr: str) -> List[str]:
    """Standard C headers gcc suggested via a "defined in header '<X>'" note.

    Scans ``stderr`` for gcc's missing-header notes (both phrasings), keeps only
    header names on ``_AUTO_INCLUDE_ALLOWLIST``, and returns them de-duplicated in
    first-seen order (the order the notes appear in stderr, which follows the
    first use of each symbol in the source). Returns an empty list when nothing
    on the allow-list is suggested — the caller then makes no change.
    """
    allow = set(_AUTO_INCLUDE_ALLOWLIST)
    seen: List[str] = []
    for pattern in _MISSING_INCLUDE_NOTE_PATTERNS:
        for match in pattern.finditer(stderr or ""):
            name = match.group(1)
            if name in allow and name not in seen:
                seen.append(name)
    return seen


# A ``#include`` directive line (system ``<...>`` or local ``"..."``), used to
# find the anchor for the auto-added includes (after the LAST existing include).
_ANY_INCLUDE_RE = re.compile(r'^[ \t]*#[ \t]*include[ \t]*[<"]', re.MULTILINE)


def _last_include_line(source: str) -> int:
    """1-based line number of the LAST ``#include`` in ``source``, or 0 if none.

    Scanned over the raw source lines (matching either ``<...>`` or ``"..."``
    includes). 0 means no include exists, so the caller inserts at the very top.
    """
    last = 0
    for i, line in enumerate(source.split("\n"), start=1):
        if _ANY_INCLUDE_RE.match(line):
            last = i
    return last


def _build_include_completion_hunk(
    headers: Sequence[str], original_content: str
) -> Optional[_Hunk]:
    """An insert hunk (Original coords) adding ``#include <h>`` for each header.

    The insertion anchors immediately AFTER the last existing ``#include`` line
    in the Original source (D-026 / D-004 anchor convention), or before line 1
    when the source has no include. The hunk is a single ``line_count == 0``
    insert whose ``replacement_text`` is the includes joined by ``\\n`` in
    first-seen (allow-list-filtered) order. Returns ``None`` when ``headers`` is
    empty (nothing to add).
    """
    if not headers:
        return None
    replacement = "\n".join(f"#include <{h}>" for h in headers)
    last = _last_include_line(original_content)
    anchor = last + 1 if last > 0 else 1
    return _Hunk(start_line=anchor, line_count=0, replacement_text=replacement)


def _include_hunk_overlaps(hunk: _Hunk, existing: Sequence[_Hunk]) -> bool:
    """Whether the include INSERT hunk collides with an already-kept hunk.

    An insertion is a zero-width point anchored at ``hunk.start_line``. It
    "overlaps" an existing hunk when that hunk's occupied span covers the anchor
    line: a replace/delete occupying ``[start, start + line_count - 1]`` that
    contains the anchor, or another insertion at the very same anchor line. In
    either case the include cannot be placed deterministically without disturbing
    a real fix hunk, so the completion is abandoned (logged) rather than risking a
    conflicting edit at the same coordinate.
    """
    a = hunk.start_line
    for h in existing:
        if h.line_count == 0:
            if h.start_line == a:
                return True
        else:
            if h.start_line <= a <= h.start_line + h.line_count - 1:
                return True
    return False


# --- missing local header extraction + stub two-stage probe -----------------
#
# A single .c seen in isolation (no project tree) fails at the *include* stage
# before any type/declaration error can surface: gcc emits
# ``fatal error: <name>: No such file or directory`` and stops, so the compile
# probe returns 0 missing symbols and context inference has nothing to work
# with. The remedy is a two-stage probe: detect the missing LOCAL (quoted)
# headers, drop an empty stub for each into a temp dir added to ``-I``, and
# re-probe. The include now passes and the real type/declaration errors surface,
# which the existing ``_extract_missing_symbols`` turns into inferable symbols.

# Same signature certfix's compile gate matches on stderr
# (``core/validation.py._MISSING_HEADER_RE``); reused so the bridge recognizes
# exactly the header names certfix's ``CompileCheckResult.missing_headers`` does.
_MISSING_HEADER_RE = re.compile(r"fatal error:\s+([^:\n]+):\s+No such file or directory")

# A quoted local include: ``#include "name"`` (double or, non-standardly, single
# quotes). System ``<...>`` includes are deliberately NOT matched — an absent
# system header is an environment problem, not missing external context, and
# stubbing it would mask a real toolchain gap.
_QUOTED_INCLUDE_RE = re.compile(
    r'^[ \t]*#[ \t]*include[ \t]*"([^"\n]+)"', re.MULTILINE
)


def _quoted_include_names(source: str) -> List[str]:
    """Header names included with quotes (``#include "x.h"``) in ``source``.

    Only quoted (local) includes are returned; ``#include <x.h>`` system includes
    are excluded. First-seen order, de-duplicated.
    """
    seen: List[str] = []
    for match in _QUOTED_INCLUDE_RE.finditer(source or ""):
        name = match.group(1).strip()
        if name and name not in seen:
            seen.append(name)
    return seen


def _extract_missing_local_headers(stderr: str, source: str) -> List[str]:
    """Missing LOCAL headers = gcc-reported missing headers ∩ quoted includes.

    ``stderr`` is scanned with the same ``fatal error: <name>: No such file or
    directory`` signature certfix uses, giving the header names gcc could not
    find. That message does not reveal the include *style* (the name is bare for
    both ``"x.h"`` and ``<x.h>``), so the result is intersected with the source's
    QUOTED includes: only headers that were included with quotes are returned, so
    a genuinely missing *system* header (``<x.h>``) is never stubbed. First-seen
    order (by the source's include order), de-duplicated.
    """
    reported = set(_MISSING_HEADER_RE.findall(stderr or ""))
    if not reported:
        return []
    # Order by the source's quoted-include order for determinism.
    return [name for name in _quoted_include_names(source) if name in reported]


def _write_stub_headers(stub_dir: str, header_names: Sequence[str]) -> None:
    """Write an empty stub header for each name under ``stub_dir`` — and ONLY under it.

    The stub is a single comment line (``/* stub for context inference */``) — the
    include resolves and reads nothing, so it never collides with the prelude
    (inferred declarations go into the composed prelude, the stub stays empty).
    Nested names (``sub/dir.h``) create their parent dirs. Never raises on a name
    with an unusual path; a stub that cannot be written is simply skipped.

    Containment (security): the header names come from the UNTRUSTED source's
    ``#include "..."`` lines, and naive ``base / name`` joining lets
    ``#include "../../x.h"`` escape the stub dir — and, per pathlib semantics,
    an ABSOLUTE name (``#include "/etc/foo.h"``) replaces the base entirely,
    so ``write_text`` would truncate/overwrite an arbitrary file. Every target
    is therefore resolved and verified to live inside the resolved stub dir
    before any mkdir/write; unsafe names are skipped and reported as a COUNT
    only (the names themselves are source content and are never logged).
    """
    base = Path(stub_dir).resolve()
    unsafe = 0
    for name in header_names:
        try:
            target = (base / name).resolve()
            try:
                target.relative_to(base)
            except ValueError:
                # Absolute name or traversal outside the stub dir -> never write.
                unsafe += 1
                continue
            if target == base:
                # Degenerate name resolving to the stub dir itself (e.g. ".").
                unsafe += 1
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("/* stub for context inference */\n", encoding="utf-8")
        except OSError:  # pragma: no cover - defensive; a bad name just isn't stubbed
            logger.warning("stub header could not be written for a missing local header")
    if unsafe:
        logger.warning(
            "stub probe: %d unsafe stub path(s) skipped (outside the stub dir)", unsafe
        )


@dataclass(frozen=True)
class StubProbeOutcome:
    """Outcome of the two-stage (stub-fallback) compile probe.

    ``outcome`` is the compile outcome of the probe that actually surfaced the
    declaration errors (the last re-probe of the stub loop when stubs were
    needed, else the first probe). ``stubbed_headers`` names the local headers a
    stub was created for, accumulated over all stub rounds (empty when the first
    probe already got past includes). ``missing_symbols`` is
    ``_extract_missing_symbols(outcome.stderr)`` — the inferable symbols the
    caller acts on.
    """

    outcome: "CompileOutcome"
    stubbed_headers: List[str] = field(default_factory=list)
    missing_symbols: List[str] = field(default_factory=list)


# Safety cap on stub/re-probe rounds. gcc reports only the FIRST missing include
# (fatal error ends the translation unit), so each round can reveal only the
# next missing header(s) — a file with N missing quoted includes needs up to
# ~N rounds. Real files exceed small caps: curl's url.c has 52 quoted includes
# (measured 2026-08-22; a cap of 15 left 37 unresolved, so symbol extraction
# saw only the include failure and infer never started). Each round is one
# local gcc -fsyntax-only run — no LLM call, no cost — so the cap is generous.
# Hitting it means the probe is not converging (pathological input) -> the
# caller degrades to the first-probe outcome rather than looping on.
_MAX_STUB_ROUNDS = 64


def _iterative_stub_probe(
    *,
    processed: str,
    source: str,
    compile_config: object,
    baseline_compile_runner: "BaselineCompileRunner",
    stub_dir: str,
    first_outcome: "CompileOutcome",
) -> tuple["CompileOutcome", List[str], object, bool]:
    """Stub missing local headers into ``stub_dir`` and re-probe, iteratively.

    gcc stops at the FIRST missing include, so one stub round reveals only the
    next missing header: a file with N missing quoted includes (zlib's
    inflate.c has 4) needs up to N rounds before the include stage is fully
    passed and the real type/declaration errors surface. Loop: extract the NEW
    missing local headers from the current stderr -> stub them (cumulative, same
    dir) -> re-probe with the stub dir on ``-I`` -> repeat until the compile
    succeeds or no new missing local header appears, capped at
    ``_MAX_STUB_ROUNDS`` re-probes.

    Returns ``(final_outcome, stubbed_headers, stub_config, capped)``:
    - ``final_outcome``: the last probe's outcome (meaningful stderr unless capped).
    - ``stubbed_headers``: every header stubbed, in discovery order (cumulative).
    - ``stub_config``: the compile config with ``stub_dir`` merged into
      ``include_paths`` (callers that keep the stubs alive reuse it).
    - ``capped``: True when the round cap was hit while the last stderr STILL
      names an un-stubbed local header (not converging; callers should degrade).
    """
    stub_config = _merge_compile_config(compile_config, [stub_dir])
    stubbed: List[str] = []
    outcome = first_outcome
    for _ in range(_MAX_STUB_ROUNDS):
        new_local = [
            h for h in _extract_missing_local_headers(outcome.stderr, source) if h not in stubbed
        ]
        if not new_local:
            # Include stage fully passed (or the failure is no longer an include
            # miss): ``outcome`` now carries the real diagnostics.
            return outcome, stubbed, stub_config, False
        stubbed.extend(new_local)
        _write_stub_headers(stub_dir, new_local)
        outcome = baseline_compile_runner(processed, stub_config)
        if outcome.ok:
            return outcome, stubbed, stub_config, False
    # Cap reached. If the last stderr still names a new local header the loop was
    # not converging -> capped; otherwise this last outcome is already final.
    still_new = [
        h for h in _extract_missing_local_headers(outcome.stderr, source) if h not in stubbed
    ]
    return outcome, stubbed, stub_config, bool(still_new)


def probe_with_stub_fallback(
    *,
    processed: str,
    source: str,
    compile_config: object,
    baseline_compile_runner: "BaselineCompileRunner",
) -> StubProbeOutcome:
    """Two-stage compile probe that stubs missing local headers, then re-probes.

    1. Probe ``processed`` as-is. If it compiles, or fails but already surfaced
       inferable symbols (no missing local headers), return that outcome — the
       common self-contained / already-includable case stays a single probe.
    2. Otherwise, if the failure is (partly) missing LOCAL quoted headers, write
       an empty stub for each into a per-call temp dir, merge that dir into the
       config's ``include_paths``, and re-probe — **iteratively**
       (``_iterative_stub_probe``): gcc stops at the first missing include, so
       each re-probe reveals only the next missing header; the loop stubs
       cumulatively until the include stage is passed (or the
       ``_MAX_STUB_ROUNDS`` safety cap). The type/declaration errors then
       surface and ``_extract_missing_symbols`` yields the symbols context
       inference needs. If the cap is hit while headers are still missing
       (non-converging), degrade to the FIRST probe's outcome (no symbols) while
       still reporting the headers stubbed so far.

    ``source`` is the raw Original C (used to tell quoted from angle includes);
    ``processed`` is the preprocessed, line-preserving text actually compiled.
    The temp dir is removed before returning (stubs are only needed during the
    re-probes). Never raises: on any error creating stubs it degrades to the
    first-probe outcome.
    """
    first = baseline_compile_runner(processed, compile_config)
    first_symbols = _extract_missing_symbols(first.stderr)
    missing_local = _extract_missing_local_headers(first.stderr, source)
    # Single-probe fast path ONLY when no local header is missing: compiled, or
    # the failure already carries the full diagnostics. A missing quoted include
    # is a FATAL error that truncates the translation unit, so any symbols seen
    # alongside it come from lines BEFORE that include (typically the composed
    # prelude) and the body was never checked — returning them as "the" missing
    # set under-reports (observed on curl-url.c: 77 prelude items -> a handful
    # of prelude-internal unknown types masked the whole body; check reported
    # stubbed=0). With a missing local header, stub and re-probe even if some
    # symbols already surfaced; the stubbed re-probe sees prelude AND body.
    if first.ok or (first_symbols and not missing_local):
        return StubProbeOutcome(outcome=first, stubbed_headers=[], missing_symbols=first_symbols)

    if not missing_local:
        return StubProbeOutcome(outcome=first, stubbed_headers=[], missing_symbols=[])

    stub_dir = tempfile.mkdtemp(prefix="cfx-stub-")
    try:
        final, stubbed, _stub_config, capped = _iterative_stub_probe(
            processed=processed,
            source=source,
            compile_config=compile_config,
            baseline_compile_runner=baseline_compile_runner,
            stub_dir=stub_dir,
            first_outcome=first,
        )
        if capped:
            # Not converging within the cap -> degrade to the first probe's
            # outcome (its stderr is the include failure; no symbols), but keep
            # the stubbed-so-far list so the caller can still surface it.
            logger.warning(
                "stub probe: round cap (%d) hit without passing the include stage "
                "(stubbed=%d) -> degrading to the first probe outcome",
                _MAX_STUB_ROUNDS,
                len(stubbed),
            )
            return StubProbeOutcome(outcome=first, stubbed_headers=stubbed, missing_symbols=[])
        return StubProbeOutcome(
            outcome=final,
            stubbed_headers=stubbed,
            missing_symbols=_extract_missing_symbols(final.stderr),
        )
    finally:
        shutil.rmtree(stub_dir, ignore_errors=True)


# --- hunk model -------------------------------------------------------------


@dataclass
class _Hunk:
    """A contract hunk in Original coordinates (1-indexed)."""

    start_line: int
    line_count: int
    replacement_text: str


# --- config accessor --------------------------------------------------------


@dataclass(frozen=True)
class RepairConfig:
    """The bits of certfix config the repair path needs.

    Extracted from a loaded ``certfix.config.Config`` (see ``from_certfix_config``)
    so tests can build one directly without a YAML file.
    """

    simple_repair_profile: str
    simple_max_tokens: int
    model_name: str
    compile_config: object  # certfix.config.CompileValidationConfig
    compile_enabled: bool
    violation_removal_enabled: bool
    violation_removal_method: str
    violation_removal_max_tokens: int
    violation_removal_override_denylist: List[str]
    semantic_enabled: bool
    semantic_max_tokens: int = 1024
    # Fix-role routing info used to resolve the model's output ceiling from
    # OpenRouter (see ModelCeilingResolver). ``fix_extra_body`` carries the
    # provider pin (if any); ``fix_api_key_env`` names the env var holding the
    # OpenRouter key. Optional so tests can build a RepairConfig without them.
    fix_extra_body: Optional[dict] = None
    fix_api_key_env: str = "OPENROUTER_API_KEY"

    @staticmethod
    def from_certfix_config(cfg: object) -> "RepairConfig":
        """Build from a loaded certfix ``Config``.

        The fix role name resolves the same way certfix's CLI does
        (``fix.simple_repairer_role`` -> ``models[role]``); the model *name* used
        for ``model_identity`` is that role's ``api.model``. The role's
        ``api.extra_body`` (provider pin) and ``api.api_key_env`` are captured so
        the repair path can resolve the model's output ceiling from OpenRouter.
        """
        fix = cfg.fix
        val = cfg.validation
        role_name = fix.simple_repairer_role or val.semantic.reviewer_role
        role = cfg.models.get(role_name) if role_name else None
        model_name = role.api.model if role is not None else "unknown"
        fix_extra_body = dict(getattr(role.api, "extra_body", {}) or {}) if role is not None else None
        fix_api_key_env = (
            getattr(role.api, "api_key_env", "OPENROUTER_API_KEY")
            if role is not None
            else "OPENROUTER_API_KEY"
        )
        return RepairConfig(
            simple_repair_profile=fix.simple_repair_profile,
            simple_max_tokens=fix.simple_max_tokens,
            model_name=model_name,
            compile_config=val.compile,
            compile_enabled=val.compile.enabled,
            violation_removal_enabled=val.violation_removal.enabled,
            violation_removal_method=val.violation_removal.method,
            violation_removal_max_tokens=val.violation_removal.max_tokens,
            violation_removal_override_denylist=list(val.violation_removal.override_denylist),
            semantic_enabled=val.semantic.enabled,
            # D-028: reasoning (xhigh) consumes ~2k tokens; keep headroom so the
            # semantic verdict content is never truncated (finish=length).
            semantic_max_tokens=4096,
            fix_extra_body=fix_extra_body,
            fix_api_key_env=fix_api_key_env,
        )


# --- result -----------------------------------------------------------------


@dataclass
class _Validation:
    name: str
    status: str  # pass / fail / skipped / not_run
    detail: str = ""


def _short_hash(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()[:12]


_DETAIL_LIMIT = 500


def _truncate_detail(text: str, limit: int = _DETAIL_LIMIT) -> str:
    """Cap ``text`` at ``limit`` chars, appending an explicit truncation marker.

    Keeps details bounded for the contract while making truncation visible so the
    reviewer knows the full text is available elsewhere (the extension surfaces
    the full detail on demand).
    """
    if len(text) <= limit:
        return text
    return text[:limit] + "… (truncated)"


# --- diff -> hunks ----------------------------------------------------------


def _align_trailing_newline(processed: str, fixed_code: str) -> tuple[str, str]:
    """Make the two texts agree on a single trailing newline, if either has one.

    Only the presence/absence of one trailing ``\\n`` is normalized (the common
    case: ``processed`` ends in ``\\n`` from the Original C, ``fixed_code`` was
    ``.strip()``ped by certfix). Interior lines are untouched, so no real change
    is ever hidden.
    """
    p_nl = processed.endswith("\n")
    f_nl = fixed_code.endswith("\n")
    if p_nl and not f_nl:
        return processed, fixed_code + "\n"
    if f_nl and not p_nl:
        return processed + "\n", fixed_code
    return processed, fixed_code


def _diff_to_hunks(processed: str, fixed_code: str) -> List[_Hunk]:
    """Coalesce a line diff between two whole texts into contract hunks.

    Coordinates are in the ``processed`` (== Augmented) space, 1-indexed.
    Contiguous changed regions are merged into one hunk:

    - a pure replace/delete over processed lines ``[a1, a2)`` -> ``start_line=a1+1``,
      ``line_count=a2-a1``, ``replacement_text`` = the new lines joined by ``\\n``
      (empty string when the region is a pure deletion).
    - a pure insert before processed line ``a1`` -> ``start_line=a1+1``,
      ``line_count=0``, ``replacement_text`` = inserted lines.

    ``difflib.SequenceMatcher`` opcodes already give maximal non-equal blocks, so
    no further coalescing across ``equal`` gaps is needed.

    Trailing-newline normalization: certfix's CODE_ONLY parse ``.strip()``s the
    fixed code, so ``fixed_code`` loses the trailing empty line that ``processed``
    carries (Original C usually ends in ``\\n``). Left unaligned this produces a
    spurious trailing-line deletion hunk. We align the two texts' trailing
    newline so the tail compares equal.
    """
    processed, fixed_code = _align_trailing_newline(processed, fixed_code)
    a = processed.split("\n")
    b = fixed_code.split("\n")
    sm = difflib.SequenceMatcher(a=a, b=b, autojunk=False)
    hunks: List[_Hunk] = []
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            continue
        replacement = "\n".join(b[j1:j2])
        if tag == "insert":
            # Insert b[j1:j2] before processed line i1 (0-indexed) -> 1-indexed anchor i1+1.
            hunks.append(_Hunk(start_line=i1 + 1, line_count=0, replacement_text=replacement))
        else:  # replace / delete
            # Replace processed lines [i1, i2) with b[j1:j2] (possibly empty -> delete).
            hunks.append(
                _Hunk(
                    start_line=i1 + 1,
                    line_count=i2 - i1,
                    replacement_text=replacement,
                )
            )
    return hunks


def _to_original_coords(
    hunks: Sequence[_Hunk], prelude_line_count: int, src_hash_short: str
) -> tuple[List[_Hunk], int]:
    """Subtract ``prelude_line_count`` from each hunk; drop prelude-touching ones.

    A hunk is dropped when, in Original coordinates:
    - a replace/delete (``line_count > 0``) starts at ``start_line <= 0`` (its
      first line lies at or above the prelude boundary), or
    - an insert (``line_count == 0``) anchors at ``start_line <= 0`` (insertion
      point inside / at the top of the prelude).

    Returns ``(kept_hunks, dropped_count)``. Dropped hunks are logged with the
    source hash and line numbers only (never content).
    """
    kept: List[_Hunk] = []
    dropped = 0
    for h in hunks:
        start = h.start_line - prelude_line_count
        if start < 1:
            dropped += 1
            logger.info(
                "repair diagnostic: hunk dropped (prelude range) "
                "src=%s augmented_start=%d original_start=%d line_count=%d",
                src_hash_short,
                h.start_line,
                start,
                h.line_count,
            )
            continue
        kept.append(_Hunk(start_line=start, line_count=h.line_count, replacement_text=h.replacement_text))
    return kept, dropped


# --- cosmetic hunk filter ---------------------------------------------------


def _norm_for_cosmetic(text: str) -> Optional[str]:
    """Comment- and whitespace-insensitive normal form of a code segment.

    Strips C comments, rstrips every line, drops empty lines, joins with ``\\n``.
    Used to decide whether a hunk's replacement differs from the raw Original
    segment in anything but comments / blank lines / trailing whitespace.

    Returns ``None`` when normalization cannot be trusted (``strip_c_comments``
    raised, e.g. a segment that begins or ends mid-block-comment). Callers must
    treat ``None`` as "cannot prove cosmetic" and KEEP the hunk (conservative).
    """
    from certfix.core.simple_repair import strip_c_comments

    try:
        stripped = strip_c_comments(text)
    except Exception:  # noqa: BLE001 - conservative: any parse failure -> keep hunk
        return None
    lines = [ln.rstrip() for ln in stripped.split("\n")]
    return "\n".join(ln for ln in lines if ln != "")


def _filter_cosmetic_hunks(
    hunks: Sequence[_Hunk], original_content: str, src_hash_short: str
) -> tuple[List[_Hunk], int]:
    """Drop hunks whose only effect is comment / blank-line / trailing-space churn.

    For each Original-coordinate hunk, the raw Original segment it replaces is
    ``original lines [start_line, start_line + line_count)`` (empty for an insert,
    ``line_count == 0``). A hunk is COSMETIC — and discarded — when the raw
    segment and the replacement text have the same comment-insensitive normal form
    (see ``_norm_for_cosmetic``); this covers an insert whose replacement
    normalizes to empty (only comments / blank lines inserted).

    Conservative by construction: if either normal form is ``None`` (parse could
    not be trusted), the hunk is KEPT. Keeping a cosmetic hunk is the pre-filter
    behavior and is safe; wrongly dropping a real fix is not.

    Returns ``(kept_hunks, cosmetic_count)``. Discarded hunks are logged with the
    source hash and line numbers only (never content).
    """
    original_lines = original_content.split("\n")
    kept: List[_Hunk] = []
    cosmetic = 0
    for h in hunks:
        # Raw Original segment for this hunk (Original coords are 1-indexed).
        start_idx = h.start_line - 1
        segment_lines = original_lines[start_idx : start_idx + h.line_count]
        raw_segment = "\n".join(segment_lines)

        norm_raw = _norm_for_cosmetic(raw_segment)
        norm_new = _norm_for_cosmetic(h.replacement_text)
        # Conservative: unparseable on either side -> cannot prove cosmetic -> keep.
        if norm_raw is not None and norm_new is not None and norm_raw == norm_new:
            cosmetic += 1
            logger.info(
                "repair diagnostic: hunk dropped (cosmetic) "
                "src=%s original_start=%d line_count=%d",
                src_hash_short,
                h.start_line,
                h.line_count,
            )
            continue
        kept.append(h)
    return kept, cosmetic


# --- function-scope hunk restriction (D-022) --------------------------------


def _resolve_target_function(
    function_id: str,
    finding: object,
    inventory: Sequence[FunctionInfo],
) -> Optional[FunctionInfo]:
    """Resolve the finding's target function from the inventory (D-022).

    Resolution order (defensive degradation):
    1. The inventory entry whose ``function_id`` matches ``function_id`` exactly.
    2. Otherwise, the function whose Original ``[start_line, end_line]`` range
       contains the finding's ``location.start_line`` (fallback when the client's
       function_id does not line up with this inventory build).
    3. Otherwise ``None`` — the caller then skips scope restriction entirely
       (legacy behaviour) and logs a warning.
    """
    for fn in inventory:
        if fn.function_id == function_id:
            return fn

    location = finding.get("location") if isinstance(finding, dict) else getattr(finding, "location", None)
    start = None
    if isinstance(location, dict):
        start = location.get("start_line")
    elif location is not None:
        start = getattr(location, "start_line", None)
    if isinstance(start, int):
        for fn in inventory:
            if fn.start_line <= start <= fn.end_line:
                return fn
    return None


def _hunk_intersects_range(hunk: _Hunk, start_line: int, end_line: int) -> bool:
    """Whether an Original-coordinate hunk touches the inclusive ``[start, end]``.

    Mirrors packages/core ``hunkRange`` / ``rangesIntersect`` semantics:
    - a replace/delete (``line_count > 0``) occupies ``[start_line, start_line +
      line_count - 1]`` and intersects when the two closed ranges overlap.
    - an insert (``line_count == 0``) is a zero-width point *between* lines
      ``start_line - 1`` and ``start_line``; it counts as inside a body when its
      anchor lands within the body OR immediately after its last line
      (``start_line - 1 <= end_line`` and ``start_line >= start_line``), i.e. the
      insertion boundary lies at or inside the function's range. Concretely the
      anchor line ``start_line`` in ``[start, end + 1]`` — inserting right after
      the closing brace still belongs to that function's edit.
    """
    if hunk.line_count == 0:
        # Insertion anchor at hunk.start_line; belongs to a body when it lands
        # inside it, or just past its last line (append at the tail of the fn).
        return start_line <= hunk.start_line <= end_line + 1
    h_start = hunk.start_line
    h_end = hunk.start_line + hunk.line_count - 1
    return h_start <= end_line and start_line <= h_end


def _restrict_to_function_scope(
    hunks: Sequence[_Hunk],
    target: FunctionInfo,
    inventory: Sequence[FunctionInfo],
    src_hash_short: str,
) -> tuple[List[_Hunk], int]:
    """Keep only hunks in the target function or global scope; drop other bodies.

    For each Original-coordinate hunk (after prelude drop + cosmetic filter):
    - **drop** when it intersects some *other* function's body — even if it ALSO
      intersects the target. The accept unit is the finding (D-022): a hunk that
      rewrites other functions alongside the target is not a finding-scoped fix.
      (Observed live on zlib-deflate: a degenerate whole-file replacement hunk —
      L1, count 2186, near-empty replacement — passed the old
      intersects-target-first check and wiped every function; only the semantic
      gate caught it.)
    - **keep** otherwise: it intersects only the target function's
      ``[start_line, end_line]``, or no function body at all (global scope:
      #include, macros, type definitions — file-level changes the fix may
      legitimately need; a hunk spanning the target plus adjacent global lines
      also stays).

    Returns ``(kept_hunks, dropped_count)``. Dropped hunks are logged with the
    source hash and line numbers only (never content).
    """
    kept: List[_Hunk] = []
    dropped = 0
    for h in hunks:
        # Other-function intersection is checked FIRST: a hunk touching another
        # body is out of scope no matter what else it touches.
        in_other_body = any(
            _hunk_intersects_range(h, fn.start_line, fn.end_line)
            for fn in inventory
            if fn.function_id != target.function_id
        )
        if in_other_body:
            dropped += 1
            logger.info(
                "repair diagnostic: hunk dropped (outside target function) "
                "src=%s target=%s original_start=%d line_count=%d",
                src_hash_short,
                target.function_id,
                h.start_line,
                h.line_count,
            )
            continue
        # Target function or global scope (no other function body) -> keep.
        kept.append(h)
    return kept, dropped


def _apply_hunks_to_processed(
    processed: str, hunks: Sequence[_Hunk], prelude_line_count: int
) -> str:
    """Reconstruct the reduced fixed whole-file text (Augmented coordinates).

    Maps each kept Original-coordinate hunk back to Augmented coordinates
    (``+ prelude_line_count``) and applies it to ``processed`` with the same
    semantics as packages/core ``applyHunks`` (STATE_MODEL §6): apply in
    descending ``start_line`` order, ``line_count == 0`` inserts before
    ``start_line``, ``n > 0`` replaces ``n`` lines from ``start_line`` (an empty
    replacement on a replace/delete removes those lines). The result is the
    whole-file text that actually gets validated (only the kept hunks applied),
    so the gates judge the changes that will really be accepted (D-022).
    """
    lines = processed.split("\n")
    # Descending by Augmented start_line so earlier edits don't shift later ones.
    for h in sorted(hunks, key=lambda x: x.start_line, reverse=True):
        aug_start = h.start_line + prelude_line_count
        idx = aug_start - 1
        if h.replacement_text == "" and h.line_count > 0:
            repl: List[str] = []
        else:
            repl = h.replacement_text.split("\n")
        if h.line_count == 0:
            lines[idx:idx] = repl
        else:
            lines[idx : idx + h.line_count] = repl
    return "\n".join(lines)


# --- validation window (D-033) ----------------------------------------------
#
# certfix's LLM validation gates (semantic / violation_removal) are designed for
# single-function-scale inputs (~200 lines). Feeding them the whole processed
# file (2k+ lines, twice per gate) makes diff localisation fail — observed live
# (zlib-deflate, Phase B): a reviewer answered "the fixed code is identical to
# the original" for a candidate with 2 real hunks, and every candidate failed
# semantic. D-033: run the LLM gates on a WINDOW — the target function's region
# ∪ every kept hunk's region (file-level hunks included), each padded with a few
# context lines and merged — cut from the SAME coordinates of the processed
# (Augmented) text and its reduced-fixed counterpart. The compile gate stays
# whole-file (the TU is what must compile).

_WINDOW_CONTEXT_LINES = 3


def _merge_intervals(intervals: Sequence[tuple]) -> List[tuple]:
    """Merge overlapping/adjacent 1-indexed inclusive intervals, sorted.

    Adjacent (gap 0) intervals coalesce too, so distinct output intervals are
    always separated by at least one untaken line.
    """
    merged: List[tuple] = []
    for start, end in sorted(intervals):
        if merged and start <= merged[-1][1] + 1:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


def _validation_window_intervals(
    hunks: Sequence[_Hunk],
    target_fn: Optional[FunctionInfo],
    prelude_line_count: int,
    total_lines: int,
    inventory: Sequence[FunctionInfo] = (),
) -> List[tuple]:
    """Window intervals in PROCESSED (Augmented) coordinates (D-033).

    Seeds: the target function's Original ``[start_line, end_line]`` (when
    resolved) plus every kept hunk's occupied region (an insertion seeds its
    anchor line). Original coordinates are shifted by ``prelude_line_count``
    into the Augmented space (the same offset ``_apply_hunks_to_processed``
    uses), padded with ``_WINDOW_CONTEXT_LINES`` context lines, clamped to the
    file, then merged. Every kept hunk lies wholly inside one interval by
    construction (its own span is a seed).

    Neighbour-function pad clipping (play.c live failure, 2026-08-23): the
    ±pad must NOT step into ANOTHER function's ``[start_line, end_line]`` —
    the LLM gates would then review non-target code, and the removal
    detector (non_target_advisory runs the detector over the WHOLE window)
    would attribute the neighbour's own unfixed violation to the target
    ("average_two still performs signed addition" observed live for a
    scale_reading INT32-C fix). The SEED span itself is never clipped: kept
    hunks touch only the target function or global lines (D-022 scope
    filter), and the target seed is the target's own range, so seeds are
    disjoint from other functions' ranges by construction. Only the pad is
    shortened, stopping at the neighbour's boundary; non-function lines
    between the boundary and the seed remain includable. Clipping engages
    only when the target function is resolved (matching the scope-filter
    degradation: an unresolved target keeps legacy behaviour).
    """
    seeds: List[tuple] = []
    if target_fn is not None:
        seeds.append(
            (target_fn.start_line + prelude_line_count, target_fn.end_line + prelude_line_count)
        )
    for h in hunks:
        aug_start = h.start_line + prelude_line_count
        span = max(h.line_count, 1)  # an insertion still anchors one line
        seeds.append((aug_start, aug_start + span - 1))

    # Other functions' Augmented ranges, for pad clipping. Empty when the
    # target is unresolved -> no clipping (legacy behaviour).
    others: List[tuple] = []
    if target_fn is not None:
        others = [
            (fn.start_line + prelude_line_count, fn.end_line + prelude_line_count)
            for fn in inventory
            if fn.function_id != target_fn.function_id
        ]

    padded: List[tuple] = []
    for start, end in seeds:
        lo = max(1, start - _WINDOW_CONTEXT_LINES)
        hi = min(total_lines, end + _WINDOW_CONTEXT_LINES)
        # Clip the pad (never the seed) out of other functions' bodies: raise
        # ``lo`` past any other function intruding on [lo, start-1]; lower
        # ``hi`` before any other function intruding on [end+1, hi].
        for o_start, o_end in others:
            if o_end >= lo and o_start < start:
                lo = max(lo, o_end + 1)
            if o_start <= hi and o_end > end:
                hi = min(hi, o_start - 1)
        # Defensive: the seed itself is never clipped away (seeds are disjoint
        # from other functions' ranges, so this only guards a malformed
        # inventory).
        lo = min(lo, start)
        hi = max(hi, end)
        if lo <= hi:
            padded.append((lo, hi))
    return _merge_intervals(padded)


def _extract_validation_window(
    processed: str,
    hunks: Sequence[_Hunk],
    prelude_line_count: int,
    target_fn: Optional[FunctionInfo],
    inventory: Sequence[FunctionInfo] = (),
) -> tuple[str, str]:
    """(window_original, window_fixed) for the LLM validation gates (D-033).

    Both sides are cut from the SAME merged intervals of the processed
    (Augmented) text: the original side is the interval slices concatenated
    verbatim; the fixed side is those slices with the kept hunks applied at
    window-local coordinates (identical edit semantics to
    ``_apply_hunks_to_processed``), so it equals the corresponding region of
    the reduced fixed whole file.

    Multiple regions are joined as a PLAIN newline concatenation — no
    separator or line-number comments. Rationale: the gates expect C code, and
    a bare concatenation of a function body plus a few file-level lines still
    reads as C, while an invented marker comment would appear identically on
    both sides of the diff at best (noise) or be flagged as a change at worst;
    certfix's own prompts add no region framing either.
    """
    lines = processed.split("\n")
    intervals = _validation_window_intervals(
        hunks, target_fn, prelude_line_count, len(lines), inventory
    )
    window_lines: List[str] = []
    spans: List[tuple] = []  # (aug_start, aug_end, window_offset0)
    for start, end in intervals:
        spans.append((start, end, len(window_lines)))
        window_lines.extend(lines[start - 1 : end])

    def window_index(aug_line: int) -> Optional[int]:
        for start, end, offset in spans:
            # ``end + 1`` admits an insertion anchored just past an interval's
            # last line (merged intervals are >= 2 lines apart, so unambiguous).
            if start <= aug_line <= end + 1:
                return offset + (aug_line - start)
        return None

    fixed_lines = list(window_lines)
    # Descending by start_line so earlier edits don't shift later positions
    # (same ordering rule as _apply_hunks_to_processed).
    for h in sorted(hunks, key=lambda x: x.start_line, reverse=True):
        idx = window_index(h.start_line + prelude_line_count)
        if idx is None:  # pragma: no cover — impossible: every hunk seeds an interval
            continue
        if h.replacement_text == "" and h.line_count > 0:
            repl: List[str] = []
        else:
            repl = h.replacement_text.split("\n")
        if h.line_count == 0:
            fixed_lines[idx:idx] = repl
        else:
            fixed_lines[idx : idx + h.line_count] = repl
    return "\n".join(window_lines), "\n".join(fixed_lines)


# --- generation window: function-window repair (D-035) -----------------------
#
# Whole-file repair regenerates the ENTIRE file, so on 2k-line inputs the
# completion scales with the file (5-9 minutes, high cost) and — before the
# D-034 cap — reasoning starved the content outright. D-035 applies the D-033
# idea to the GENERATION side: above a size threshold the model rewrites only a
# WINDOW = prelude + the file-level lines above the target function (includes /
# defines / typedefs / file statics) + the target function body. That is close
# to certfix's native single-function input shape, so the prompt profile stays
# unchanged. The window is a concatenation of non-contiguous slices, so a
# window-line -> Augmented-line map is kept and diff hunks are mapped back;
# a hunk whose range crosses a slice seam cannot be expressed in Augmented
# coordinates and is dropped (logged — a legitimate fix never needs to edit
# across an excluded region). Downstream (Original mapping, prelude/cosmetic/
# scope filters, D-033 validation, contract) is unchanged.

# Files at or below this many processed lines keep the proven whole-file path.
_WINDOW_REPAIR_MIN_LINES = 400

# Round 18: how many Augmented lines of CONTIGUOUS context above the target
# function the window includes. The earlier multi-slice shapes (file-level
# slice runs + the round-17 gap absorption) structurally invited seam drops:
# a reasoning-off re-draw reformats broadly, the diff anchor slides, and the
# churn+fix fuses into hunks that step on a slice boundary — measured twice on
# curl-url (round 17 moved the seam; Curl_close / Curl_conn_free still dropped
# at file-level slice boundaries, window_start≈247-248, several per repair).
# One contiguous region has exactly ONE seam (prelude end <-> context start),
# far above the function; neighbouring functions enter the window instead, and
# the D-022 scope filter drops their hunks downstream (live-proven defence).
# The extra completion (~120 lines ≈ 1k tokens) is an accepted cost,
# observable via the 12a usage line's window_lines.
_WINDOW_CONTEXT_ABOVE = 120


@dataclass(frozen=True)
class _RepairWindow:
    """A generation window over the processed (Augmented) text (D-035).

    ``text`` is the window the model rewrites; ``line_map[i]`` is the 1-based
    Augmented line number of 0-based window line ``i`` (strictly ascending;
    a jump of more than 1 between neighbours is a slice seam).
    """

    text: str
    line_map: List[int]


def _build_repair_window(
    processed: str,
    prelude_line_count: int,
    target_fn: FunctionInfo,
) -> _RepairWindow:
    """Build the D-035 generation window and its window->Augmented line map.

    Round-18 shape — exactly TWO slices (all in Augmented coordinates):
    1. the whole prelude (lines ``1..prelude_line_count``),
    2. one CONTIGUOUS context+function slice:
       ``max(prelude_end + 1, fn_start - _WINDOW_CONTEXT_ABOVE) .. fn_end``.

    So there is at most ONE seam (prelude end <-> context start), and none at
    all when the function sits within the context distance of the prelude (the
    clamp starts the slice right after the prelude). The context may include
    neighbouring functions and file-level lines alike; other functions' hunks
    are dropped by the D-022 scope filter downstream, not by seam mapping.
    """
    lines = processed.split("\n")
    total = len(lines)

    prelude_end = min(prelude_line_count, total)
    rows: List[int] = list(range(1, prelude_end + 1))

    fn_start = target_fn.start_line + prelude_line_count
    fn_end = min(target_fn.end_line + prelude_line_count, total)
    context_start = max(prelude_end + 1, fn_start - _WINDOW_CONTEXT_ABOVE)
    if context_start <= fn_end:
        rows.extend(range(context_start, fn_end + 1))

    text = "\n".join(lines[r - 1] for r in rows)
    return _RepairWindow(text=text, line_map=rows)


def _map_window_hunks_to_augmented(
    hunks: Sequence[_Hunk], line_map: Sequence[int], src_hash_short: str
) -> tuple[List[_Hunk], int]:
    """Map window-coordinate hunks to Augmented coordinates (D-035).

    A replace/delete maps only when its whole window range corresponds to
    CONSECUTIVE Augmented lines (no slice seam inside); its Augmented start is
    the mapped first row. An insertion (``line_count == 0``) maps via its
    anchor row: unambiguous when the anchor is window row 1, immediately after
    its predecessor in Augmented space, or one past the window end (append
    after the function's last line -> Augmented last+1). An insertion anchored
    right AT a seam is dropped — it could equally belong to the end of the
    previous slice or the start of the next, and guessing could land the edit
    hundreds of lines away; simplicity and safety win (a legitimate
    single-function fix does not insert exactly at an excluded region's edge).

    Returns ``(mapped_hunks, dropped_count)``; every drop is logged with line
    numbers only (never content).
    """
    mapped: List[_Hunk] = []
    dropped = 0
    n = len(line_map)

    def _drop(h: _Hunk) -> None:
        nonlocal dropped
        dropped += 1
        logger.info(
            "repair diagnostic: hunk dropped (window seam) "
            "src=%s window_start=%d line_count=%d",
            src_hash_short,
            h.start_line,
            h.line_count,
        )

    for h in hunks:
        if h.line_count == 0:
            w = h.start_line
            if w == n + 1:
                # Append at the window end == right after the function's last line.
                mapped.append(
                    _Hunk(start_line=line_map[-1] + 1, line_count=0, replacement_text=h.replacement_text)
                )
                continue
            if w < 1 or w > n:  # pragma: no cover — defensive; diff cannot produce this
                _drop(h)
                continue
            if w == 1 or line_map[w - 2] + 1 == line_map[w - 1]:
                mapped.append(
                    _Hunk(start_line=line_map[w - 1], line_count=0, replacement_text=h.replacement_text)
                )
                continue
            _drop(h)  # anchored exactly at a seam -> ambiguous -> dropped
            continue

        start_idx = h.start_line - 1
        end_idx = start_idx + h.line_count - 1
        if start_idx < 0 or end_idx >= n:  # pragma: no cover — defensive
            _drop(h)
            continue
        if any(line_map[i] + 1 != line_map[i + 1] for i in range(start_idx, end_idx)):
            _drop(h)  # the replaced range crosses a slice seam
            continue
        mapped.append(
            _Hunk(
                start_line=line_map[start_idx],
                line_count=h.line_count,
                replacement_text=h.replacement_text,
            )
        )
    return mapped, dropped


# --- validation mapping -----------------------------------------------------


def _semantic_fail_detail(semantic_result: object) -> str:
    """The semantic-fail detail: the certfix reason, else the verdict name (D-023).

    Wires ``SemanticCheckResult.reason`` (or the underlying
    ``SemanticAutoApplyResult.reason``) into the contract detail so the reviewer
    sees *why* the semantic gate objected, not just a fixed phrase. When no reason
    text is available, fall back to the verdict name (e.g. ``FAIL`` / ``UNCERTAIN``)
    so the row is never empty. Bounded + truncation-marked like every other detail.
    """
    reason = getattr(semantic_result, "reason", "") or ""
    reason = reason.strip()
    if reason:
        return _truncate_detail(reason)
    verdict = getattr(semantic_result, "verdict", None)
    verdict_name = getattr(verdict, "name", None) or (str(verdict) if verdict is not None else "")
    if verdict_name:
        return f"semantic verdict: {verdict_name}"
    return "semantic auto-apply gate did not pass"


def _violation_removal_fail_detail(removal_result: object) -> str:
    """The violation-removal-fail detail (D-023).

    certfix's ``ViolationRemovalResult`` carries a human ``reason`` and a
    ``remaining_evidence`` string; prefer the reason, fall back to the evidence,
    and — when the gate ran but neither is populated — a count of the violations
    that remain. When no result object exists at all (backend absent path, which
    the map already routes to ``skipped``) the caller keeps the legacy phrase.
    """
    reason = (getattr(removal_result, "reason", "") or "").strip()
    if reason:
        return _truncate_detail(reason)
    evidence = (getattr(removal_result, "remaining_evidence", "") or "").strip()
    if evidence:
        return _truncate_detail(evidence)
    remaining = getattr(removal_result, "remaining_violations", None)
    if remaining:
        return f"{len(remaining)} target violation(s) remain after the fix"
    return "target violation may remain after the fix"


def _regression_fail_detail(
    validator_result: object, semantic_result: object, removal_result: object
) -> str:
    """The regression-fail detail: summarise the programmatic findings (D-023).

    Regression is a derived signal (certfix folds it out of the semantic + removal
    audits). Prefer a summary of the deterministic ``programmatic_findings`` (kind
    counts + the first finding's reason) since those are the concrete, reviewable
    evidence; otherwise fall back to the semantic ``reason`` (a model-flagged
    ``new_regression``) or the removal ``reason`` (a non-target introduction).
    """
    findings = list(getattr(validator_result, "programmatic_findings", None) or [])
    if findings:
        # Count by check_id (the finding "kind"); name the first with its reason.
        counts: dict[str, int] = {}
        for f in findings:
            check_id = getattr(f, "check_id", None) or "check"
            counts[check_id] = counts.get(check_id, 0) + 1
        summary = ", ".join(f"{cid} x{n}" if n > 1 else cid for cid, n in counts.items())
        first_reason = (getattr(findings[0], "reason", "") or "").strip()
        detail = f"programmatic findings ({len(findings)}): {summary}"
        if first_reason:
            detail += f" — {first_reason}"
        return _truncate_detail(detail)
    semantic_reason = (getattr(semantic_result, "reason", "") or "").strip()
    if semantic_reason:
        return _truncate_detail(semantic_reason)
    removal_reason = (getattr(removal_result, "reason", "") or "").strip()
    if removal_reason:
        return _truncate_detail(removal_reason)
    return "the fix may introduce a regression"


def _baseline_skip_detail(missing_symbols: Sequence[str]) -> str:
    """The compile-skipped detail when the unrepaired file itself won't compile.

    Names the missing external symbols when they could be extracted, and always
    states that external-context completion is the planned remedy.
    """
    if missing_symbols:
        symbols = ", ".join(missing_symbols)
        missing_clause = f" Missing symbols: {symbols}."
    else:
        missing_clause = ""
    return (
        "baseline (unrepaired) file does not compile — validation not meaningful."
        f"{missing_clause} External-context completion (planned) is required."
    )


def _map_validations(
    validator_result: object,
    *,
    compile_probe: CompileProbe,
    compile_enabled: bool,
    violation_removal_enabled: bool,
    violation_backend_present: bool,
    semantic_enabled: bool,
    semantic_backend_present: bool,
    baseline_compile_failed: bool = False,
    baseline_missing_symbols: Sequence[str] = (),
    semantic_result: object = None,
    removal_result: object = None,
) -> List[_Validation]:
    """Map a certfix ``FixValidatorResult`` to the 5 contract validations.

    Gate statuses:
    - **format**: pass/fail from ``format_ok`` (always run locally).
    - **compile**: ``skipped`` when no compiler, the gate is disabled, or the
      baseline (unrepaired) file itself does not compile (detail carries the
      reason); otherwise pass/fail from ``compile_ok``.
    - **violation_removal**: ``not_run`` when the gate is disabled;
      ``skipped`` when enabled but no detector backend was supplied; else
      pass/fail from ``violation_removed``.
    - **semantic**: ``not_run`` when disabled; ``skipped`` when enabled but no
      reviewer backend; else pass/fail from ``semantic_ok``.
    - **regression**: derived from ``regression_free`` (certfix folds the
      regression signal into the semantic/removal audits). ``skipped`` when both
      contributing gates were skipped/not run; else pass/fail.

    Judgment-gate fail details (D-023): when a judgment gate (violation_removal /
    semantic / regression) fails, its ``detail`` carries the certfix reason text
    (``semantic_result`` / ``removal_result`` / ``validator.programmatic_findings``)
    instead of a fixed phrase, so the reviewer sees why the model objected before
    deciding whether to accept-with-warning.
    """
    v = validator_result
    validations: List[_Validation] = []

    # format
    validations.append(
        _Validation(
            name="format",
            status="pass" if v.format_ok else "fail",
            detail="" if v.format_ok else "generated code failed the format gate",
        )
    )

    # compile
    if not compile_enabled or not compile_probe.available or baseline_compile_failed:
        if not compile_enabled:
            detail = "compile gate disabled in config"
        elif not compile_probe.available:
            detail = compile_probe.detail
        else:  # baseline_compile_failed
            detail = _baseline_skip_detail(baseline_missing_symbols)
        validations.append(_Validation(name="compile", status="skipped", detail=detail))
    else:
        validations.append(
            _Validation(
                name="compile",
                status="pass" if v.compile_ok else "fail",
                detail=""
                if v.compile_ok
                else (_truncate_detail(v.compiler_stderr) or "compile check failed"),
            )
        )

    # violation_removal
    if not violation_removal_enabled:
        validations.append(
            _Validation(name="violation_removal", status="not_run", detail="gate disabled in config")
        )
    elif not violation_backend_present:
        validations.append(
            _Validation(
                name="violation_removal",
                status="skipped",
                detail="no violation-removal detector backend configured",
            )
        )
    else:
        validations.append(
            _Validation(
                name="violation_removal",
                status="pass" if v.violation_removed else "fail",
                detail=""
                if v.violation_removed
                else _violation_removal_fail_detail(removal_result),
            )
        )

    # semantic
    if not semantic_enabled:
        validations.append(
            _Validation(name="semantic", status="not_run", detail="gate disabled in config")
        )
    elif not semantic_backend_present:
        validations.append(
            _Validation(
                name="semantic",
                status="skipped",
                detail="no semantic reviewer backend configured",
            )
        )
    else:
        validations.append(
            _Validation(
                name="semantic",
                status="pass" if v.semantic_ok else "fail",
                detail=""
                if v.semantic_ok
                else _semantic_fail_detail(semantic_result if semantic_result is not None else v.semantic_check_result),
            )
        )

    # regression: certfix derives regression_free from the semantic + removal
    # audits. If neither of those actually ran (both disabled/skipped), the
    # regression signal is not meaningful -> skipped.
    removal_ran = violation_removal_enabled and violation_backend_present
    semantic_ran = semantic_enabled and semantic_backend_present
    if not removal_ran and not semantic_ran:
        validations.append(
            _Validation(
                name="regression",
                status="skipped",
                detail="no gate produced a regression signal",
            )
        )
    else:
        validations.append(
            _Validation(
                name="regression",
                status="pass" if v.regression_free else "fail",
                detail=""
                if v.regression_free
                else _regression_fail_detail(v, semantic_result, removal_result),
            )
        )

    return validations


# --- public entry point -----------------------------------------------------


def run_repair(
    *,
    backend: _BackendLike,
    config: RepairConfig,
    finding: dict,
    function_id: str,
    source_id: str,
    original_content: str,
    original_hash: str,
    context_revision_id: str,
    items: Sequence[object],
    prelude_line_count: int,
    compile_runner: Optional[CompileRunner] = None,
    baseline_compile_runner: Optional[BaselineCompileRunner] = None,
    semantic_backend: Optional[_BackendLike] = None,
    violation_backend: Optional[_BackendLike] = None,
    compile_include_paths: Optional[Sequence[str]] = None,
    harness_version: Optional[str] = None,
    ceiling_resolver: Optional[ModelCeilingResolver] = None,
    redraw_backend: Optional[_BackendLike] = None,
) -> dict:
    """Run a repair for one finding and return a RepairCandidate dict.

    Args:
        backend: Injected fix-role InferenceBackend (fake in tests). Must expose
            ``generate`` and ``is_available``.
        config: Extracted repair/validation config (see ``RepairConfig``).
        finding: The scan ``finding`` object (contract). ``rule_id`` drives the
            repair; ``finding_id`` is echoed into the candidate.
        function_id: The target function's id (echoed into the candidate).
        source_id / original_content / original_hash / context_revision_id:
            SourceDocument + confirmed-set identity, echoed into the candidate.
        items: Confirmed augmentation items (may be empty) used to compose the
            prelude.
        prelude_line_count: Augmented-C prelude line count (for coordinate
            subtraction).
        compile_runner: Injectable compiler probe (defaults to PATH probe). When
            it reports unavailable, ``compile`` is recorded as ``skipped``.
        baseline_compile_runner: Injectable whole-file compiler for the baseline
            (unrepaired) pre-check (defaults to certfix's compile gate). Only used
            when the compile gate would run; when the baseline itself fails to
            compile, the candidate compile gate is skipped (validation would be
            meaningless) with a detail naming the missing external symbols.
        semantic_backend / violation_backend: Optional validation backends. When
            None, the corresponding gate is skipped/not_run per config.
        compile_include_paths: Optional extra ``-I`` include paths (D-020). Merged
            (append, de-dup, order-preserving) into the effective compile config's
            ``include_paths`` and applied to BOTH the baseline pre-check and the
            candidate compile gate. Paths are not existence-checked (gcc reports
            bad ones). No effect when the compile gate would not run.
        harness_version: certfix version (defaults to ``certfix.__version__``).
        redraw_backend: Optional REASONING-OFF backend for the window path's
            finish=length re-draw (round 16). Live measurement showed the
            same-backend re-draw cannot rescue a model whose reasoning ignores
            its explicit cap (both draws finish=length, reasoning ~32k), while
            D-018 established that with reasoning off the same route returns
            plain content that completes. ``None`` -> the re-draw uses the
            primary ``backend`` (the round-15 behaviour; test back-compat).
            Fix quality without reasoning is the validation gates' job to
            judge (D-033 windowed gates), not this call site's.

    Returns:
        A dict matching repair-candidate.schema.json.
    """
    from certfix.core.fix_validator import validate_fix_result
    from certfix.core.preprocessor import Preprocessor
    from certfix.core.simple_repair import run_simple_repair
    from certfix.models import FixResult as CertfixFixResult

    harness_version = harness_version or certfix.__version__
    compile_runner = compile_runner or default_compile_runner
    baseline_compile_runner = baseline_compile_runner or default_baseline_compile_runner
    src_hash_short = _short_hash(original_content)

    # Merge the request's include paths into the effective compile config (D-020).
    # Used for BOTH the baseline pre-check and the candidate compile gate. When
    # there is nothing to add this is the original config object (no mutation).
    extra_includes = list(compile_include_paths or [])
    compile_config = _merge_compile_config(config.compile_config, extra_includes)
    if extra_includes:
        # Log the COUNT only (never the paths' contents beyond count) — additive,
        # non-sensitive; helps diagnose "why did compile succeed/fail" (D-020).
        logger.info(
            "repair compile include paths: src=%s requested=%d effective=%d",
            src_hash_short,
            len(extra_includes),
            len(getattr(compile_config, "include_paths", []) or []),
        )

    rule_id = finding.get("rule_id") if isinstance(finding, dict) else getattr(finding, "rule_id", None)
    finding_id = finding.get("finding_id") if isinstance(finding, dict) else getattr(finding, "finding_id", "")

    candidate_id = "cand-" + hashlib.sha256(
        f"{function_id}:{finding_id}:{context_revision_id}".encode("utf-8")
    ).hexdigest()[:12]

    def _candidate(status: str, explanation: str, hunks: List[_Hunk], validations: List[_Validation]) -> dict:
        return {
            "candidate_id": candidate_id,
            "finding_id": finding_id or "",
            "function_id": function_id,
            "source_id": source_id,
            "original_hash": original_hash,
            "context_revision_id": context_revision_id,
            "status": status,
            "repair_explanation": explanation,
            "hunks": [
                {
                    "hunk_id": f"hunk-{candidate_id}-{i}",
                    "start_line": h.start_line,
                    "line_count": h.line_count,
                    "replacement_text": h.replacement_text,
                }
                for i, h in enumerate(hunks)
            ],
            "validations": [
                {"name": val.name, "status": val.status, **({"detail": val.detail} if val.detail else {})}
                for val in validations
            ],
            "model_identity": config.model_name,
        }

    # 1. Compose Augmented C and preprocess (line-structure-preserving strip).
    augmented = compose.compose_augmented_c(items, original_content)
    processed, _mapping, _ignored = Preprocessor(keep_comments=False).process(augmented)

    # 1a. Function inventory + target resolution (used by the D-035 window
    #     decision here AND by the D-022 scope restriction downstream — built
    #     once; both consumers see the same view).
    inventory = build_inventory(original_content)
    target_fn = _resolve_target_function(function_id, finding, inventory)

    # 1a'. D-035: above the size threshold, and with a resolved target
    #     function, the model rewrites a WINDOW (prelude + one contiguous
    #     context+function slice, round 18) instead of the whole file —
    #     completion cost then scales with the function, not the file. At or
    #     below the threshold (or when the target cannot be resolved) the
    #     proven whole-file path is kept unchanged.
    window: Optional[_RepairWindow] = None
    if len(processed.split("\n")) > _WINDOW_REPAIR_MIN_LINES and target_fn is not None:
        window = _build_repair_window(processed, prelude_line_count, target_fn)
        logger.info(
            "repair diagnostic: function-window repair src=%s function=%s "
            "window_lines=%d file_lines=%d",
            src_hash_short,
            function_id,
            len(window.line_map),
            len(processed.split("\n")),
        )
    repair_code = window.text if window is not None else processed

    # 1b. Resolve the whole-file-repair output ceiling from the effective model's
    #     max_completion_tokens (task §1 correction): the real limit is the model's
    #     output length, not a fixed constant. Lazily fetched + cached per model id
    #     (static fallback on any failure). The OpenRouter key comes from the fix
    #     role's api_key_env.
    resolver = ceiling_resolver or model_ceiling
    ceiling = resolver.resolve(
        config.model_name,
        extra_body=config.fix_extra_body,
        api_key=os.environ.get(config.fix_api_key_env or "OPENROUTER_API_KEY"),
    )

    # 1c. Oversize guard (task §1/§2): if the repair INPUT (the window on the
    #     D-035 path, else the whole file) is too large to regenerate even at
    #     the model's output ceiling, fail fast BEFORE calling the LLM.
    #     Repairing it would truncate (finish=length) and bill for a useless output,
    #     so we return repair_failed with model-dependent guidance instead of
    #     spending. The wording avoids concrete numbers (the limit is model-specific).
    if repair_budget_exceeds_ceiling(repair_code, ceiling=ceiling):
        logger.info(
            "repair diagnostic: file too large for whole-file repair "
            "src=%s function=%s ceiling=%d",
            src_hash_short,
            function_id,
            ceiling,
        )
        return _candidate(
            status="repair_failed",
            explanation=(
                "This file exceeds the output budget of the current model for "
                "whole-file repair. Split the function/file or run the repair on a "
                "smaller extract."
            ),
            hunks=[],
            validations=[],
        )

    # 2. Run the repair over the repair input (window or whole processed text).
    #    Size the completion budget to that input (task §1 / D-035: the window
    #    path shrinks the content term to window scale). The config's
    #    simple_max_tokens is the floor; the model's output ceiling is the cap;
    #    validation-gate budgets are unaffected. The reasoning allowance is the
    #    fix role's explicit reasoning cap (D-034: effort was converted to
    #    reasoning.max_tokens by the factory), so content room is structural.
    repair_max_tokens = estimate_repair_max_tokens(
        repair_code,
        base=config.simple_max_tokens,
        ceiling=ceiling,
        reasoning_allowance=_fix_reasoning_cap(config.fix_extra_body),
    )
    rules = [rule_id] if rule_id else None
    # Reset this thread's finish_reason before the call so that, on a None /
    # unparseable result, we read the finish_reason of THIS repair completion (and
    # not a stale value from a prior step). Thread-local => concurrency-safe.
    # LLM-failure protection (round 10, same classification as infer): a
    # provider can return HTTP 200 with a truncated/invalid JSON body, which
    # certfix surfaces as an exception (observed live: JSONDecodeError at char
    # 4653 -> a 500 from /repair). Map ANY Exception to a repair_failed
    # candidate instead — repair is a minutes-long operation and a 500 shows
    # the raw HTTP error in the extension, while a candidate rides the existing
    # failure UX. RequestCancelled (BaseException) passes through untouched.
    #
    # Round 15 (window path only): when the completion finished with
    # ``length`` — a model pathology, not a budget problem (measured live:
    # reasoning overran its supposedly-hard cap 30,789 > 24,576, and a run
    # with 9.7k tokens of content headroom still failed to terminate) — ONE
    # same-prompt re-draw at the same budget rides provider non-determinism to
    # a different sample, exactly as the infer path already does. ``unknown``
    # (recorder not populated, e.g. non-tracked backends) is conservative: no
    # re-draw. The whole-file path never re-draws (its length failures are the
    # oversize family, where a re-draw cannot help).
    max_attempts = 2 if window is not None else 1
    fix_result = None
    for attempt in range(max_attempts):
        # Round 16: the re-draw (attempt 1) runs on the REASONING-OFF backend
        # when one was provided — live showed a same-backend re-draw cannot
        # rescue a model whose reasoning ignores its explicit cap (both draws
        # finish=length, reasoning ~32k), while reasoning off completes
        # (D-018). Quality without reasoning is judged by the validation gates.
        on_redraw_backend = attempt > 0 and redraw_backend is not None
        active_backend = redraw_backend if on_redraw_backend else backend
        usage_before = _usage_snapshot()  # 12a: delta base for the usage line
        usage_tracker.reset_finish_reason()
        try:
            fix_result = run_simple_repair(
                code=repair_code,
                file_path="augmented.c",
                backend=active_backend,
                rules=rules,
                max_tokens=repair_max_tokens,
                prompt_profile=config.simple_repair_profile,
            )
        except Exception as exc:  # noqa: BLE001 — degrade; loudness depends on class
            _log_llm_failure("repair", exc)
            return _candidate(
                status="repair_failed",
                explanation=_PROVIDER_FAILURE_EXPLANATION,
                hunks=[],
                validations=[],
            )
        finally:
            # 12a (measurement): the prompt/completion/reasoning split of THIS
            # call + finish_reason + the requested budget, one INFO line — the
            # data the budget-formula decision needs. Runs on the failure path
            # too (spend happened either way). D-035: window=0|1 (+
            # window_lines) marks the generation path; retry=0|1 the attempt;
            # redraw=reasoning-off marks the round-16 backend switch.
            _log_llm_usage(
                "repair",
                src_hash_short,
                function_id,
                repair_max_tokens,
                usage_before,
                window=window is not None,
                window_lines=len(window.line_map) if window is not None else 0,
                retry=attempt,
                redraw="reasoning-off" if on_redraw_backend else None,
            )
        if attempt + 1 >= max_attempts:
            break
        if not usage_tracker.is_truncation_finish_reason(usage_tracker.last_finish_reason()):
            break
        logger.info(
            "repair diagnostic: window repair truncated (finish=length) -> "
            "one same-prompt re-draw src=%s function=%s redraw_backend=%s",
            src_hash_short,
            function_id,
            "reasoning-off" if redraw_backend is not None else "same",
        )

    # 2b. Fail-close on a TRUNCATED final completion (round 19, Codex MUST).
    #     A finish=length output is never a valid whole regeneration: its tail
    #     is cut at an arbitrary point, so even a non-empty, non-identical text
    #     would diff into fabricated deletions/replacements at the cut. The
    #     previous shape only caught truncation when the output was empty or
    #     unchanged; a truncated-but-different output slid into the diff and
    #     could become a bogus candidate. finish=unknown (recorder not
    #     populated, e.g. untracked backends) passes through — conservative, no
    #     false trips. Applies to BOTH paths (window after its re-draw,
    #     whole-file on its single attempt).
    if usage_tracker.is_truncation_finish_reason(usage_tracker.last_finish_reason()):
        logger.info(
            "repair diagnostic: truncated completion -> fail-close "
            "src=%s function=%s window=%d",
            src_hash_short,
            function_id,
            1 if window is not None else 0,
        )
        return _candidate(
            status="repair_failed",
            explanation=(
                "The model's output was truncated (the file is too large for whole-file "
                "repair at the current budget). Consider splitting large functions or "
                "repairing a smaller file."
            ),
            hunks=[],
            validations=[],
        )

    # 3. No fix produced -> repair_failed (empty hunks, no validations). A
    #    truncated completion was already handled above (fail-close), so this
    #    is the generic no-fix shape.
    if fix_result is None or not fix_result.fixed_code or fix_result.fixed_code == repair_code:
        logger.info(
            "repair diagnostic: no fix produced src=%s function=%s",
            src_hash_short,
            function_id,
        )
        return _candidate(
            status="repair_failed",
            explanation="The harness did not produce a fix for this finding.",
            hunks=[],
            validations=[],
        )

    # 4. Diff -> hunks in Augmented space, then map to Original. On the D-035
    #    window path the diff runs in WINDOW coordinates and each hunk is mapped
    #    to Augmented via the window's line map; a hunk that crosses a slice
    #    seam cannot be expressed there and is dropped (logged). From the
    #    Augmented hunks on, both paths share the identical downstream.
    if window is not None:
        window_hunks = _diff_to_hunks(repair_code, fix_result.fixed_code)
        aug_hunks, seam_dropped = _map_window_hunks_to_augmented(
            window_hunks, window.line_map, src_hash_short
        )
        if window_hunks and not aug_hunks:
            logger.info(
                "repair diagnostic: all hunks dropped (window seam) "
                "src=%s function=%s dropped=%d",
                src_hash_short,
                function_id,
                seam_dropped,
            )
            return _candidate(
                status="repair_failed",
                explanation="The proposed fix could not be mapped back to the target "
                "function or its file-level context (all changes crossed excluded "
                "regions) and was discarded.",
                hunks=[],
                validations=[],
            )
    else:
        aug_hunks = _diff_to_hunks(processed, fix_result.fixed_code)
    original_hunks, dropped = _to_original_coords(aug_hunks, prelude_line_count, src_hash_short)

    if not original_hunks:
        # Every change landed in the prelude (nothing applies to Original C).
        logger.info(
            "repair diagnostic: all hunks dropped (prelude) src=%s function=%s dropped=%d",
            src_hash_short,
            function_id,
            dropped,
        )
        return _candidate(
            status="repair_failed",
            explanation="The proposed fix only modified inferred context (prelude) and left the "
            "Original source unchanged.",
            hunks=[],
            validations=[],
        )

    # 4b. Filter cosmetic hunks (comment / blank-line / trailing-space-only) so a
    #     repair applied to the raw Original C never churns non-fix comments.
    original_hunks, cosmetic = _filter_cosmetic_hunks(
        original_hunks, original_content, src_hash_short
    )

    if not original_hunks:
        # Nothing but cosmetic churn survived -> the fix carried no real change.
        logger.info(
            "repair diagnostic: all hunks dropped (cosmetic) src=%s function=%s cosmetic=%d",
            src_hash_short,
            function_id,
            cosmetic,
        )
        return _candidate(
            status="repair_failed",
            explanation="The proposed fix contained no substantive change to the Original source "
            "(only comment or formatting differences).",
            hunks=[],
            validations=[],
        )

    # 4c. Restrict hunks to the target function's scope (D-022). whole-file repair
    #     also rewrites unrelated functions "for free"; the accept unit is the
    #     finding, so a candidate must only carry changes to its own function (plus
    #     global/file-level changes the fix needs). The inventory / target were
    #     resolved once at step 1a (shared with the D-035 window decision); when
    #     the target could not be resolved, degrade to legacy behaviour (no
    #     restriction) with a warning. On the window path this is structurally a
    #     no-op for other functions (they are not in the window) — kept as a
    #     second line of defence (D-035).
    out_of_scope = 0
    global_only = False  # round 21: no kept hunk touches the target function
    if target_fn is not None:
        original_hunks, out_of_scope = _restrict_to_function_scope(
            original_hunks, target_fn, inventory, src_hash_short
        )
        if not original_hunks:
            # Every surviving hunk targeted OTHER functions -> nothing applies to
            # the finding's function. This is not a valid finding-scoped fix.
            logger.info(
                "repair diagnostic: all hunks dropped (out of target function scope) "
                "src=%s function=%s dropped=%d",
                src_hash_short,
                function_id,
                out_of_scope,
            )
            return _candidate(
                status="repair_failed",
                explanation="The proposed fix made no change to the target function "
                "(all changes fell outside it and were discarded).",
                hunks=[],
                validations=[],
            )
        # Round 21 (revising round 19's unconditional rejection): a candidate
        # whose kept hunks never touch the target range is only FLAGGED here.
        # Declaration-rule fixes (DCL31/37/40 family) legitimately change only
        # global declarations — measured live (clearkey / lua-lgc DCL37-C): a
        # valid global-only fix that round 19 wrongly rejected. The decision
        # moves to AFTER validation: acceptable iff the violation_removal gate
        # positively confirmed the fix (Codex's original OR condition — target
        # intersection OR removal-positive).
        global_only = not any(
            _hunk_intersects_range(h, target_fn.start_line, target_fn.end_line)
            for h in original_hunks
        )
    else:
        # Defensive degradation: neither function_id nor finding.location resolved
        # to a function -> keep the legacy whole-file behaviour and warn.
        logger.warning(
            "repair diagnostic: target function unresolved; scope restriction skipped "
            "src=%s function=%s inventory_size=%d",
            src_hash_short,
            function_id,
            len(inventory),
        )

    # 4d. Reconstruct the REDUCED fixed whole-file text from the kept hunks and
    #     validate THAT (not the LLM's whole-file output). The gates
    #     (violation_removal / semantic / regression) must judge the changes that
    #     will actually be accepted, so out-of-scope / prelude / cosmetic churn is
    #     excluded from validation input (D-022).
    reduced_fixed_code = _apply_hunks_to_processed(processed, original_hunks, prelude_line_count)
    fix_result.fixed_code = reduced_fixed_code

    # 5. Validation gates. Detect a usable compiler; when absent, skip the compile
    #    gate entirely (do NOT call run_compile_check, which raises on a missing
    #    binary) by disabling it for this validate_fix_result call.
    compile_probe = compile_runner(getattr(compile_config, "command", "gcc"))
    run_compile_gate = config.compile_enabled and compile_probe.available

    # 5a. Baseline (unrepaired) compile pre-check. Context-poor .c files (no
    #     external declarations) do not compile at all, so a candidate's compile
    #     failure would reflect the missing context, not the fix. When the gate
    #     would run, compile the UNMODIFIED processed text first; if it fails,
    #     skip the candidate compile gate (validation is not meaningful) and reuse
    #     the compiler-absent path (compile disabled for validate_fix_result).
    #
    #     Two-stage probe (task §5): a single .c whose ``#include "x.h"`` project
    #     headers are absent in this context stops at the include stage. We stub
    #     those local headers into a temp dir and re-probe — iteratively
    #     (``_iterative_stub_probe``: gcc stops at the FIRST missing include, so
    #     each round reveals only the next one); if the baseline then compiles,
    #     the compile gate is KEPT and runs with the SAME stub dir on ``-I`` —
    #     the stub is a scaffold so validation is meaningful. In this
    #     single-file design the missing declarations are the prelude's job (the
    #     confirmed context), so it is correct to judge the compile gate on the
    #     stub-included result rather than fail on absent header bodies. The stub
    #     dir lives until validation finishes, then is removed.
    baseline_compile_failed = False
    baseline_missing_symbols: List[str] = []
    baseline_stub_dir: Optional[str] = None
    validate_compile_config = compile_config
    if run_compile_gate:
        baseline = baseline_compile_runner(processed, compile_config)
        if not baseline.ok:
            missing_local = _extract_missing_local_headers(baseline.stderr, original_content)
            if missing_local:
                # Stub the missing local headers and re-probe (iteratively, shared
                # helper) against a config with the stub dir on -I. Keep the dir
                # for the compile gate below.
                baseline_stub_dir = tempfile.mkdtemp(prefix="cfx-stub-")
                baseline, stubbed, stub_config, _capped = _iterative_stub_probe(
                    processed=processed,
                    source=original_content,
                    compile_config=compile_config,
                    baseline_compile_runner=baseline_compile_runner,
                    stub_dir=baseline_stub_dir,
                    first_outcome=baseline,
                )
                validate_compile_config = stub_config
                logger.info(
                    "repair diagnostic: baseline stubbed missing local headers "
                    "src=%s function=%s stubbed=%d",
                    src_hash_short,
                    function_id,
                    len(stubbed),
                )
            if not baseline.ok:
                # Still failing after stubbing (or nothing to stub) -> the baseline
                # is genuinely uncompilable; skip the candidate compile gate.
                baseline_compile_failed = True
                baseline_missing_symbols = _extract_missing_symbols(baseline.stderr)
                run_compile_gate = False
                validate_compile_config = compile_config
                if baseline_stub_dir is not None:
                    shutil.rmtree(baseline_stub_dir, ignore_errors=True)
                    baseline_stub_dir = None
                logger.info(
                    "repair diagnostic: baseline (unrepaired) file does not compile "
                    "src=%s function=%s missing_symbols=%d",
                    src_hash_short,
                    function_id,
                    len(baseline_missing_symbols),
                )

    # 5b. Candidate compile gate — WHOLE-FILE (D-033): the translation unit is
    #     what must compile, so run the compile check on the reduced whole file
    #     directly (``baseline_compile_runner`` wraps certfix's
    #     ``run_compile_check`` and is the same injectable the baseline pre-check
    #     uses) with the same (stub-including) config the baseline established.
    candidate_compile: Optional[CompileOutcome] = None
    if run_compile_gate:
        candidate_compile = baseline_compile_runner(reduced_fixed_code, validate_compile_config)

    # 5b'. Deterministic missing standard-include completion. A recurring,
    #     model-independent failure (user sample11, deepseek + gpt-5.6): an
    #     INT32-C fix uses int64_t / INT_MAX without adding
    #     ``#include <stdint.h>`` / ``<limits.h>``, so the candidate compile gate
    #     fails with ``unknown type name 'int64_t'``. gcc names the missing header
    #     in a note (``'int64_t' is defined in header '<stdint.h>'``), so when the
    #     header is a well-known STANDARD C header we add the include
    #     deterministically (no LLM): parse the note -> allow-list filter ->
    #     insert one ``#include`` hunk after the last existing include ->
    #     rebuild the reduced file -> recompile ONCE. The insert is a global
    #     (file-level) hunk in Original coordinates, valid under D-022 because it
    #     rides a candidate that already changes the target function. Safety: the
    #     hunk anchors in the Original range (never the prelude — its coordinate is
    #     already Original) and must not overlap a kept hunk; on overlap the
    #     completion is abandoned (logged). On a still-failing recompile the added
    #     hunk is retained (the include is legitimately needed) and the gate reads
    #     fail as before.
    if candidate_compile is not None and not candidate_compile.ok:
        suggested = _extract_suggested_standard_includes(candidate_compile.stderr)
        if suggested:
            include_hunk = _build_include_completion_hunk(suggested, original_content)
            if include_hunk is not None and _include_hunk_overlaps(include_hunk, original_hunks):
                logger.info(
                    "repair diagnostic: auto-include completion abandoned (overlaps a "
                    "kept hunk) src=%s function=%s anchor=%d includes=%s",
                    src_hash_short,
                    function_id,
                    include_hunk.start_line,
                    ",".join(suggested),
                )
            elif include_hunk is not None:
                completed_hunks = [*original_hunks, include_hunk]
                completed_reduced = _apply_hunks_to_processed(
                    processed, completed_hunks, prelude_line_count
                )
                recompiled = baseline_compile_runner(completed_reduced, validate_compile_config)
                logger.info(
                    "repair diagnostic: auto-added missing standard include(s) %s -> "
                    "recompile %s src=%s function=%s",
                    ",".join(suggested),
                    "ok" if recompiled.ok else "still failing",
                    src_hash_short,
                    function_id,
                )
                # Keep the added include hunk whether or not the recompile passed:
                # the include is a real requirement of the fix, so the reviewer
                # should see it even on a still-failing candidate. Downstream (the
                # validation window, status) then reads the updated hunks/verdict.
                original_hunks = completed_hunks
                reduced_fixed_code = completed_reduced
                fix_result.fixed_code = reduced_fixed_code
                candidate_compile = recompiled

    # 5c. LLM gates on the validation WINDOW (D-033): certfix's semantic /
    #     violation_removal gates are single-function-scale; hand them the
    #     target-function ∪ kept-hunks window instead of the whole file. The
    #     window FixResult carries the same violation (rule_id) as the repair.
    #     ``compile_enabled=False``: with the format gate passing, certfix then
    #     treats compile as satisfied and still runs the LLM gates — the REAL
    #     compile verdict (whole-file, above) is merged into the validator after.
    #     When the whole-file compile FAILED, the backends are withheld so no
    #     LLM tokens are spent on a candidate that already cannot pass —
    #     validate_fix_result then produces exactly the same "prior gate failed"
    #     gate results certfix produced when its internal compile gate failed.
    #     Neighbour clipping (play.c): the window pad is clipped so it never
    #     enters another function's range — the inventory built at 1a supplies
    #     the boundaries. The window FixResult inherits ``fix_result.violation``
    #     unchanged: certfix's gates read only ``violation.rule_id`` (verified
    #     in fix_validator/validation — the line/column fields are never used),
    #     so no window-local remapping of the location is needed.
    window_original, window_fixed = _extract_validation_window(
        processed, original_hunks, prelude_line_count, target_fn, inventory
    )
    window_fix_result = CertfixFixResult(
        violation=fix_result.violation,
        original_code=window_original,
        fixed_code=window_fixed,
        success=True,
    )
    compile_gate_failed = candidate_compile is not None and not candidate_compile.ok
    gate_semantic_backend = None if compile_gate_failed else semantic_backend
    gate_violation_backend = None if compile_gate_failed else violation_backend
    # 12a (measurement): wrap the gate backends so each LLM call inside
    # validate_fix_result emits its own usage line (stage=semantic|removal) —
    # the adapter cannot instrument those calls from outside. The audit backend
    # is the semantic wrapper (an audit is a semantic-role call).
    if gate_semantic_backend is not None:
        gate_semantic_backend = _UsageLoggingBackend(
            gate_semantic_backend, "semantic", src_hash_short, function_id
        )
    if gate_violation_backend is not None:
        gate_violation_backend = _UsageLoggingBackend(
            gate_violation_backend, "removal", src_hash_short, function_id
        )
    logger.info(
        "repair diagnostic: validation window src=%s function=%s "
        "window_lines=%d/%d hunks=%d compile_gate_failed=%s",
        src_hash_short,
        function_id,
        len(window_original.split("\n")),
        len(processed.split("\n")),
        len(original_hunks),
        compile_gate_failed,
    )
    try:
        validate_fix_result(
            window_fix_result,
            compile_config=validate_compile_config,
            semantic_backend=gate_semantic_backend,
            semantic_max_tokens=config.semantic_max_tokens,
            violation_backend=gate_violation_backend,
            violation_audit_backend=gate_semantic_backend,
            compile_enabled=False,  # compile ran whole-file above (D-033)
            violation_removal_enabled=config.violation_removal_enabled,
            semantic_enabled=config.semantic_enabled,
            violation_removal_method=config.violation_removal_method,
            violation_removal_max_tokens=config.violation_removal_max_tokens,
            violation_removal_override_denylist=config.violation_removal_override_denylist,
        )
    except Exception as exc:  # noqa: BLE001 — LLM gate failure must not 500 (round 10)
        # A provider failure INSIDE a validation gate. certfix assigns results to
        # the FixResult only at the END of validate_fix_result, so a mid-gate
        # exception leaves no partial validator state to salvage — synthesizing
        # one would mean re-implementing build_validator_result over guessed
        # inputs (fragile coupling). Instead: KEEP the (expensive) hunks, mark
        # every gate skipped with a transient-provider detail, and return
        # validation_failed so the reviewer can still inspect the diff and
        # regenerate to re-validate. Cancellation (BaseException) propagates.
        _log_llm_failure("validation", exc)
        if baseline_stub_dir is not None:
            shutil.rmtree(baseline_stub_dir, ignore_errors=True)
            baseline_stub_dir = None
        return _candidate(
            status="validation_failed",
            explanation=_repair_explanation(rule_id, dropped, cosmetic, out_of_scope)
            + " (Validation could not run: provider error — usually transient.)",
            hunks=original_hunks,
            validations=[
                _Validation(name=gate, status="skipped", detail=_VALIDATION_PROVIDER_FAILURE_DETAIL)
                for gate in ("format", "compile", "violation_removal", "semantic", "regression")
            ],
        )
    finally:
        if baseline_stub_dir is not None:
            shutil.rmtree(baseline_stub_dir, ignore_errors=True)

    # Merge the real whole-file compile verdict into the windowed validator.
    # When the gate did not run (no compiler / disabled / baseline failed) the
    # windowed validator's synthetic compile_ok (== format_ok) matches the old
    # ``compile_enabled=False`` behaviour and _map_validations takes its
    # skipped branch anyway.
    validator = window_fix_result.validator_result
    if candidate_compile is not None:
        validator = dataclasses_replace(
            validator,
            compile_ok=candidate_compile.ok,
            compiler_stderr=candidate_compile.stderr,
            auto_apply_ok=validator.auto_apply_ok and candidate_compile.ok,
        )
    validations = _map_validations(
        validator,
        compile_probe=compile_probe,
        compile_enabled=config.compile_enabled,
        violation_removal_enabled=config.violation_removal_enabled,
        violation_backend_present=violation_backend is not None,
        semantic_enabled=config.semantic_enabled,
        semantic_backend_present=semantic_backend is not None,
        baseline_compile_failed=baseline_compile_failed,
        baseline_missing_symbols=baseline_missing_symbols,
        # D-023: certfix judgment-reason objects for the fail-detail wiring.
        semantic_result=window_fix_result.semantic_result,
        removal_result=window_fix_result.violation_removal_result,
    )

    # 5d. Round 21: a global-only candidate (no kept hunk touches the target
    #     function, flagged at 4c) is acceptable ONLY when the violation_removal
    #     gate positively PASSED — that pass is the evidence the global change
    #     actually removes the finding (DCL declaration-rule fixes). fail /
    #     skipped / not_run cannot confirm it -> repair_failed. (Pre-round-19,
    #     such candidates passed unverified; round 19 rejected them all; this
    #     is the calibrated middle.)
    if global_only:
        removal_status = next(
            (v.status for v in validations if v.name == "violation_removal"), "not_run"
        )
        if removal_status != "pass":
            logger.info(
                "repair diagnostic: candidate rejected (global-only, removal not "
                "confirmed) src=%s function=%s removal=%s hunks=%d",
                src_hash_short,
                function_id,
                removal_status,
                len(original_hunks),
            )
            return _candidate(
                status="repair_failed",
                explanation="The proposed fix made no change to the target function "
                "(all changes fell outside it and were discarded). The global-only "
                "change could not be verified to remove the violation.",
                hunks=[],
                validations=[],
            )
        logger.info(
            "repair diagnostic: global-only candidate allowed (removal=pass) "
            "src=%s function=%s hunks=%d",
            src_hash_short,
            function_id,
            len(original_hunks),
        )

    # 6. Status: hunks exist. auto_apply_ok -> repair_ready; else validation_failed
    #    (hunks retained for review). A compile-skipped candidate is NOT forced to
    #    fail: auto_apply_ok reflects only the gates that actually ran (we disabled
    #    the compile gate for validate_fix_result when the compiler is absent).
    explanation = _repair_explanation(rule_id, dropped, cosmetic, out_of_scope)
    if validator.auto_apply_ok:
        status = "repair_ready"
    else:
        status = "validation_failed"

    return _candidate(status=status, explanation=explanation, hunks=original_hunks, validations=validations)


def _repair_explanation(
    rule_id: Optional[str], dropped: int, cosmetic: int = 0, out_of_scope: int = 0
) -> str:
    base = (
        f"Proposed fix for {rule_id}." if rule_id else "Proposed fix for the reported finding."
    )
    if dropped:
        base += f" ({dropped} change(s) touching inferred context were discarded.)"
    if cosmetic:
        base += f" ({cosmetic} cosmetic change(s) were filtered out.)"
    if out_of_scope:
        base += f" ({out_of_scope} change(s) outside the target function were discarded.)"
    return base
