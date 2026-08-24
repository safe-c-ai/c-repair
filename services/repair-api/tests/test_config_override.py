"""Unit tests for the D-019 env override layer (repair_api.config_override).

No LLM and no network: these only load YAML and mutate an in-memory certfix
``Config``. The load-bearing guarantee is that with no ``CREPAIR_*`` env set the
effective config is bit-identical to ``Config.load(CONFIG_PATH)`` — the default
behaviour is unchanged (D-019).
"""

from __future__ import annotations

from pathlib import Path

import pytest
from certfix.config import Config

from repair_api.config_override import load_effective_config
from repair_api.main import CONFIG_PATH

# A user-supplied config used to exercise CREPAIR_CONFIG_PATH. It pins a
# different model / provider than the bundled one so the escape hatch is visible.
_ALT_CONFIG_YAML = """
detection:
  backend: api
  api:
    base_url: https://openrouter.ai/api/v1
    model: alt/model-x
    api_key_env: OPENROUTER_API_KEY
    extra_body:
      provider:
        order: ["AltProvider"]
        allow_fallbacks: true

models:
  role_a:
    backend: api
    api:
      base_url: https://openrouter.ai/api/v1
      model: alt/model-x
      extra_body:
        provider:
          order: ["AltProvider"]

fix:
  simple_repairer_role: role_a
"""


def _write_alt_config(tmp_path: Path) -> Path:
    p = tmp_path / "alt.yaml"
    p.write_text(_ALT_CONFIG_YAML, encoding="utf-8")
    return p


# --- no override = unchanged (the load-bearing invariant) -------------------


def test_no_env_yields_bit_identical_config() -> None:
    baseline = Config.load(CONFIG_PATH)
    eff = load_effective_config(CONFIG_PATH, env={})
    # Dataclasses compare structurally; equality here means every field matches.
    assert eff.config == baseline
    assert eff.model == baseline.detection.api.model
    assert eff.config_source == str(CONFIG_PATH)


def test_no_env_reports_bundled_effective_values() -> None:
    eff = load_effective_config(CONFIG_PATH, env={})
    assert eff.model == "deepseek/deepseek-v4-flash-0731"
    assert eff.provider_order == ["DeepInfra"]
    # Bundled config pins the fix role's reasoning effort at xhigh (D-028), while
    # detection reasoning is fixed off (D-029).
    assert eff.reasoning_effort == "xhigh"
    assert eff.detection_reasoning == "off"


def test_bundled_detection_reasoning_is_off() -> None:
    # D-029: detection reasoning is disabled in the bundled config.
    eff = load_effective_config(CONFIG_PATH, env={})
    assert eff.config.detection.api.extra_body["reasoning"] == {"enabled": False}


# --- CREPAIR_REASONING_EFFORT (D-029: fix role only) ------------------------


@pytest.mark.parametrize("level", ["max", "xhigh", "high", "medium", "low", "minimal"])
def test_reasoning_effort_override_applies_to_fix_role_only(level: str) -> None:
    eff = load_effective_config(CONFIG_PATH, env={"CREPAIR_REASONING_EFFORT": level})
    # reasoning_effort reports the fix role's effective value (D-029).
    assert eff.reasoning_effort == level
    for role in eff.config.models.values():
        assert role.api.extra_body["reasoning"] == {"effort": level}
    # D-029: detection is NEVER touched by the override — it stays off.
    assert eff.config.detection.api.extra_body["reasoning"] == {"enabled": False}
    assert eff.detection_reasoning == "off"
    # Model / provider are untouched when only reasoning changes.
    assert eff.model == "deepseek/deepseek-v4-flash-0731"
    assert eff.provider_order == ["DeepInfra"]


def test_reasoning_effort_off_disables_fix_role_reasoning() -> None:
    eff = load_effective_config(CONFIG_PATH, env={"CREPAIR_REASONING_EFFORT": "off"})
    assert eff.reasoning_effort == "off"
    for role in eff.config.models.values():
        assert role.api.extra_body["reasoning"] == {"enabled": False}
    # Detection was already off and stays off.
    assert eff.config.detection.api.extra_body["reasoning"] == {"enabled": False}
    assert eff.detection_reasoning == "off"


