"""Repair factory wiring tests (T0: violation-backend prompt-profile fix).

No LLM is called: backends are constructed from the bundled config (which does
not read the API key until a request is actually sent) and only their attributes
are inspected. This guards the wiring bug where the violation-removal backend was
given the FIX-role prompt profile (a text-generation profile), so its ``detect``
raised ``Unknown prompt profile`` and every removal re-scan chunk failed.
"""

from __future__ import annotations

from repair_api.config_override import load_effective_config
from repair_api.main import CONFIG_PATH, _default_repair_factory


def test_violation_backend_uses_detection_prompt_profile() -> None:
    # The violation-removal backend must carry the DETECTION prompt profile so its
    # detect() takes the valid detection path (not the fix-role text profile).
    deps = _default_repair_factory()
    cfg = load_effective_config(CONFIG_PATH).config
    assert deps.violation_backend is not None
    assert deps.violation_backend._prompt_profile == cfg.detection.prompt_profile
    # Sanity: it is NOT the fix backend (which carries the fix-role profile).
    assert deps.violation_backend is not deps.backend


def test_fix_and_semantic_backends_share_the_fix_role_profile() -> None:
    # The fix backend uses the fix-role profile; the semantic gate only calls
    # generate() (no profile resolution), so it safely reuses the fix backend.
    deps = _default_repair_factory()
    cfg = load_effective_config(CONFIG_PATH).config
    role_name = cfg.fix.simple_repairer_role or cfg.validation.semantic.reviewer_role
    role = cfg.models[role_name]
    assert deps.backend._prompt_profile == role.profile
    assert deps.semantic_backend is deps.backend
    # The two roles resolve to different prompt profiles — the whole point of T0.
    assert deps.backend._prompt_profile != deps.violation_backend._prompt_profile


def test_violation_backend_detection_profile_is_resolvable() -> None:
    # The detection profile must actually resolve for detect() — the bundled
    # qwen36 check profile takes the two-stage path (line_aware_detection False),
    # never hitting resolve_profile with an unknown name.
    deps = _default_repair_factory()
    # ApiBackend sets line_aware_detection = (prompt_profile != QWEN36_CHECK_PROFILE).
    # The bundled detection profile IS the qwen36 check profile -> two-stage path.
    assert deps.violation_backend.line_aware_detection is False


def test_infer_backend_reasoning_disabled_fix_role_untouched() -> None:
    # /context/infer gets a DEDICATED backend: the fix role cloned with
    # extra_body.reasoning replaced by {enabled: false} (D-029-parallel — CoT
    # written into content by some free-pool providers exhausted the infer
    # budget before any declaration was emitted; lua-lapi/lua-lgc 0-items).
    deps = _default_repair_factory()
    cfg = load_effective_config(CONFIG_PATH).config
    role_name = cfg.fix.simple_repairer_role or cfg.validation.semantic.reviewer_role
    role = cfg.models[role_name]

    assert deps.infer_backend is not None
    assert deps.infer_backend is not deps.backend
    assert deps.infer_backend._extra_body["reasoning"] == {"enabled": False}
    # The fix role keeps reasoning ENABLED, in the D-034 converted (explicit
    # cap) form — the bundled effort level mapped through REASONING_EFFORT_CAPS.
    from repair_api.adapter import repair as repair_adapter

    bundled_effort = role.api.extra_body["reasoning"]["effort"]
    expected_cap = repair_adapter.REASONING_EFFORT_CAPS[bundled_effort]
    assert deps.backend._extra_body["reasoning"] == {"max_tokens": expected_cap}
    # Everything but reasoning is inherited: provider pin, model, profile.
    assert deps.infer_backend._extra_body["provider"] == role.api.extra_body["provider"]
    assert deps.infer_backend.model == deps.backend.model
    assert deps.infer_backend._prompt_profile == deps.backend._prompt_profile


def test_fix_role_effort_converted_to_cap_config_and_backend_agree() -> None:
    # D-034: the factory converts the FINAL fix role's effort into an explicit
    # reasoning token cap. Both consumers must see the converted form: the
    # backend (what is sent to the provider) and RepairConfig.fix_extra_body
    # (what sizes the repair budget's reasoning allowance). Detection stays off.
    from repair_api.adapter import repair as repair_adapter

    deps = _default_repair_factory()
    cfg = load_effective_config(CONFIG_PATH).config
    role_name = cfg.fix.simple_repairer_role or cfg.validation.semantic.reviewer_role
    bundled_effort = cfg.models[role_name].api.extra_body["reasoning"]["effort"]
    expected_cap = repair_adapter.REASONING_EFFORT_CAPS[bundled_effort]

    assert deps.backend._extra_body["reasoning"] == {"max_tokens": expected_cap}
    assert deps.config.fix_extra_body["reasoning"] == {"max_tokens": expected_cap}
    # The budget helper reads the same allowance from the config.
    assert repair_adapter._fix_reasoning_cap(deps.config.fix_extra_body) == expected_cap
    # Provider pin survives the conversion.
    assert deps.config.fix_extra_body["provider"] == cfg.models[role_name].api.extra_body["provider"]
    # Detection keeps its own reasoning-off setting (D-029, untouched).
    assert deps.violation_backend._extra_body["reasoning"] == {"enabled": False}


def test_repair_deps_infer_backend_defaults_to_none() -> None:
    # RepairDeps built without infer_backend (older factories / test fakes) keeps
    # working: the field defaults to None and /context/infer falls back to the
    # fix backend (see test_api coverage of the endpoint fallback).
    from repair_api.main import RepairDeps

    deps = RepairDeps(backend=object(), config=object())
    assert deps.infer_backend is None
