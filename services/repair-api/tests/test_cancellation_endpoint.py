"""End-to-end async-endpoint disconnect test (task A), no LLM, no real network.

Drives the ASGI app directly with a controllable ``receive`` channel so we can
inject an ``http.disconnect`` mid-flight, and a fake scan backend whose ``detect``
blocks in a worker thread until the request's CancelToken is cancelled. This proves
the full chain end-to-end:

    async endpoint -> run_in_threadpool (context copied) -> backend blocked
    -> disconnect monitor sees http.disconnect -> token.cancel()
    -> RequestCancelled raised in the worker -> handler returns the 499 abort

without a live uvicorn server or any LLM call. The blocking backend consults the
contextvar token directly (the same token the send-wrap would consult), so we do
not need a real httpx send to demonstrate the propagation + abort.
"""

from __future__ import annotations

import asyncio
import threading

import pytest
from conftest import sha256_prefixed

from repair_api import cancellation
from repair_api.main import create_app


class _BlockingScanBackend:
    """Fake detection backend whose detect() blocks until the request is cancelled.

    Simulates a long in-flight LLM call: it parks the worker thread until the
    per-request CancelToken (read off the copied context) is cancelled, then raises
    RequestCancelled exactly as the real send-wrap would. Records when it started so
    the test can wait until the work is genuinely in the threadpool before injecting
    the disconnect.
    """

    line_aware_detection = False

    def __init__(self) -> None:
        self.started = threading.Event()

    def detect(self, code, rules=None, *args, **kwargs):
        self.started.set()
        token = cancellation.get_current_token()
        # Park until cancelled (or a generous safety timeout so a bug can't hang CI).
        for _ in range(500):  # 500 * 20ms = 10s ceiling
            if token is not None and token.cancelled:
                token.raise_if_cancelled()
            threading.Event().wait(0.02)
        raise AssertionError("detect was never cancelled (disconnect not propagated)")


async def _call_scan_with_disconnect(app, body: dict) -> int:
    """Invoke POST /scan through the ASGI app, disconnecting once work has started.

    Returns the response status code the app produced on the aborted path.
    """
    backend = app.state._test_backend  # the blocking backend (stashed below)

    import json as _json

    payload = _json.dumps(body).encode()
    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "path": "/scan",
        "raw_path": b"/scan",
        "query_string": b"",
        "root_path": "",
        "scheme": "http",
        "headers": [
            (b"content-type", b"application/json"),
            (b"content-length", str(len(payload)).encode()),
        ],
        "client": ("127.0.0.1", 12345),
        "server": ("127.0.0.1", 80),
    }

    # A NON-BLOCKING receive channel: the first call hands over the request body;
    # every later call returns http.disconnect ONCE the blocking backend has started
    # (else a benign empty http.request). Non-blocking is required because Starlette's
    # is_disconnected() awaits receive() inside an already-cancelled CancelScope — a
    # blocking await there would be cancelled and the disconnect never observed.
    state = {"body_sent": False}

    async def receive():
        if not state["body_sent"]:
            state["body_sent"] = True
            return {"type": "http.request", "body": payload, "more_body": False}
        if backend.started.is_set():
            return {"type": "http.disconnect"}
        # Backend not in-flight yet: yield a benign no-op body chunk so the poll
        # keeps ticking without blocking.
        return {"type": "http.request", "body": b"", "more_body": False}

    sent: dict[str, int] = {}

    async def send(message):
        if message["type"] == "http.response.start":
            sent["status"] = message["status"]

    await app(scope, receive, send)
    return sent.get("status", 0)


def test_scan_aborts_on_client_disconnect() -> None:
    # Driven with asyncio.run (no pytest-asyncio/anyio plugin installed): a plain
    # sync test that runs the async ASGI drive to completion.
    backend = _BlockingScanBackend()
    app = create_app(backend_factory=lambda: backend)
    app.state._test_backend = backend

    content = "int scale_reading(int x) { return x; }\n"
    chash = sha256_prefixed(content)
    body = {
        "source_document": {
            "source_id": "src-abc",
            "filename": "x.c",
            "language": "c",
            "content": content,
            "content_hash": chash,
            "size_bytes": len(content.encode()),
            "origin": "vscode_document",
        },
        "context_augmentation_set": {
            "set_id": "augset-src-abc",
            "source_id": "src-abc",
            "original_hash": chash,
            "status": "confirmed",
            "context_revision_id": "rev-1",
            "prelude_line_count": 0,
            "items": [],
        },
        "compile_include_paths": [],
    }

    async def _run() -> int:
        return await asyncio.wait_for(_call_scan_with_disconnect(app, body), timeout=15)

    status = asyncio.run(_run())
    # 499 = the client-closed abort path (handler swallowed RequestCancelled).
    assert status == 499