def test_reasoning_effort_is_case_insensitive() -> None:
    eff = load_effective_config(CONFIG_PATH, env={"CREPAIR_REASONING_EFFORT": "  HIGH "})
    assert eff.reasoning_effort == "high"
    for role in eff.config.models.values():
        assert role.api.extra_body["reasoning"] == {"effort": "high"}
    # Detection unaffected (D-029).
    assert eff.config.detection.api.extra_body["reasoning"] == {"enabled": False}


def test_invalid_reasoning_effort_is_ignored(caplog) -> None:
    baseline = Config.load(CONFIG_PATH)
    with caplog.at_level("WARNING"):
        eff = load_effective_config(
            CONFIG_PATH, env={"CREPAIR_REASONING_EFFORT": "ludicrous"}
        )
    # Invalid value: bundled config is kept unchanged and a warning is logged.
    assert eff.config == baseline
    assert eff.reasoning_effort == "xhigh"
    assert any("CREPAIR_REASONING_EFFORT" in r.message for r in caplog.records)


def test_empty_reasoning_effort_is_treated_as_unset() -> None:
    baseline = Config.load(CONFIG_PATH)
    eff = load_effective_config(CONFIG_PATH, env={"CREPAIR_REASONING_EFFORT": "   "})
    assert eff.config == baseline
    assert eff.reasoning_effort == "xhigh"


# --- CREPAIR_MODEL_ID -------------------------------------------------------


def test_model_id_override_replaces_detection_and_all_roles() -> None:
    eff = load_effective_config(CONFIG_PATH, env={"CREPAIR_MODEL_ID": "vendor/new-model"})
    assert eff.config.detection.api.model == "vendor/new-model"
    assert eff.model == "vendor/new-model"
    # Every role model is replaced too (detection + fix share the identity).
    for role in eff.config.models.values():
        assert role.api.model == "vendor/new-model"
    # Provider pin is untouched when only the model is overridden.
    assert eff.provider_order == ["DeepInfra"]


def test_model_id_override_does_not_mutate_the_cached_config() -> None:
    # Overriding must deep-copy; a fresh baseline load stays pristine.
    load_effective_config(CONFIG_PATH, env={"CREPAIR_MODEL_ID": "vendor/new-model"})
    baseline = Config.load(CONFIG_PATH)
    assert baseline.detection.api.model == "deepseek/deepseek-v4-flash-0731"


# --- CREPAIR_PROVIDER_ORDER -------------------------------------------------


def test_provider_order_override_replaces_order() -> None:
    eff = load_effective_config(
        CONFIG_PATH, env={"CREPAIR_PROVIDER_ORDER": "Fireworks, Together"}
    )
    assert eff.provider_order == ["Fireworks", "Together"]
    det_provider = eff.config.detection.api.extra_body["provider"]
    assert det_provider["order"] == ["Fireworks", "Together"]
    for role in eff.config.models.values():
        assert role.api.extra_body["provider"]["order"] == ["Fireworks", "Together"]


def test_empty_provider_order_removes_the_pin() -> None:
    eff = load_effective_config(CONFIG_PATH, env={"CREPAIR_PROVIDER_ORDER": ""})
    # Empty string explicitly set => OpenRouter automatic routing (no pin).
    assert eff.provider_order == []
    det_provider = eff.config.detection.api.extra_body.get("provider", {})
    assert "order" not in det_provider
    for role in eff.config.models.values():
        assert "order" not in role.api.extra_body.get("provider", {})


def test_provider_order_whitespace_only_also_removes_the_pin() -> None:
    eff = load_effective_config(CONFIG_PATH, env={"CREPAIR_PROVIDER_ORDER": "   "})
    assert eff.provider_order == []


# --- CREPAIR_ALLOW_FALLBACKS ------------------------------------------------


def test_allow_fallbacks_true_sets_the_flag() -> None:
    eff = load_effective_config(CONFIG_PATH, env={"CREPAIR_ALLOW_FALLBACKS": "true"})
    assert eff.config.detection.api.extra_body["provider"]["allow_fallbacks"] is True
    for role in eff.config.models.values():
        assert role.api.extra_body["provider"]["allow_fallbacks"] is True
    # Order pin is preserved when only allow_fallbacks changes.
    assert eff.provider_order == ["DeepInfra"]


