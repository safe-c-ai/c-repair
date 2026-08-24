"""FastAPI app for the CertFix scan service (PHASE3A_DESIGN.md §1, §2, §7).

Stop-line (§7):
- Bind localhost only (uvicorn --host 127.0.0.1). Do not expose 0.0.0.0.
- Never log source content; only hashes / line numbers.

CORS is restricted to the Vite dev origin (http://localhost:5173).
"""

from __future__ import annotations

import asyncio
import copy
import hmac
import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional, TypeVar

import certfix
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from repair_api import cancellation

logger = logging.getLogger(__name__)

# Bridge diagnostics (cancellations, dropped hunks, detection failures) are logged
# at INFO on repair_api.* loggers. Uvicorn's default config only emits WARNING+
# for non-uvicorn loggers, which silently swallows them — attach a stderr handler
# once so operators can actually see the (content-free) diagnostics.
_pkg_logger = logging.getLogger("repair_api")
if not _pkg_logger.handlers:
    _h = logging.StreamHandler()
    _h.setFormatter(logging.Formatter("[repair-api] %(levelname)s %(name)s: %(message)s"))
    _pkg_logger.addHandler(_h)
    _pkg_logger.setLevel(logging.INFO)
    _pkg_logger.propagate = False

# How often the disconnect monitor polls ``request.is_disconnected()`` while the
# sync repair/scan work runs in the threadpool (task A: ~1s cadence).
_DISCONNECT_POLL_S = 1.0

# Non-standard "Client Closed Request" status returned when a handler aborts after
# the client disconnected. The body is never delivered (the client is gone); we use
# a bare Response so FastAPI skips response_model validation on the aborted path.
_CLIENT_CLOSED_STATUS = 499

T = TypeVar("T")


def _cancelled_response() -> Response:
    """A minimal response for the aborted (client-disconnected) path.

    Returned instead of a ``response_model`` object so no schema-valid placeholder
    has to be fabricated; the client is gone, so the body is immaterial. Returning a
    ``Response`` from a handler short-circuits FastAPI's response_model validation.
    """
    return Response(status_code=_CLIENT_CLOSED_STATUS)

# Env var carrying the Bearer token (D-017d). When set at startup, all endpoints
# require ``Authorization: Bearer <token>``. When unset, the bridge runs without
# auth (dev mode: Web regression bench + pytest compatibility).
BRIDGE_TOKEN_ENV = "CREPAIR_BRIDGE_TOKEN"

from repair_api import __version__ as api_version
from repair_api import context as ctx
from repair_api import infer as infer_mod
from repair_api import usage_tracker
from repair_api.adapter import certfix_adapter, repair as repair_adapter
from repair_api.config_override import load_effective_config
from repair_api.schemas import (
    Capabilities,
    CheckRequest,
    CheckResponse,
    ConfirmRequest,
    ContextAugmentationSet,
    FunctionScanResult,
    HealthResponse,
    InferRequest,
    RepairCandidate,
    RepairRequest,
    ScanRequest,
)

# Contract version this bridge speaks (CONTRACT.md §1). Consumers (VS Code
# extension) use it for compatibility checks. Bump on breaking schema changes.
CONTRACT_VERSION = "1"

# Validation gates the harness exposes, in pipeline order (VSCODE_PIVOT_PLAN §2).
HARNESS_GATES = ["format", "compile", "violation_removal", "semantic", "regression"]

# Distribution profile routes (API route only; Docker / llama-server omitted).
HARNESS_ROUTES = ["api"]

# Bundled config: use the copy under this service, never a certfix-dev path.
_CONFIG_FILENAME = "deepseek-v4-flash-openrouter.yaml"


