"""Tests for the D-030 httpx usage instrumentation + /usage endpoints.

No external network and no LLM: the httpx.Client.send wrap is driven with fake
requests / responses (or a MockTransport-backed Client), the accumulator is a pure
in-memory counter, and the endpoints are exercised through FastAPI's TestClient.
"""

from __future__ import annotations

import httpx
import pytest
from conftest import ScriptedFake, sha256_prefixed
from fastapi.testclient import TestClient

from repair_api import usage_tracker
from repair_api.main import create_app


# --- fakes ------------------------------------------------------------------


def _make_response(
    *,
    host: str = "openrouter.ai",
    path: str = "/api/v1/chat/completions",
    content_type: str = "application/json",
    json_body: object | None = None,
    raw_text: str | None = None,
) -> httpx.Response:
    """Build a real httpx.Response bound to a request, for the wrapper to inspect."""
    request = httpx.Request("POST", f"https://{host}{path}")
    headers = {"content-type": content_type}
    if raw_text is not None:
        return httpx.Response(200, headers=headers, text=raw_text, request=request)
    return httpx.Response(200, headers=headers, json=json_body, request=request)


@pytest.fixture(autouse=True)
def _fresh_tracker():
    """Reset the shared tracker before/after each test so counts never leak."""
    usage_tracker.tracker.reset()
    usage_tracker.reset_finish_reason()
    yield
    usage_tracker.tracker.reset()
    usage_tracker.reset_finish_reason()


# --- accumulator: usage parsing (numbers only, defensive) -------------------


def test_add_from_response_json_sums_all_token_kinds() -> None:
    usage_tracker.tracker.add_from_response_json(
        {
            "usage": {
                "prompt_tokens": 100,
                "completion_tokens": 40,
                "completion_tokens_details": {"reasoning_tokens": 25},
            }
        }
    )
    assert usage_tracker.tracker.snapshot() == {
        "prompt_tokens": 100,
        "completion_tokens": 40,
        "reasoning_tokens": 25,
        "requests": 1,
    }


def test_add_from_response_json_accumulates_across_calls() -> None:
    usage_tracker.tracker.add_from_response_json(
        {"usage": {"prompt_tokens": 10, "completion_tokens": 5}}
    )
    usage_tracker.tracker.add_from_response_json(
        {"usage": {"prompt_tokens": 3, "completion_tokens": 2}}
    )
    snap = usage_tracker.tracker.snapshot()
    assert snap["prompt_tokens"] == 13
    assert snap["completion_tokens"] == 7
    assert snap["reasoning_tokens"] == 0
    assert snap["requests"] == 2


def test_missing_fields_count_as_zero_but_request_is_counted() -> None:
    usage_tracker.tracker.add_from_response_json({"usage": {}})
    usage_tracker.tracker.add_from_response_json({})  # no usage block at all
    snap = usage_tracker.tracker.snapshot()
    assert snap == {
        "prompt_tokens": 0,
        "completion_tokens": 0,
        "reasoning_tokens": 0,
        "requests": 2,
    }


def test_malformed_usage_values_are_ignored() -> None:
    usage_tracker.tracker.add_from_response_json(
        {
            "usage": {
                "prompt_tokens": "not-an-int",
                "completion_tokens": -5,  # negative -> 0
                "completion_tokens_details": {"reasoning_tokens": True},  # bool -> 0
            }
        }
    )
    snap = usage_tracker.tracker.snapshot()
    assert snap["prompt_tokens"] == 0
    assert snap["completion_tokens"] == 0
    assert snap["reasoning_tokens"] == 0
    assert snap["requests"] == 1


def test_non_dict_body_is_tolerated() -> None:
    usage_tracker.tracker.add_from_response_json("nope")
    usage_tracker.tracker.add_from_response_json(None)
    usage_tracker.tracker.add_from_response_json([1, 2, 3])
    assert usage_tracker.tracker.snapshot()["requests"] == 3


def test_reset_zeroes_all_counters() -> None:
    usage_tracker.tracker.add_from_response_json(
        {"usage": {"prompt_tokens": 9, "completion_tokens": 9}}
    )
    usage_tracker.tracker.reset()
    assert usage_tracker.tracker.snapshot() == {
        "prompt_tokens": 0,
        "completion_tokens": 0,
        "reasoning_tokens": 0,
        "requests": 0,
    }


