"""Runtime instrumentation of the httpx layer to meter OpenRouter token usage (D-030).

certfix does not expose the LLM response ``usage`` block, so the bridge measures it
itself by wrapping ``httpx.Client.send`` at runtime. Both certfix's ``httpx.Client``
path (``ApiBackend`` builds a ``Client`` and calls ``.post`` -> ``.send``) and the
module-level ``httpx.post`` helper (which funnels through a temporary ``Client`` ->
``.send``) pass through this one seam, so every request/response is observed WITHOUT
touching certfix's code.

Stop-line (main.py §7 / D-030):
- Only NUMBERS are recorded: prompt / completion / reasoning tokens + a request count.
- The response body and the prompt are NEVER stored or logged. We read the ``usage``
  numbers from the JSON and discard everything else.
- Parsing is fully defensive: any missing field is 0, any parse failure is ignored,
  and any non-OpenRouter / streaming / non-JSON response is skipped. A wrap failure
  disables metering entirely (warning-logged) and leaves the bridge fully functional.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field
from typing import Any, Optional

from repair_api import cancellation

logger = logging.getLogger(__name__)


# --- finish_reason recorder (truncation-honesty, task §2) -------------------
#
# The repair path needs to know whether the model's most recent completion was
# cut off by the token budget (``finish_reason == "length"``) so it can tell the
# user the output was truncated instead of the generic "no fix produced". certfix
# discards the response ``finish_reason``, but the httpx send-wrap below already
# parses the full response body, so it is the natural (and only) seam to capture
# it WITHOUT touching certfix's code.
#
# Concurrency (task §2 note): the recorder is **thread-local**. A single repair
# request drives all its LLM calls (detect / repair / validation) on one worker
# thread (FastAPI runs sync endpoints in a threadpool, one thread per request),
# so a thread-local ``finish_reason`` can never be crossed with a *concurrent*
# request's value. The read protocol is: reset() before the repair call, then
# last() after — so we read the finish_reason of the last completion this thread
# produced, and nothing else. Value-only: the reason string is stored, never the
# body or prompt (mirrors the numbers-only stop-line for usage).
_finish_reason_state = threading.local()

# finish_reason values that mean the completion was cut off by the token budget
# (as opposed to a natural "stop" / tool-call / content-filter stop). OpenRouter
# and OpenAI-compatible providers both emit "length"; some providers emit
# "max_tokens" for the same condition, so we treat both as truncation.
_TRUNCATION_FINISH_REASONS = frozenset({"length", "max_tokens"})


def reset_finish_reason() -> None:
    """Clear this thread's recorded finish_reason (call before an LLM step)."""
    _finish_reason_state.value = None


def last_finish_reason() -> Optional[str]:
    """Return this thread's most-recently recorded finish_reason (or None)."""
    return getattr(_finish_reason_state, "value", None)


def _record_finish_reason(value: Optional[str]) -> None:
    """Store ``value`` as this thread's most-recent finish_reason (value only)."""
    _finish_reason_state.value = value


def is_truncation_finish_reason(value: Optional[str]) -> bool:
    """Whether ``value`` denotes a token-budget truncation (``length``)."""
    return isinstance(value, str) and value.lower() in _TRUNCATION_FINISH_REASONS


def _extract_finish_reason(data: Any) -> Optional[str]:
    """Pull ``choices[0].finish_reason`` from a chat-completions body, defensively.

    Returns the reason string when present and non-empty, else ``None``. Never
    raises: any missing / malformed field yields ``None``.
    """
    try:
        choices = data.get("choices") if isinstance(data, dict) else None
        if not isinstance(choices, list) or not choices:
            return None
        first = choices[0]
        reason = first.get("finish_reason") if isinstance(first, dict) else None
        if isinstance(reason, str) and reason:
            return reason
    except Exception:  # noqa: BLE001 — instrumentation must never break a request
        return None
    return None

# The host + path substring that identify an OpenRouter chat-completions call. We
# match by host suffix (openrouter.ai) + a "/chat/completions" path fragment so the
# default OpenRouter routing and any base-path prefix are both covered, while local /
# other providers are ignored.
_OPENROUTER_HOST = "openrouter.ai"
_CHAT_COMPLETIONS_PATH = "/chat/completions"

# Marks ``httpx.Client.send`` as already wrapped so install() is idempotent even if
# called more than once (e.g. app re-creation in tests).
_WRAP_MARKER = "_crepair_usage_wrapped"


@dataclass
class UsageTotals:
    """Cumulative token usage since the last reset. Numbers only (D-030)."""

    prompt_tokens: int = 0
    completion_tokens: int = 0
    reasoning_tokens: int = 0
    requests: int = 0