def resolve_bundled_config(dev_candidate: Path, packaged_candidate: "Path | None") -> Path:
    """Pick the bundled config path (V3b round 23): dev tree first, then wheel.

    - ``dev_candidate`` (``services/repair-api/config/…`` relative to this
      file) wins when it exists — the monorepo dev layout, unchanged.
    - Otherwise the wheel's packaged copy (``repair_api/config/…`` via
      importlib resources) — the vsix bootstrap venv layout, where the old
      dev-relative resolution degenerated to ``lib/python3.10/config/…`` and
      /health silently reported an empty model.
    - Neither existing is a broken installation: logged as ERROR at startup
      (no more silent empty model), while /health itself stays 200 with the
      empty capabilities visible so the extension handshake can detect it.

    Injectable candidates so the three branches are unit tested with tmp paths.
    """
    if dev_candidate.exists():
        return dev_candidate
    if packaged_candidate is not None and packaged_candidate.exists():
        return packaged_candidate
    logger.error(
        "bundled config not found: neither the dev tree (%s) nor the repair_api "
        "package resources carry %s. Model capabilities will be empty until "
        "CREPAIR_CONFIG_PATH points at a valid config or the package is "
        "reinstalled.",
        dev_candidate,
        _CONFIG_FILENAME,
    )
    return dev_candidate


def _packaged_config_candidate() -> "Path | None":
    """The wheel's packaged config path, or None when unavailable."""
    try:
        from importlib.resources import files

        return Path(str(files("repair_api") / "config" / _CONFIG_FILENAME))
    except Exception:  # noqa: BLE001 — resolution must never break startup
        return None


CONFIG_PATH = resolve_bundled_config(
    Path(__file__).resolve().parents[2] / "config" / _CONFIG_FILENAME,
    _packaged_config_candidate(),
)

# Type of a zero-arg factory producing a CertFix detection backend.
BackendFactory = Callable[[], object]


@dataclass
class RepairDeps:
    """The dependencies the repair path needs, built from the bundled config.

    ``backend`` is the fix-role InferenceBackend; ``semantic_backend`` /
    ``violation_backend`` are validation backends (may reuse ``backend``);
    ``config`` is the extracted RepairConfig. Assembled lazily so /health and
    unit tests never require an API key.

    ``infer_backend`` is the ``/context/infer`` backend: the fix role cloned
    with ``extra_body.reasoning = {enabled: false}`` (D-029-parallel — see
    ``_default_repair_factory``). ``None`` means "use ``backend``" (the
    endpoint falls back), so tests and older factories keep working unchanged.
    """

    backend: object
    config: object  # repair_adapter.RepairConfig
    semantic_backend: Optional[object] = None
    violation_backend: Optional[object] = None
    infer_backend: Optional[object] = None


# Type of a zero-arg factory producing the repair dependencies.
RepairFactory = Callable[[], "RepairDeps"]


def _default_backend_factory() -> object:
    """Build the real CertFix detection backend from the effective config (D-019).

    Imported lazily and only invoked on /scan, so /health and unit tests do not
    require an API key. ``load_effective_config`` applies any ``CREPAIR_*`` env
    overrides on top of the bundled config; with none set it is bit-identical to
    ``Config.load(CONFIG_PATH)``.
    """
    from certfix.inference.factory import create_detection_backend

    cfg = load_effective_config(CONFIG_PATH).config
    return create_detection_backend(cfg)


