"""Tests for deterministic context revision ids (PHASE3A_DESIGN.md §2, §5-5)."""

from __future__ import annotations

from repair_api import context

HASH = "sha256:" + "a" * 64


def _item(text: str) -> dict:
    return {
        "item_id": "i1",
        "kind": "external_global",
        "generated_text": text,
        "current_text": text,
        "provenance": "derived_from_usage",
        "user_edited": False,
        "confirmed": True,
        "rationale": "r",
        "usage_evidence": [],
    }


def test_revision_is_prefixed_and_12_hex() -> None:
    rev = context.compute_revision_id(HASH, [])
    assert rev.startswith("ctxrev-")
    body = rev[len("ctxrev-") :]
    assert len(body) == 12
    assert all(c in "0123456789abcdef" for c in body)


def test_revision_idempotent_same_input() -> None:
    items = [_item("extern int a;")]
    assert context.compute_revision_id(HASH, items) == context.compute_revision_id(HASH, items)


def test_revision_depends_on_items_current_text() -> None:
    r_empty = context.compute_revision_id(HASH, [])
    r_a = context.compute_revision_id(HASH, [_item("extern int a;")])
    r_b = context.compute_revision_id(HASH, [_item("extern int b;")])
    assert r_empty != r_a
    assert r_a != r_b


def test_revision_depends_on_original_hash() -> None:
    other = "sha256:" + "b" * 64
    assert context.compute_revision_id(HASH, []) != context.compute_revision_id(other, [])


def test_revision_ignores_non_current_text_fields() -> None:
    base = _item("extern int a;")
    edited = dict(base)
    edited["generated_text"] = "different generated text"
    edited["user_edited"] = True
    # Only current_text feeds the revision, so these two must be equal.
    assert context.compute_revision_id(HASH, [base]) == context.compute_revision_id(HASH, [edited])