@dataclass
class UsageTracker:
    """Thread-safe accumulator for OpenRouter token usage.

    A single module-level instance backs the bridge's ``GET /usage`` /
    ``POST /usage/reset`` endpoints. ``add_from_response_json`` is called from the
    ``httpx.Client.send`` wrapper for every observed OpenRouter response; it never
    raises (defensive), so instrumentation can never break a real request.
    """

    _totals: UsageTotals = field(default_factory=UsageTotals)
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def snapshot(self) -> dict[str, int]:
        """Return the current cumulative totals as a plain dict."""
        with self._lock:
            return {
                "prompt_tokens": self._totals.prompt_tokens,
                "completion_tokens": self._totals.completion_tokens,
                "reasoning_tokens": self._totals.reasoning_tokens,
                "requests": self._totals.requests,
            }

    def reset(self) -> None:
        """Zero all counters (POST /usage/reset)."""
        with self._lock:
            self._totals = UsageTotals()

    def add_from_response_json(self, data: Any) -> None:
        """Defensively add the ``usage`` numbers from one response body.

        Counts the request unconditionally (an OpenRouter chat call was made), then
        adds prompt / completion / reasoning tokens when present and integer-typed.
        Missing fields count as 0; a malformed body simply contributes no tokens.
        Never raises.
        """
        prompt = 0
        completion = 0
        reasoning = 0
        try:
            usage = data.get("usage") if isinstance(data, dict) else None
            if isinstance(usage, dict):
                prompt = _coerce_int(usage.get("prompt_tokens"))
                completion = _coerce_int(usage.get("completion_tokens"))
                details = usage.get("completion_tokens_details")
                if isinstance(details, dict):
                    reasoning = _coerce_int(details.get("reasoning_tokens"))
        except Exception:  # noqa: BLE001 — instrumentation must never break a request
            # Parsing failed after we already know a request happened; count the
            # request but no tokens.
            pass
        with self._lock:
            self._totals.requests += 1
            self._totals.prompt_tokens += prompt
            self._totals.completion_tokens += completion
            self._totals.reasoning_tokens += reasoning


def _coerce_int(value: Any) -> int:
    """Return ``value`` as a non-negative int, or 0 when missing / not an int.

    Booleans are ints in Python but never a valid token count, so they are rejected.
    """
    if isinstance(value, bool):
        return 0
    if isinstance(value, int) and value >= 0:
        return value
    return 0


# The single tracker instance the endpoints and the wrapper share.
tracker = UsageTracker()


def _is_openrouter_chat_completion(request: Any) -> bool:
    """Whether an httpx request targets OpenRouter's chat-completions endpoint."""
    try:
        url = request.url
        host = (url.host or "").lower()
        path = url.path or ""
    except Exception:  # noqa: BLE001
        return False
    host_ok = host == _OPENROUTER_HOST or host.endswith("." + _OPENROUTER_HOST)
    return host_ok and _CHAT_COMPLETIONS_PATH in path


def _is_json_non_streaming(response: Any, stream: bool) -> bool:
    """Whether the response is a fully-read JSON body safe to parse.

    We skip ``stream=True`` sends (the body is not yet available and reading it would
    change certfix's behaviour) and anything that does not advertise a JSON
    content-type.
    """
    if stream:
        return False
    try:
        content_type = response.headers.get("content-type", "")
    except Exception:  # noqa: BLE001
        return False
    return "application/json" in content_type.lower()


def _record_from_send(request: Any, response: Any, stream: bool) -> None:
    """Meter one send() result. Best-effort; never raises into the caller.

    Besides the token totals, records this thread's most-recent ``finish_reason``
    (task §2) so the repair path can distinguish a token-budget truncation from a
    genuine "no fix" — value only, never the body or prompt.
    """
    try:
        if not _is_openrouter_chat_completion(request):
            return
        if not _is_json_non_streaming(response, stream):
            return
        data = response.json()
    except Exception:  # noqa: BLE001 — parsing / body access failure: ignore silently
        return
    tracker.add_from_response_json(data)
    _record_finish_reason(_extract_finish_reason(data))


def install(target: Optional[Any] = None) -> bool:
    """Wrap ``httpx.Client.send`` so OpenRouter usage is metered (idempotent).

    Called once at app startup. Returns True when metering is active (already wrapped
    counts as success), False when wrapping failed (a warning is logged and the bridge
    keeps working with metering disabled). ``target`` is the class to patch, defaulting
    to ``httpx.Client``; injectable in tests.
    """
    try:
        if target is None:
            import httpx

            target = httpx.Client

        original = getattr(target, "send", None)
        if original is None:
            logger.warning("usage metering disabled: httpx.Client has no send()")
            return False
        if getattr(original, _WRAP_MARKER, False):
            return True  # already installed (idempotent)

        def send_wrapper(self, request, *args, **kwargs):  # type: ignore[no-untyped-def]
            # ``stream`` is a keyword-only arg of Client.send (default False). A
            # streaming send hands back an unread body, so we must not touch it.
            stream = bool(kwargs.get("stream", False))
            # Cancellation propagation: before issuing the request, honour a
            # client-disconnect that has already fired (raise before spending), and
            # register this Client so an in-flight disconnect can force-close it and
            # abort a send blocked in the OS read. RequestCancelled is a
            # BaseException, so it bypasses certfix's retry / per-chunk catches and
            # propagates to the endpoint handler. The token is read from the copied
            # request context (set by the async endpoint before run_in_threadpool);
            # it is None for non-cancellable paths, where this is a no-op.
            token = cancellation.get_current_token()
            if token is not None:
                token.raise_if_cancelled()
                token.register(self)
            try:
                response = original(self, request, *args, **kwargs)
            finally:
                if token is not None:
                    token.unregister(self)
            _record_from_send(request, response, stream)
            return response

        setattr(send_wrapper, _WRAP_MARKER, True)
        target.send = send_wrapper  # type: ignore[assignment]
        return True
    except Exception as exc:  # noqa: BLE001 — never let instrumentation break startup
        logger.warning("usage metering disabled: could not wrap httpx.Client.send (%s)", exc)
        return False