def _default_repair_factory() -> "RepairDeps":
    """Build the fix-role backend + validation backends from the effective config.

    Imported lazily and only invoked on /repair, so /health and unit tests do not
    require an API key. ``load_effective_config`` applies any ``CREPAIR_*`` env
    overrides (D-019). The compile gate runs locally only if a compiler is present
    (recorded ``skipped`` otherwise).

    Backend wiring (roles differ by required prompt profile):

    - ``backend`` (fix role): text generation via ``generate`` — profile
      ``models.<fix role>.profile`` (e.g. ``deepseek_v4_flash``). Used for the
      repair itself and, because the semantic gate also only calls ``generate``,
      reused as the ``semantic_backend``.
    - ``violation_backend`` (violation-removal re-scan): calls ``detect``, which
      resolves the **detection** prompt profile. The fix-role profile is NOT a
      detection profile, so reusing the fix backend here raised
      ``Unknown prompt profile`` and failed every removal re-scan chunk. It must
      therefore be a detection backend (``create_detection_backend``), which
      carries ``detection.prompt_profile`` (``qwen36_certfix_check_v1``) and takes
      the two-stage detect path. ``load_effective_config`` is honoured so any
      model / provider override applies here too.
    - ``infer_backend`` (``/context/infer``): the fix role cloned with
      ``extra_body.reasoning`` REPLACED by ``{enabled: false}``. Same rationale
      as D-029 (detection): infer is a structured-output task (labelled fenced
      declaration blocks), and with reasoning enabled some free-pool providers
      (nemotron observed on lua-lapi/lua-lgc) write the CoT into ``content``,
      exhausting the 4096-token infer budget before any declaration is emitted
      (0 items, strict parse empty, response tail mid-thought). The reasoning
      block is replaced AFTER ``load_effective_config``, so
      ``CREPAIR_REASONING_EFFORT`` / config_override keep applying to the FIX
      role only and never to infer (mirrors detection's treatment).
    """
    from certfix.inference.factory import create_detection_backend, create_role_backend

    cfg = load_effective_config(CONFIG_PATH).config

    role_name = cfg.fix.simple_repairer_role or cfg.validation.semantic.reviewer_role
    role = cfg.models.get(role_name)
    if role is None:
        raise RuntimeError(f"fix role is not configured: {role_name!r}")

    # D-034: convert the FINAL fix role's `reasoning: {effort: X}` (after any
    # CREPAIR_REASONING_EFFORT / config_override application) into an explicit
    # `reasoning: {max_tokens: CAP[X]}` before anything reads it. Effort-style
    # reasoning adapts to the whole completion budget and starves the content on
    # large-file repairs (measured 3/3 finish=length, reasoning 47k/87k/58k); an
    # explicit cap is honored. Done BEFORE from_certfix_config so
    # `fix_extra_body` (the budget's reasoning-allowance source) and the backend
    # both carry the converted form. Off / explicit max_tokens / detection /
    # infer are untouched.
    role.api.extra_body = repair_adapter.reasoning_effort_to_cap(role.api.extra_body)

    repair_config = repair_adapter.RepairConfig.from_certfix_config(cfg)
    backend = create_role_backend(role)

    # /context/infer backend: fix role with reasoning wholly disabled (see
    # docstring). Deep-copied so the shared config object is never mutated.
    infer_role = copy.deepcopy(role)
    infer_extra = dict(getattr(infer_role.api, "extra_body", {}) or {})
    infer_extra["reasoning"] = {"enabled": False}
    infer_role.api.extra_body = infer_extra
    infer_backend = create_role_backend(infer_role)

    # Semantic gate only calls ``generate`` (no prompt-profile resolution), so the
    # fix backend is safe to reuse for it.
    semantic_backend = backend if repair_config.semantic_enabled else None
    # Violation-removal re-scan calls ``detect`` -> a detection-profile backend is
    # required (see docstring). Built from the effective config so overrides apply.
    violation_backend = (
        create_detection_backend(cfg) if repair_config.violation_removal_enabled else None
    )
    return RepairDeps(
        backend=backend,
        config=repair_config,
        semantic_backend=semantic_backend,
        violation_backend=violation_backend,
        infer_backend=infer_backend,
    )


async def _run_cancellable(
    request: Request,
    endpoint: str,
    work: Callable[[], T],
) -> T:
    """Run a sync handler in the threadpool while watching for a client disconnect.

    Task A (orphaned-spend guard): long LLM generations must stop when the client
    goes away. We publish a per-request :class:`CancelToken` on the cancellation
    contextvar, then run ``work`` via ``run_in_threadpool`` — anyio copies the
    current context into the worker thread, so the token reaches the ``httpx.Client``
    send-wrap running there. Concurrently we poll ``request.is_disconnected()`` every
    ~1s; on disconnect we cancel the token, which force-closes the in-flight client
    and makes the next send raise :class:`RequestCancelled` (a ``BaseException`` that
    bypasses certfix's retry / per-chunk catches).

    On a normal completion the token result is returned. On cancellation (client
    gone) we log one content-free diagnostic line (endpoint + ``aborted``) and
    re-raise ``RequestCancelled`` for the endpoint to swallow — the client is no
    longer listening, so the response body is immaterial and we avoid polluting the
    logs with a 500.
    """
    token = cancellation.CancelToken()
    # Publish the token on THIS task's context so the copied context handed to the
    # worker thread carries it. run_in_threadpool copies the context at call time.
    cancellation.set_current_token(token)

    async def _monitor() -> None:
        # Poll for disconnect until cancelled by the finally below. ``is_disconnected``
        # returns True once the ASGI receive channel reports http.disconnect.
        try:
            while True:
                if await request.is_disconnected():
                    token.cancel()
                    return
                await asyncio.sleep(_DISCONNECT_POLL_S)
        except asyncio.CancelledError:  # normal completion path cancels the monitor
            raise

    monitor_task = asyncio.ensure_future(_monitor())
    try:
        return await run_in_threadpool(work)
    except cancellation.RequestCancelled:
        # Client disconnected mid-flight; the LLM call was aborted. One numbers-only
        # diagnostic line (no source content), then re-raise for the endpoint to
        # handle quietly.
        logger.info("request aborted (client disconnected): endpoint=%s", endpoint)
        raise
    finally:
        monitor_task.cancel()
        # Await so the monitor task is fully torn down (and any exception consumed)
        # before the request context unwinds.
        try:
            await monitor_task
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass


def create_app(
    backend_factory: Optional[BackendFactory] = None,
    bridge_token: Optional[str] = None,
    repair_factory: Optional[RepairFactory] = None,
) -> FastAPI:
    """Create the FastAPI app.

    Args:
        backend_factory: Optional zero-arg factory returning a CertFix
            InferenceBackend. Injected in tests with a fake; defaults to the real
            API backend built from the bundled config.
        repair_factory: Optional zero-arg factory returning the repair
            dependencies (fix backend + validation backends + RepairConfig).
            Injected in tests with fakes; defaults to backends built from the
            bundled config.
        bridge_token: Optional Bearer token (D-017d). When None, read from the
            ``CREPAIR_BRIDGE_TOKEN`` env var at app-creation time. When the
            resolved value is a non-empty string, every request must carry
            ``Authorization: Bearer <token>``; otherwise the bridge is
            unauthenticated (dev mode for the Web regression bench / pytest).
            The token value is never logged.
    """
    factory: BackendFactory = backend_factory or _default_backend_factory
    repair_deps_factory: RepairFactory = repair_factory or _default_repair_factory

    token = bridge_token if bridge_token is not None else os.environ.get(BRIDGE_TOKEN_ENV)
    # Treat empty / whitespace-only as "unset" (env vars can be exported empty).
    token = token.strip() if isinstance(token, str) else None
    auth_required = bool(token)

    app = FastAPI(title="c-repair repair-api", version=api_version)

    # D-030: meter OpenRouter token usage by wrapping httpx.Client.send at runtime.
    # Idempotent + best-effort: a wrap failure only disables metering (warning-logged),
    # so the bridge stays fully functional. certfix's code is never modified.
    usage_tracker.install()

    if auth_required:

        @app.middleware("http")
        async def _require_bearer(request: Request, call_next):
            header = request.headers.get("authorization", "")
            expected = f"Bearer {token}"
            # Constant-time comparison; never log the header or token value.
            if not hmac.compare_digest(header, expected):
                return JSONResponse(
                    status_code=401,
                    content={"detail": "missing or invalid bearer token"},
                )
            return await call_next(request)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173"],
        allow_credentials=False,
        allow_methods=["GET", "POST"],
        allow_headers=["*"],
    )

    @app.get("/health", response_model=HealthResponse)
    def health() -> HealthResponse:
        # Effective model / provider (D-019): read the config (bundled or the
        # CREPAIR_CONFIG_PATH escape hatch) + apply CREPAIR_* env overrides. This
        # only parses YAML and reads env — no API key required.
        effective = load_effective_config(CONFIG_PATH)
        return HealthResponse(
            status="ok",
            harness={"id": "certfix", "version": certfix.__version__},
            adapter={"id": certfix_adapter.ADAPTER_ID, "version": certfix_adapter.ADAPTER_VERSION},
            contract_version=CONTRACT_VERSION,
            capabilities=Capabilities(
                rule_profile=certfix_adapter.RULE_PROFILE_ID,
                rules_count=certfix_adapter.rules_count(),
                gates=HARNESS_GATES,
                routes=HARNESS_ROUTES,
                model=effective.model,
                provider_order=effective.provider_order,
                reasoning_effort=effective.reasoning_effort,
                detection_reasoning=effective.detection_reasoning,
                provider_policy=effective.provider_policy,
                # D-039 legal kill-switch: report whether rule titles are surfaced
                # in responses. Read straight from the env (not a Config concern).
                rule_titles="on" if certfix_adapter.rule_titles_enabled() else "off",
            ),
        )

    @app.get("/usage")
    def usage() -> dict:
        # D-030: cumulative OpenRouter token usage since the last reset (numbers only;
        # no prompt / response content is ever recorded). Runs under the same Bearer
        # middleware as every other route when auth is enabled.
        return usage_tracker.tracker.snapshot()

    @app.post("/usage/reset")
    def usage_reset() -> dict:
        # D-030: zero the counters (called by the extension at each scan start).
        usage_tracker.tracker.reset()
        return usage_tracker.tracker.snapshot()

    @app.post("/context/infer", response_model=ContextAugmentationSet)
    async def context_infer(req: InferRequest, request: Request) -> ContextAugmentationSet:
        # V2a (design §1): compile-probe the prelude-less Original, infer minimal
        # declarations for the still-missing external symbols via the infer
        # backend (the fix role with reasoning disabled — D-029-parallel; falls
        # back to the fix backend when the factory provides none, e.g. tests),
        # and return a DRAFT set (items unconfirmed, revision null). With
        # no compiler / no missing symbols this degrades to an empty draft (the
        # prior placeholder behaviour), so self-contained files are unaffected.
        #
        # Async + threadpool (task A): infer makes an LLM call, so it runs under the
        # disconnect monitor — a client that goes away aborts the in-flight call.
        src = req.source_document

        def _work() -> ContextAugmentationSet:
            deps = repair_deps_factory()
            result = infer_mod.run_infer(
                backend=deps.infer_backend or deps.backend,
                compile_config=deps.config.compile_config,
                original_content=src.content,
                filename=src.filename,
                compile_enabled=deps.config.compile_enabled,
                compile_include_paths=req.compile_include_paths,
            )
            return ContextAugmentationSet(
                set_id="augset-" + src.source_id,
                source_id=src.source_id,
                original_hash=src.content_hash,
                status="draft",
                context_revision_id=None,
                prelude_line_count=result.prelude_line_count,
                items=result.items,
            )

        try:
            return await _run_cancellable(request, "/context/infer", _work)
        except cancellation.RequestCancelled:
            return _cancelled_response()  # client gone; body immaterial

    @app.post("/context/check", response_model=CheckResponse)
    def context_check(req: CheckRequest) -> CheckResponse:
        # V2a (design §1): compose the Augmented C from the supplied set + Original
        # and compile-probe it, so the Review UI can show "context compiles ✓ /
        # still missing: X". The set need NOT be confirmed (this is a pre-confirm
        # probe), but its original_hash must match the source (same 409 family as
        # /scan) so we never probe a stale pairing.
        src = req.source_document
        aug = req.context_augmentation_set
        if aug.original_hash != src.content_hash:
            raise HTTPException(
                status_code=409,
                detail="context_augmentation_set.original_hash does not match source content_hash",
            )
        deps = repair_deps_factory()
        result = infer_mod.run_check(
            compile_config=deps.config.compile_config,
            original_content=src.content,
            items=aug.items,
            compile_enabled=deps.config.compile_enabled,
            compile_include_paths=req.compile_include_paths,
        )
        return CheckResponse(
            compiles=result.compiles,
            missing_symbols=result.missing_symbols,
            stubbed_headers=result.stubbed_headers,
        )

    @app.post("/context/confirm", response_model=ContextAugmentationSet)
    def context_confirm(req: ConfirmRequest) -> ContextAugmentationSet:
        # Issue a revision but RESPECT items[].confirmed as the client set it
        # (D-020): a Review-confirmed set arrives with all items confirmed=true;
        # a Skip-review set keeps items confirmed=false. The bridge never
        # overrides these, so unconfirmed items stay assumption-dependent (§2).
        s = req.context_augmentation_set
        revision = ctx.compute_revision_id(s.original_hash, s.items)
        return ContextAugmentationSet(
            set_id=s.set_id,
            source_id=s.source_id,
            original_hash=s.original_hash,
            status="confirmed",
            context_revision_id=revision,
            prelude_line_count=s.prelude_line_count,
            items=s.items,
        )

    @app.post("/scan", response_model=FunctionScanResult)
    async def scan(req: ScanRequest, request: Request) -> FunctionScanResult:
        # ``req.compile_include_paths`` (D-020) is accepted for request symmetry but
        # IGNORED here: scanning does not run the compile gate. Only /repair applies
        # it (baseline pre-check + candidate compile gate). Present for future use.
        src = req.source_document
        aug = req.context_augmentation_set

        # Validation (§2): set must be confirmed and original_hash must match. Runs
        # inline (no LLM) so a bad request still returns its 409 before any work.
        if aug.status != "confirmed" or aug.context_revision_id is None:
            raise HTTPException(
                status_code=409,
                detail="context_augmentation_set must be confirmed before scan",
            )
        if aug.original_hash != src.content_hash:
            raise HTTPException(
                status_code=409,
                detail="context_augmentation_set.original_hash does not match source content_hash",
            )

        # Async + threadpool (task A): the scan drives LLM detection per function, so
        # it runs under the disconnect monitor (a disconnect aborts the in-flight call).
        def _work() -> FunctionScanResult:
            backend = factory()
            result = certfix_adapter.run_scan(
                backend=backend,
                source_id=src.source_id,
                original_content=src.content,
                original_hash=src.content_hash,
                context_revision_id=aug.context_revision_id,
                items=aug.items,
                prelude_line_count=aug.prelude_line_count,
            )
            return FunctionScanResult.model_validate(result)

        try:
            return await _run_cancellable(request, "/scan", _work)
        except cancellation.RequestCancelled:
            return _cancelled_response()  # client gone; body immaterial

    # ``response_model_exclude_none`` drops optional ``detail`` (and
    # ``model_identity``) when absent so the JSON matches the schema, which
    # requires ``detail`` to be a string when present (never ``null``).
    @app.post("/repair", response_model=RepairCandidate, response_model_exclude_none=True)
    async def repair(req: RepairRequest, request: Request) -> RepairCandidate:
        src = req.source_document
        aug = req.context_augmentation_set
        finding = req.finding

        # Validation: confirmed set + hash match (same 409 family as /scan). Runs
        # inline (no LLM) so a bad request still returns its 409 / 422 before any work.
        if aug.status != "confirmed" or aug.context_revision_id is None:
            raise HTTPException(
                status_code=409,
                detail="context_augmentation_set must be confirmed before repair",
            )
        if aug.original_hash != src.content_hash:
            raise HTTPException(
                status_code=409,
                detail="context_augmentation_set.original_hash does not match source content_hash",
            )
        # Only violation findings are repairable (uncertain findings are not).
        if finding.kind != "violation":
            raise HTTPException(
                status_code=422,
                detail="repair is only defined for a finding of kind 'violation'",
            )

        # Async + threadpool (task A): repair is the slowest path (LLM generation +
        # validation gates), so on big files it runs for minutes — exactly the case a
        # client disconnect must abort to stop orphaned spend. Runs under the monitor.
        def _work() -> RepairCandidate:
            deps = repair_deps_factory()
            result = repair_adapter.run_repair(
                backend=deps.backend,
                config=deps.config,
                finding=finding.model_dump(),
                function_id=req.function_id,
                source_id=src.source_id,
                original_content=src.content,
                original_hash=src.content_hash,
                context_revision_id=aug.context_revision_id,
                items=aug.items,
                prelude_line_count=aug.prelude_line_count,
                semantic_backend=deps.semantic_backend,
                violation_backend=deps.violation_backend,
                compile_include_paths=req.compile_include_paths,
                # Round 16: the window path's finish=length re-draw runs on a
                # REASONING-OFF backend. The infer backend IS that construction
                # (the fix role cloned with reasoning {enabled: false}, D-029
                # family), so it is reused rather than building a second
                # identical clone. None (older test factories) -> same-backend
                # re-draw (round-15 behaviour).
                redraw_backend=deps.infer_backend,
            )
            return RepairCandidate.model_validate(result)

        try:
            return await _run_cancellable(request, "/repair", _work)
        except cancellation.RequestCancelled:
            return _cancelled_response()  # client gone; body immaterial

    return app


# Module-level app for `uvicorn repair_api.main:app`.
app = create_app()