def test_allow_fallbacks_false_sets_the_flag() -> None:
    eff = load_effective_config(CONFIG_PATH, env={"CREPAIR_ALLOW_FALLBACKS": "false"})
    assert eff.config.detection.api.extra_body["provider"]["allow_fallbacks"] is False


def test_allow_fallbacks_empty_is_treated_as_unset() -> None:
    baseline = Config.load(CONFIG_PATH)
    eff = load_effective_config(CONFIG_PATH, env={"CREPAIR_ALLOW_FALLBACKS": "  "})
    assert eff.config == baseline


# --- combined + empty-order edge cases --------------------------------------


def test_empty_order_and_allow_fallbacks_keeps_provider_block_for_the_flag() -> None:
    eff = load_effective_config(
        CONFIG_PATH,
        env={"CREPAIR_PROVIDER_ORDER": "", "CREPAIR_ALLOW_FALLBACKS": "true"},
    )
    provider = eff.config.detection.api.extra_body["provider"]
    assert "order" not in provider  # pin removed
    assert provider["allow_fallbacks"] is True  # but the flag remains
    assert eff.provider_order == []


def test_model_and_provider_together() -> None:
    eff = load_effective_config(
        CONFIG_PATH,
        env={"CREPAIR_MODEL_ID": "vendor/m", "CREPAIR_PROVIDER_ORDER": "P1,P2"},
    )
    assert eff.model == "vendor/m"
    assert eff.provider_order == ["P1", "P2"]


# --- CREPAIR_PROVIDER_POLICY (D-019 follow-up) ------------------------------

# The private-cheap provider preference the bridge writes (ZDR + cheapest-first).
_PRIVATE_CHEAP = {"zdr": True, "sort": "price", "allow_fallbacks": True}


def test_provider_policy_unset_is_unchanged() -> None:
    # No policy env => bit-identical to the bundled config and provider_policy "none".
    baseline = Config.load(CONFIG_PATH)
    eff = load_effective_config(CONFIG_PATH, env={})
    assert eff.config == baseline
    assert eff.provider_policy == "none"


def test_private_cheap_with_empty_order_sets_zdr_price_provider() -> None:
    # Custom mode with an empty order pin: the policy owns the provider block on
    # detection + every fix role, replacing any inherited order.
    eff = load_effective_config(
        CONFIG_PATH,
        env={"CREPAIR_PROVIDER_ORDER": "", "CREPAIR_PROVIDER_POLICY": "private-cheap"},
    )
    assert eff.provider_policy == "private-cheap"
    assert eff.config.detection.api.extra_body["provider"] == _PRIVATE_CHEAP
    for role in eff.config.models.values():
        assert role.api.extra_body["provider"] == _PRIVATE_CHEAP
    # The order pin is gone (ZDR + cheapest-first automatic routing).
    assert eff.provider_order == []


def test_private_cheap_without_an_order_env_still_applies() -> None:
    # The policy applies whenever there is no explicit pin — even if the order env is
    # not sent at all (order unset). The bundled DeepInfra pin is replaced wholesale.
    eff = load_effective_config(
        CONFIG_PATH, env={"CREPAIR_PROVIDER_POLICY": "private-cheap"}
    )
    assert eff.provider_policy == "private-cheap"
    assert eff.config.detection.api.extra_body["provider"] == _PRIVATE_CHEAP
    for role in eff.config.models.values():
        assert role.api.extra_body["provider"] == _PRIVATE_CHEAP
    assert eff.provider_order == []


def test_balanced_policy_removes_any_provider_preference() -> None:
    eff = load_effective_config(
        CONFIG_PATH,
        env={"CREPAIR_PROVIDER_ORDER": "", "CREPAIR_PROVIDER_POLICY": "balanced"},
    )
    assert eff.provider_policy == "balanced"
    # No provider block at all (OpenRouter default routing).
    assert "provider" not in eff.config.detection.api.extra_body
    for role in eff.config.models.values():
        assert "provider" not in role.api.extra_body
    assert eff.provider_order == []