# --- the httpx.Client.send wrapper (target-injected, no real network) -------


def test_install_wraps_and_meters_openrouter_via_mock_transport() -> None:
    """A wrapped Client.send records usage for an OpenRouter chat-completions call."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "application/json"},
            json={
                "usage": {
                    "prompt_tokens": 42,
                    "completion_tokens": 8,
                    "completion_tokens_details": {"reasoning_tokens": 3},
                }
            },
        )

    # A subclass so we can wrap send() on the class without patching the real
    # httpx.Client (test isolation). install() honours the injected target.
    class Probe(httpx.Client):
        pass

    assert usage_tracker.install(target=Probe) is True
    client = Probe(transport=httpx.MockTransport(handler))
    resp = client.post(
        "https://openrouter.ai/api/v1/chat/completions", json={"model": "m", "messages": []}
    )
    assert resp.status_code == 200  # request itself unaffected

    snap = usage_tracker.tracker.snapshot()
    assert snap == {
        "prompt_tokens": 42,
        "completion_tokens": 8,
        "reasoning_tokens": 3,
        "requests": 1,
    }


def test_install_is_idempotent() -> None:
    class Probe(httpx.Client):
        pass

    assert usage_tracker.install(target=Probe) is True
    first = Probe.send
    assert usage_tracker.install(target=Probe) is True
    # A second install must not double-wrap (would double-count each response).
    assert Probe.send is first


def test_non_openrouter_host_is_ignored() -> None:
    usage_tracker._record_from_send(
        httpx.Request("POST", "https://api.example.com/v1/chat/completions"),
        _make_response(host="api.example.com"),
        stream=False,
    )
    assert usage_tracker.tracker.snapshot()["requests"] == 0


def test_openrouter_non_chat_path_is_ignored() -> None:
    resp = _make_response(path="/api/v1/key")
    usage_tracker._record_from_send(resp.request, resp, stream=False)
    assert usage_tracker.tracker.snapshot()["requests"] == 0


def test_streaming_response_is_skipped() -> None:
    resp = _make_response(json_body={"usage": {"prompt_tokens": 5}})
    usage_tracker._record_from_send(resp.request, resp, stream=True)
    assert usage_tracker.tracker.snapshot()["requests"] == 0


def test_non_json_content_type_is_skipped() -> None:
    resp = _make_response(content_type="text/event-stream", raw_text="data: {}\n")
    usage_tracker._record_from_send(resp.request, resp, stream=False)
    assert usage_tracker.tracker.snapshot()["requests"] == 0


def test_json_parse_failure_is_tolerated() -> None:
    # Advertises JSON but the body is not valid JSON: response.json() raises and we
    # swallow it (no request counted because parsing failed before add_*).
    resp = _make_response(content_type="application/json", raw_text="<<not json>>")
    usage_tracker._record_from_send(resp.request, resp, stream=False)
    assert usage_tracker.tracker.snapshot()["requests"] == 0


def test_subdomain_host_is_metered() -> None:
    resp = _make_response(host="openrouter.ai", json_body={"usage": {"prompt_tokens": 7}})
    usage_tracker._record_from_send(resp.request, resp, stream=False)
    assert usage_tracker.tracker.snapshot()["prompt_tokens"] == 7


# --- finish_reason recording (task §2, value-only, thread-local) ------------


def test_finish_reason_length_is_recorded_from_send() -> None:
    # A chat-completions response carrying finish_reason=length -> the recorder
    # captures "length" (which the repair path reads to detect truncation).
    resp = _make_response(
        json_body={
            "choices": [{"finish_reason": "length", "message": {"content": "..."}}],
            "usage": {"prompt_tokens": 5},
        }
    )
    usage_tracker._record_from_send(resp.request, resp, stream=False)
    assert usage_tracker.last_finish_reason() == "length"
    assert usage_tracker.is_truncation_finish_reason(usage_tracker.last_finish_reason())


def test_finish_reason_stop_is_not_truncation() -> None:
    resp = _make_response(
        json_body={"choices": [{"finish_reason": "stop", "message": {"content": "x"}}]}
    )
    usage_tracker._record_from_send(resp.request, resp, stream=False)
    assert usage_tracker.last_finish_reason() == "stop"
    assert usage_tracker.is_truncation_finish_reason("stop") is False


def test_finish_reason_max_tokens_counts_as_truncation() -> None:
    # Some providers emit "max_tokens" for the same budget-cut condition.
    assert usage_tracker.is_truncation_finish_reason("max_tokens") is True
    assert usage_tracker.is_truncation_finish_reason("LENGTH") is True  # case-insensitive
    assert usage_tracker.is_truncation_finish_reason(None) is False
    assert usage_tracker.is_truncation_finish_reason("") is False


def test_finish_reason_missing_choices_records_none() -> None:
    # A body with no choices -> recorder set to None (not left stale).
    usage_tracker._record_finish_reason("length")  # seed a stale value
    resp = _make_response(json_body={"usage": {"prompt_tokens": 1}})
    usage_tracker._record_from_send(resp.request, resp, stream=False)
    assert usage_tracker.last_finish_reason() is None


def test_finish_reason_not_recorded_for_non_openrouter() -> None:
    # A non-OpenRouter host is skipped entirely; the recorder is untouched.
    usage_tracker._record_finish_reason("length")
    resp = _make_response(
        host="api.example.com",
        json_body={"choices": [{"finish_reason": "stop"}]},
    )
    usage_tracker._record_from_send(resp.request, resp, stream=False)
    # Still the seeded value (send was ignored before touching the recorder).
    assert usage_tracker.last_finish_reason() == "length"


def test_extract_finish_reason_is_defensive() -> None:
    assert usage_tracker._extract_finish_reason(None) is None
    assert usage_tracker._extract_finish_reason({"choices": []}) is None
    assert usage_tracker._extract_finish_reason({"choices": "nope"}) is None
    assert usage_tracker._extract_finish_reason({"choices": [{"finish_reason": ""}]}) is None
    assert usage_tracker._extract_finish_reason({"choices": [{"finish_reason": 7}]}) is None
    assert (
        usage_tracker._extract_finish_reason({"choices": [{"finish_reason": "length"}]}) == "length"
    )


def test_finish_reason_recorded_via_wrapped_send_mock_transport() -> None:
    # End-to-end through a wrapped Client.send + MockTransport injecting
    # finish_reason=length: the recorder captures it (no real network, no LLM).
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "application/json"},
            json={
                "choices": [{"finish_reason": "length", "message": {"content": "..."}}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 20},
            },
        )

    class Probe(httpx.Client):
        pass

    assert usage_tracker.install(target=Probe) is True
    client = Probe(transport=httpx.MockTransport(handler))
    client.post(
        "https://openrouter.ai/api/v1/chat/completions", json={"model": "m", "messages": []}
    )
    assert usage_tracker.last_finish_reason() == "length"


# --- endpoints --------------------------------------------------------------


def _client(bridge_token: str | None = None) -> TestClient:
    fake = ScriptedFake({"int scale_reading": ["INT32-C"]})
    app = create_app(backend_factory=lambda: fake, bridge_token=bridge_token)
    return TestClient(app)


def test_get_usage_returns_current_totals() -> None:
    client = _client()
    usage_tracker.tracker.add_from_response_json(
        {
            "usage": {
                "prompt_tokens": 11,
                "completion_tokens": 4,
                "completion_tokens_details": {"reasoning_tokens": 2},
            }
        }
    )
    body = client.get("/usage").json()
    assert body == {
        "prompt_tokens": 11,
        "completion_tokens": 4,
        "reasoning_tokens": 2,
        "requests": 1,
    }


def test_post_usage_reset_zeroes_and_returns_zeros() -> None:
    client = _client()
    usage_tracker.tracker.add_from_response_json({"usage": {"prompt_tokens": 99}})
    body = client.post("/usage/reset").json()
    assert body == {
        "prompt_tokens": 0,
        "completion_tokens": 0,
        "reasoning_tokens": 0,
        "requests": 0,
    }
    assert client.get("/usage").json()["prompt_tokens"] == 0


def test_usage_endpoints_are_behind_bearer_auth() -> None:
    client = _client(bridge_token="secret-token-xyz")
    assert client.get("/usage").status_code == 401
    assert client.post("/usage/reset").status_code == 401
    ok = client.get("/usage", headers={"Authorization": "Bearer secret-token-xyz"})
    assert ok.status_code == 200
