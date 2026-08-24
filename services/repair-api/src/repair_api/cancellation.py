"""Per-request cancellation for the bridge (client-disconnect propagation).

Large-file repairs on the -0731 model (max_completion_tokens 384k) can run for
minutes to tens of minutes. If the VS Code client disconnects or the user cancels,
the bridge's in-flight LLM call must be aborted — otherwise generation continues
and keeps billing after nobody is listening (orphaned spend).

Mechanism
---------
- A :class:`CancelToken` is created per request and published on a **contextvar**
  (``_current_token``). The endpoint sets it, then runs the sync repair/scan work
  via Starlette's ``run_in_threadpool``. anyio copies the current context into the
  worker thread (``copy_context()``), so the contextvar — and thus the token — is
  visible to the ``httpx.Client.send`` wrapper running in that worker thread. This
  is the same propagation the finish_reason recorder relies on.
- While the sync work runs, the async endpoint concurrently polls
  ``request.is_disconnected()`` (~1s). On disconnect it calls
  :meth:`CancelToken.cancel`, which (a) sets the event so the next ``send`` raises,
  and (b) force-closes every currently-registered in-flight httpx ``Client`` so a
  ``send`` already blocked in the OS read is aborted immediately rather than after
  the (possibly 30-minute) socket timeout.

Retry avoidance
---------------
The abort is signalled by raising :class:`RequestCancelled`, which derives from
``BaseException`` (NOT ``Exception``). certfix's API retry loop only catches
``httpx.HTTPError``; its per-chunk detection/fix loops catch ``Exception``. A
``BaseException`` slips past all three and propagates straight to the endpoint
handler, so the cancellation is neither retried nor swallowed-and-continued (which
would re-issue LLM calls chunk after chunk). The handler catches it and returns
quietly — the client is already gone.

Thread-safety
-------------
The token's event + registered-client set are guarded by a lock. ``cancel`` may
run on the event loop thread while ``register``/``unregister``/``raise_if_cancelled``
run on the worker thread; all mutation goes through the lock. Closing a client is
best-effort and never raises into either side.
"""

from __future__ import annotations

import contextvars
import logging
import threading
from typing import Any, Optional

logger = logging.getLogger(__name__)


class RequestCancelled(BaseException):
    """Raised inside the worker thread when the request was cancelled.

    Derives from ``BaseException`` (not ``Exception``) on purpose: it must bypass
    certfix's ``except httpx.HTTPError`` retry AND its ``except Exception`` per-chunk
    catches so the abort propagates straight to the endpoint handler instead of
    being retried or swallowed (see module docstring).
    """


class CancelToken:
    """A per-request cancellation flag + registry of in-flight httpx clients.

    Set once per request and published on the ``_current_token`` contextvar. The
    send-wrap consults it (``raise_if_cancelled``) before each send and registers
    the live client for the duration of the send so a disconnect can force-close it.
    """

    __slots__ = ("_event", "_lock", "_clients")

    def __init__(self) -> None:
        self._event = threading.Event()
        self._lock = threading.Lock()
        # Identity set of httpx.Client objects currently inside a send() call.
        self._clients: set[Any] = set()

    @property
    def cancelled(self) -> bool:
        """Whether this request has been cancelled."""
        return self._event.is_set()

    def cancel(self) -> None:
        """Mark cancelled and force-close every in-flight client (idempotent).

        Setting the event makes the next ``raise_if_cancelled`` raise; closing the
        registered clients aborts any send already blocked in a socket read so it
        does not wait out the full request timeout. Closing is best-effort — a
        client that errors on close is ignored (the event is already set).
        """
        self._event.set()
        with self._lock:
            clients = list(self._clients)
        for client in clients:
            _safe_close(client)

    def raise_if_cancelled(self) -> None:
        """Raise :class:`RequestCancelled` if this request was cancelled."""
        if self._event.is_set():
            raise RequestCancelled()

    def register(self, client: Any) -> None:
        """Record ``client`` as in-flight for the duration of a send.

        If cancellation already happened between the pre-send check and here, the
        client is closed immediately so the imminent send fails fast.
        """
        with self._lock:
            self._clients.add(client)
        if self._event.is_set():
            _safe_close(client)

    def unregister(self, client: Any) -> None:
        """Drop ``client`` from the in-flight set once its send has returned."""
        with self._lock:
            self._clients.discard(client)


def _safe_close(client: Any) -> None:
    """Close an httpx client, swallowing any error (abort is best-effort)."""
    try:
        close = getattr(client, "close", None)
        if callable(close):
            close()
    except Exception:  # noqa: BLE001 — closing to abort must never raise onward
        pass


# The per-request token, propagated into the repair/scan worker thread via the
# copied context (see module docstring). ``None`` outside a cancellable request
# (e.g. /health, or the sync TestClient path), where cancellation is a no-op.
_current_token: contextvars.ContextVar[Optional[CancelToken]] = contextvars.ContextVar(
    "crepair_cancel_token", default=None
)


def set_current_token(token: Optional[CancelToken]) -> contextvars.Token:
    """Publish ``token`` as the current request's cancel token.

    Returns the reset handle from ``ContextVar.set`` so the caller can restore the
    previous value; in practice the endpoint sets it on a fresh context per request.
    """
    return _current_token.set(token)


def get_current_token() -> Optional[CancelToken]:
    """Return the current request's cancel token, or ``None`` when unset."""
    return _current_token.get()


def raise_if_current_cancelled() -> None:
    """Raise :class:`RequestCancelled` if the current request was cancelled."""
    token = _current_token.get()
    if token is not None:
        token.raise_if_cancelled()