def test_explicit_order_pin_wins_over_the_policy() -> None:
    # An explicit non-empty order pin owns routing; the policy is ignored entirely so
    # the order-over-policy precedence is preserved.
    eff = load_effective_config(
        CONFIG_PATH,
        env={
            "CREPAIR_PROVIDER_ORDER": "Fireworks,Together",
            "CREPAIR_PROVIDER_POLICY": "private-cheap",
        },
    )
    assert eff.provider_policy == "none"  # not applied — the pin won
    assert eff.provider_order == ["Fireworks", "Together"]
    det_provider = eff.config.detection.api.extra_body["provider"]
    assert det_provider["order"] == ["Fireworks", "Together"]
    assert "zdr" not in det_provider  # the ZDR preference was NOT written
    for role in eff.config.models.values():
        assert role.api.extra_body["provider"]["order"] == ["Fireworks", "Together"]
        assert "zdr" not in role.api.extra_body["provider"]


def test_provider_policy_is_case_insensitive() -> None:
    eff = load_effective_config(
        CONFIG_PATH,
        env={"CREPAIR_PROVIDER_ORDER": "", "CREPAIR_PROVIDER_POLICY": "  Private-Cheap "},
    )
    assert eff.provider_policy == "private-cheap"
    assert eff.config.detection.api.extra_body["provider"] == _PRIVATE_CHEAP


def test_invalid_provider_policy_is_ignored(caplog) -> None:
    baseline = Config.load(CONFIG_PATH)
    with caplog.at_level("WARNING"):
        eff = load_effective_config(
            CONFIG_PATH, env={"CREPAIR_PROVIDER_POLICY": "cheapskate"}
        )
    # Unrecognized value: no policy applied, bundled config kept, warning logged.
    assert eff.config == baseline
    assert eff.provider_policy == "none"
    assert any("CREPAIR_PROVIDER_POLICY" in r.message for r in caplog.records)


def test_empty_provider_policy_is_treated_as_unset() -> None:
    baseline = Config.load(CONFIG_PATH)
    eff = load_effective_config(CONFIG_PATH, env={"CREPAIR_PROVIDER_POLICY": "   "})
    assert eff.config == baseline
    assert eff.provider_policy == "none"


def test_private_cheap_does_not_mutate_the_cached_config() -> None:
    load_effective_config(
        CONFIG_PATH,
        env={"CREPAIR_PROVIDER_ORDER": "", "CREPAIR_PROVIDER_POLICY": "private-cheap"},
    )
    baseline = Config.load(CONFIG_PATH)
    # The bundled config is untouched (deep-copied before mutation).
    assert baseline.detection.api.extra_body["provider"]["order"] == ["DeepInfra"]


def test_private_cheap_reasoning_is_preserved_on_the_fix_role() -> None:
    # Applying the policy replaces only the provider block; the fix-role reasoning
    # (bundled xhigh, D-028) is left intact.
    eff = load_effective_config(
        CONFIG_PATH,
        env={"CREPAIR_PROVIDER_ORDER": "", "CREPAIR_PROVIDER_POLICY": "private-cheap"},
    )
    for role in eff.config.models.values():
        assert role.api.extra_body["reasoning"] == {"effort": "xhigh"}
    assert eff.reasoning_effort == "xhigh"
    # Detection reasoning stays off (D-029), untouched by the policy.
    assert eff.config.detection.api.extra_body["reasoning"] == {"enabled": False}


# --- CREPAIR_CONFIG_PATH (full escape hatch) --------------------------------


def test_config_path_loads_user_yaml(tmp_path: Path) -> None:
    alt = _write_alt_config(tmp_path)
    eff = load_effective_config(CONFIG_PATH, env={"CREPAIR_CONFIG_PATH": str(alt)})
    assert eff.config_source == str(alt)
    assert eff.model == "alt/model-x"
    assert eff.provider_order == ["AltProvider"]


def test_config_path_overrides_still_apply_on_top(tmp_path: Path) -> None:
    alt = _write_alt_config(tmp_path)
    eff = load_effective_config(
        CONFIG_PATH,
        env={
            "CREPAIR_CONFIG_PATH": str(alt),
            "CREPAIR_MODEL_ID": "vendor/override",
            "CREPAIR_PROVIDER_ORDER": "",
        },
    )
    # The escape-hatch YAML is the base; the model + provider overrides layer on.
    assert eff.model == "vendor/override"
    assert eff.provider_order == []
    for role in eff.config.models.values():
        assert role.api.model == "vendor/override"
