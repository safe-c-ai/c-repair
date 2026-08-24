"""Tests for the client-disconnect cancellation propagation (task A).

No external network and no LLM: the httpx.Client.send wrap is driven with a fake
transport, and the CancelToken / contextvar plumbing is exercised directly. The
three behaviours the guard must have:

  1. a cancelled token force-closes the in-flight client (blocked send aborts), and
  2. after cancellation the very next send raises before issuing the request
     (RequestCancelled, a BaseException so certfix's retry / per-chunk catches miss
     it), while
  3. with no cancellation the send-wrap is byte-for-byte unchanged (usage still
     metered, response returned).

The endpoint async-ification is covered for non-regression by the existing pytest
suite (TestClient drives the async handlers synchronously); here we assert the
send-wrap seam directly since a real mid-flight disconnect needs a live server.
"""

from __future__ import annotations

import httpx
import pytest

from repair_api import cancellation, usage_tracker


@pytest.fixture(autouse=True)
def _fresh_tracker():
    """Reset the shared tracker + cancel contextvar around each test."""
    usage_tracker.tracker.reset()
    cancellation.set_current_token(None)
    yield
    usage_tracker.tracker.reset()
    cancellation.set_current_token(None)


# --- CancelToken unit behaviour ---------------------------------------------


def test_token_starts_uncancelled_and_raise_is_noop() -> None:
    token = cancellation.CancelToken()
    assert token.cancelled is False
    token.raise_if_cancelled()  # must not raise


def test_cancel_sets_flag_and_raise_fires() -> None:
    token = cancellation.CancelToken()
    token.cancel()
    assert token.cancelled is True
    with pytest.raises(cancellation.RequestCancelled):
        token.raise_if_cancelled()


def test_request_cancelled_is_baseexception_not_exception() -> None:
    # The load-bearing property for retry avoidance: RequestCancelled must NOT be an
    # Exception (certfix retries httpx.HTTPError and its chunk loops catch Exception),
    # so it slips past all of them straight to the endpoint handler.
    assert issubclass(cancellation.RequestCancelled, BaseException)
    assert not issubclass(cancellation.RequestCancelled, Exception)


def test_cancel_force_closes_registered_client() -> None:
    """A cancel() closes every in-flight registered client (aborts a blocked send)."""

    class FakeClient:
        def __init__(self) -> None:
            self.closed = False

        def close(self) -> None:
            self.closed = True

    token = cancellation.CancelToken()
    client = FakeClient()
    token.register(client)
    assert client.closed is False
    token.cancel()
    assert client.closed is True


def test_register_after_cancel_closes_immediately() -> None:
    # If cancellation already fired, a client registering for an imminent send is
    # closed at once so that send fails fast rather than reaching the network.
    class FakeClient:
        def __init__(self) -> None:
            self.closed = False

        def close(self) -> None:
            self.closed = True

    token = cancellation.CancelToken()
    token.cancel()
    client = FakeClient()
    token.register(client)
    assert client.closed is True


def test_close_errors_are_swallowed() -> None:
    class BadClient:
        def close(self) -> None:
            raise RuntimeError("boom")

    token = cancellation.CancelToken()
    token.register(BadClient())
    # cancel() closes best-effort; a close that raises must not propagate.
    token.cancel()
    assert token.cancelled is True


# --- send-wrap integration (behaviours 1-3, via MockTransport) --------------


def _probe_class() -> type[httpx.Client]:
    class Probe(httpx.Client):
        pass

    assert usage_tracker.install(target=Probe) is True
    return Probe


def test_send_raises_immediately_when_token_already_cancelled() -> None:
    """Behaviour 2: a send with an already-cancelled token raises before issuing."""
    sent = {"count": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        sent["count"] += 1
        return httpx.Response(200, headers={"content-type": "application/json"}, json={})

    Probe = _probe_class()
    token = cancellation.CancelToken()
    token.cancel()
    cancellation.set_current_token(token)

    client = Probe(transport=httpx.MockTransport(handler))
    with pytest.raises(cancellation.RequestCancelled):
        client.post(
            "https://openrouter.ai/api/v1/chat/completions",
            json={"model": "m", "messages": []},
        )
    # The request was never issued (raised at the pre-send check) and nothing metered.
    assert sent["count"] == 0
    assert usage_tracker.tracker.snapshot()["requests"] == 0


def test_send_registers_and_unregisters_client_around_send() -> None:
    """Behaviour 1 wiring: the client is registered during send, cleared after."""
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        # Mid-send: the live client must be registered so a disconnect could close it.
        seen["registered_during_send"] = _token_has_registered_client(token)
        return httpx.Response(
            200,
            headers={"content-type": "application/json"},
            json={"usage": {"prompt_tokens": 3}},
        )

    Probe = _probe_class()
    token = cancellation.CancelToken()
    cancellation.set_current_token(token)

    client = Probe(transport=httpx.MockTransport(handler))
    client.post(
        "https://openrouter.ai/api/v1/chat/completions",
        json={"model": "m", "messages": []},
    )
    assert seen["registered_during_send"] is True
    # After the send returns, the client is unregistered again (no leak).
    assert _token_has_registered_client(token) is False


def test_no_token_leaves_send_unchanged() -> None:
    """Behaviour 3: with no cancel token the wrap still meters + returns normally."""
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "application/json"},
            json={"usage": {"prompt_tokens": 12, "completion_tokens": 5}},
        )

    Probe = _probe_class()
    # No token set (fixture cleared it).
    assert cancellation.get_current_token() is None

    client = Probe(transport=httpx.MockTransport(handler))
    resp = client.post(
        "https://openrouter.ai/api/v1/chat/completions",
        json={"model": "m", "messages": []},
    )
    assert resp.status_code == 200
    snap = usage_tracker.tracker.snapshot()
    assert snap["prompt_tokens"] == 12
    assert snap["completion_tokens"] == 5
    assert snap["requests"] == 1


def test_uncancelled_token_meters_normally() -> None:
    """Behaviour 3 with a live (uncancelled) token: usage still metered, no raise."""
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "application/json"},
            json={"usage": {"prompt_tokens": 7}},
        )

    Probe = _probe_class()
    token = cancellation.CancelToken()
    cancellation.set_current_token(token)

    client = Probe(transport=httpx.MockTransport(handler))
    resp = client.post(
        "https://openrouter.ai/api/v1/chat/completions",
        json={"model": "m", "messages": []},
    )
    assert resp.status_code == 200
    assert usage_tracker.tracker.snapshot()["prompt_tokens"] == 7


def _token_has_registered_client(token: cancellation.CancelToken) -> bool:
    """Test helper: whether the token currently has any in-flight client registered."""
    # Access via the guarded set through a temporary lock-free read is fine in a
    # single-threaded test (the send runs inline under MockTransport).
    return len(token._clients) > 0  # noqa: SLF001 — test introspection
