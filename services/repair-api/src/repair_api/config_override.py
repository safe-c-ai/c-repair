"""Env-driven overrides on top of the bundled certfix config (D-019).

``load_effective_config()`` is the single place the bridge loads its certfix
``Config``. It reads the bundled YAML (or a user-supplied one via
``CREPAIR_CONFIG_PATH``) and then applies a small set of ``CREPAIR_*`` overrides
so the VS Code extension can let a user set model / provider without editing the
YAML. When no override env vars are set, the returned Config is **bit-identical**
to ``Config.load(CONFIG_PATH)`` — the default behaviour is unchanged (D-019: 既定
挙動を変えない).

Env vars (all optional):

- ``CREPAIR_CONFIG_PATH``  — full escape hatch: load this YAML instead of the
  bundled one. The remaining overrides are still applied on top of it.
- ``CREPAIR_MODEL_ID``     — replace ``detection.api.model`` and every
  ``models.*.api.model`` with this OpenRouter model id.
- ``CREPAIR_PROVIDER_ORDER`` — comma-separated provider order for
  ``extra_body.provider.order`` on detection + every role. An **empty string
  explicitly set** removes the provider pin entirely (OpenRouter automatic
  routing); when unset the YAML value is left untouched.
- ``CREPAIR_ALLOW_FALLBACKS`` — ``"true"``/``"false"`` for
  ``extra_body.provider.allow_fallbacks``.
- ``CREPAIR_PROVIDER_POLICY`` — an automatic OpenRouter provider-preference profile
  applied to ``extra_body.provider`` on detection + every fix role, used when the
  extension is in custom mode with an EMPTY provider order (D-019 follow-up):
  ``private-cheap`` sets ``{"zdr": true, "sort": "price", "allow_fallbacks": true}``
  (Zero-Data-Retention providers only, cheapest first; latency is OpenRouter's
  same-tier tie-break). ``balanced`` applies no provider preference (OpenRouter
  default routing). An explicit ``CREPAIR_PROVIDER_ORDER`` (non-empty) always wins:
  when a pin is present the policy is IGNORED so the order-over-policy precedence is
  preserved. Unset / unrecognized => no policy (default routing).
- ``CREPAIR_REASONING_EFFORT`` — reasoning effort on ``extra_body.reasoning`` for
  the **fix role(s) only** — i.e. ``models.*`` (D-029). Detection is NEVER touched:
  the bundled config pins ``detection`` reasoning off because reasoning disturbs
  the 2-stage detection profile (D-029), so this override must not re-enable it.
  ``max``/``xhigh``/``high``/``medium``/``low``/``minimal`` replace fix-role
  reasoning with ``{effort: <value>}``; ``off`` replaces it with
  ``{enabled: false}``. Unset
  leaves the YAML value untouched. An unrecognized value is ignored (the YAML
  value is kept) and a warning is logged — the bridge still starts.

The applied overrides are also reported (``effective_model`` /
``effective_provider_order``) so /health can surface the实効値.

Security: only model / provider identifiers pass through here. No secret is read
or logged.
"""

from __future__ import annotations

import copy
import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, List, Optional

_log = logging.getLogger(__name__)

# Env var names (kept in one place; mirrored by the extension's env writer).
CONFIG_PATH_ENV = "CREPAIR_CONFIG_PATH"
MODEL_ID_ENV = "CREPAIR_MODEL_ID"
PROVIDER_ORDER_ENV = "CREPAIR_PROVIDER_ORDER"
ALLOW_FALLBACKS_ENV = "CREPAIR_ALLOW_FALLBACKS"
REASONING_EFFORT_ENV = "CREPAIR_REASONING_EFFORT"
PROVIDER_POLICY_ENV = "CREPAIR_PROVIDER_POLICY"

# Accepted provider-policy values (D-019 follow-up). ``private-cheap`` maps to the
# ZDR + cheapest-first provider preference; ``balanced`` applies no preference.
_PROVIDER_POLICY_PRIVATE_CHEAP = "private-cheap"
_PROVIDER_POLICY_BALANCED = "balanced"
_PROVIDER_POLICIES = (_PROVIDER_POLICY_PRIVATE_CHEAP, _PROVIDER_POLICY_BALANCED)

# The OpenRouter provider preference for ``private-cheap`` (implemented per the
# OpenRouter provider-preferences spec): Zero-Data-Retention endpoints only, cheapest
# first, with fallbacks allowed so a request can still be served when the top ZDR
# provider is unavailable. Latency is left to OpenRouter's same-tier tie-break.
_PRIVATE_CHEAP_PROVIDER = {"zdr": True, "sort": "price", "allow_fallbacks": True}

# Accepted reasoning effort levels (D-028). ``off`` disables reasoning entirely.
# ``max`` is the nominal top level (near-equivalent to ``xhigh`` on providers that
# honour it) and ``minimal`` the nominal bottom; both are pass-through {effort: <value>}.
_REASONING_EFFORT_LEVELS = ("max", "xhigh", "high", "medium", "low", "minimal")
_REASONING_OFF = "off"


@dataclass(frozen=True)
class EffectiveConfig:
    """A loaded certfix ``Config`` plus the effective model / provider it uses.

    ``provider_order`` is the effective ``extra_body.provider.order`` after
    overrides — an empty list means OpenRouter automatic routing (no pin).
    ``config_source`` is the path the YAML was read from (bundled or user).
    ``reasoning_effort`` is the **fix role's** effective reasoning level (D-029:
    reasoning applies to the repair/validation fix role only): one of
    ``max``/``xhigh``/``high``/``medium``/``low``/``minimal`` when
    ``extra_body.reasoning.effort`` is set, ``off`` when reasoning is disabled
    (``enabled: false``), or ``default``
    when no reasoning is configured at all. ``detection_reasoning`` is the same
    read-back for the detection role, reported separately so /health can show
    that detection reasoning is independent of the fix-role setting (bundled: off,
    D-029).
    """

    config: Any  # certfix.config.Config
    model: str
    provider_order: List[str]
    config_source: str
    reasoning_effort: str
    detection_reasoning: str
    # The effective provider policy (D-019 follow-up): ``private-cheap`` / ``balanced``
    # when a recognized ``CREPAIR_PROVIDER_POLICY`` took effect (order empty), or
    # ``none`` when no policy applied (unset, unrecognized, or an explicit pin won).
    provider_policy: str


def _parse_provider_order(raw: str) -> List[str]:
    """Split a comma-separated provider list, trimming blanks.

    An empty / whitespace-only string yields ``[]`` (the "remove the pin"
    signal). Individual empty items (e.g. a trailing comma) are dropped.
    """
    return [p.strip() for p in raw.split(",") if p.strip()]


def _parse_bool(raw: str) -> Optional[bool]:
    """Parse ``"true"``/``"false"`` (case-insensitive). None when unrecognized."""
    v = raw.strip().lower()
    if v == "true":
        return True
    if v == "false":
        return False
    return None


def _parse_reasoning_effort(raw: str) -> Optional[str]:
    """Normalize a reasoning effort value (D-028), or None when unrecognized.

    Accepts ``max``/``xhigh``/``high``/``medium``/``low``/``minimal``/``off``
    (case-insensitive). An
    unrecognized value returns None; the caller logs a warning and leaves the
    YAML reasoning block untouched (fail-open — the bridge still starts).
    """
    v = raw.strip().lower()
    if v in _REASONING_EFFORT_LEVELS or v == _REASONING_OFF:
        return v
    return None


def _parse_provider_policy(raw: str) -> Optional[str]:
    """Normalize a provider-policy value (D-019 follow-up), or None when unrecognized.

    Accepts ``private-cheap`` / ``balanced`` (case-insensitive). An unrecognized or
    empty value returns None; the caller logs a warning and applies no policy
    (fail-open — OpenRouter default routing, and the bridge still starts).
    """
    v = raw.strip().lower()
    if v in _PROVIDER_POLICIES:
        return v
    return None


def _apply_provider_policy(api: Any, policy: str) -> None:
    """Apply a provider policy to one ``ApiConfig``'s ``extra_body.provider``.

    ``private-cheap`` sets the ZDR + cheapest-first preference (replacing the whole
    provider block so no stale ``order`` survives); ``balanced`` drops any provider
    block entirely (OpenRouter default routing). Only ever called when there is no
    explicit order pin (the caller enforces order-over-policy precedence).
    """
    extra_body = api.extra_body if isinstance(api.extra_body, dict) else {}
    if policy == _PROVIDER_POLICY_PRIVATE_CHEAP:
        extra_body["provider"] = dict(_PRIVATE_CHEAP_PROVIDER)
    else:
        # balanced: no provider preference at all.
        extra_body.pop("provider", None)
    api.extra_body = extra_body


def _apply_reasoning_override(api: Any, effort: str) -> None:
    """Replace ``extra_body.reasoning`` on one ``ApiConfig`` (D-028/D-029).

    ``off`` becomes ``{enabled: false}``; any level becomes ``{effort: <level>}``.
    The whole ``reasoning`` block is replaced (not merged) so a switch between
    ``off`` and an effort level never leaves a stale key behind.

    D-029 scope: only ever called on the **fix role(s)** (``models.*``); detection
    reasoning is fixed off in the bundled config and is never overridden here.
    """
    extra_body = api.extra_body if isinstance(api.extra_body, dict) else {}
    if effort == _REASONING_OFF:
        extra_body["reasoning"] = {"enabled": False}
    else:
        extra_body["reasoning"] = {"effort": effort}
    api.extra_body = extra_body


def _effective_reasoning_effort(api: Any) -> str:
    """Read back the effective reasoning level for /health (D-028).

    Returns the ``effort`` string when set, ``off`` when reasoning is explicitly
    disabled (``enabled: false``), or ``default`` when no reasoning is configured.
    """
    extra_body = api.extra_body if isinstance(api.extra_body, dict) else {}
    reasoning = extra_body.get("reasoning")
    if not isinstance(reasoning, dict):
        return "default"
    effort = reasoning.get("effort")
    if isinstance(effort, str) and effort:
        return effort
    if reasoning.get("enabled") is False:
        return "off"
    return "default"


def _apply_api_overrides(
    api: Any,
    *,
    model_id: Optional[str],
    provider_order: Optional[List[str]],
    allow_fallbacks: Optional[bool],
) -> None:
    """Mutate one certfix ``ApiConfig`` in place with the resolved overrides.

    Handles model / provider only. Reasoning is applied separately by the caller
    (fix roles only, D-029) via ``_apply_reasoning_override``.

    ``provider_order`` is ``None`` when the env var was unset (leave the YAML
    value untouched) or a list (possibly empty = remove the pin). The provider
    block inside ``extra_body`` is only touched when a provider override is
    present, so a config with no ``extra_body`` stays empty by default.
    """
    if model_id is not None:
        api.model = model_id

    if provider_order is None and allow_fallbacks is None:
        return

    # extra_body may be an empty dict on a fresh ApiConfig. Only materialize the
    # provider block when we actually have an override to write.
    extra_body = api.extra_body if isinstance(api.extra_body, dict) else {}
    provider = extra_body.get("provider")
    if not isinstance(provider, dict):
        provider = {}

    if provider_order is not None:
        if provider_order:
            provider["order"] = list(provider_order)
        else:
            # Empty => remove the pin entirely (OpenRouter automatic routing).
            provider.pop("order", None)

    if allow_fallbacks is not None:
        provider["allow_fallbacks"] = allow_fallbacks

    if provider:
        extra_body["provider"] = provider
    else:
        # No provider keys left (order removed, no allow_fallbacks) => drop the
        # empty provider block so the effective config stays minimal.
        extra_body.pop("provider", None)

    api.extra_body = extra_body


def _effective_provider_order(api: Any) -> List[str]:
    """Read back the effective ``extra_body.provider.order`` (``[]`` = automatic)."""
    extra_body = api.extra_body if isinstance(api.extra_body, dict) else {}
    provider = extra_body.get("provider")
    if not isinstance(provider, dict):
        return []
    order = provider.get("order")
    if not isinstance(order, list):
        return []
    return [str(x) for x in order]


def load_effective_config(
    config_path: Path,
    env: Optional[dict[str, str]] = None,
) -> EffectiveConfig:
    """Load the certfix Config and apply ``CREPAIR_*`` env overrides (D-019).

    Args:
        config_path: the bundled config path (used when ``CREPAIR_CONFIG_PATH``
            is unset). Kept as a parameter so the caller owns the default path.
        env: the environment mapping (defaults to ``os.environ``); injectable for
            tests.

    Returns:
        An ``EffectiveConfig`` with the loaded Config and the effective model /
        provider order (for /health).

    When none of the override env vars are set, the returned ``config`` equals
    ``Config.load(config_path)`` with no mutation applied.
    """
    from certfix.config import Config

    env = os.environ if env is None else env

    source_path = Path(env[CONFIG_PATH_ENV]) if env.get(CONFIG_PATH_ENV) else config_path
    cfg = Config.load(source_path)

    model_id = env.get(MODEL_ID_ENV) or None

    # PROVIDER_ORDER: presence (even empty string) is meaningful. Distinguish
    # "unset" (leave YAML) from "" (remove pin).
    provider_order: Optional[List[str]]
    if PROVIDER_ORDER_ENV in env:
        provider_order = _parse_provider_order(env[PROVIDER_ORDER_ENV])
    else:
        provider_order = None

    allow_fallbacks: Optional[bool]
    if ALLOW_FALLBACKS_ENV in env and env[ALLOW_FALLBACKS_ENV].strip():
        allow_fallbacks = _parse_bool(env[ALLOW_FALLBACKS_ENV])
    else:
        allow_fallbacks = None

    # REASONING_EFFORT (D-028): an unrecognized value is ignored (YAML kept) with
    # a warning, so a bad setting never blocks startup.
    reasoning_effort: Optional[str]
    if REASONING_EFFORT_ENV in env and env[REASONING_EFFORT_ENV].strip():
        reasoning_effort = _parse_reasoning_effort(env[REASONING_EFFORT_ENV])
        if reasoning_effort is None:
            _log.warning(
                "Ignoring unrecognized %s=%r (expected one of %s or 'off'); "
                "keeping the bundled reasoning setting.",
                REASONING_EFFORT_ENV,
                env[REASONING_EFFORT_ENV],
                ", ".join(_REASONING_EFFORT_LEVELS),
            )
    else:
        reasoning_effort = None

    # PROVIDER_POLICY (D-019 follow-up): an automatic provider-preference profile used
    # when there is no explicit order pin. An explicit non-empty CREPAIR_PROVIDER_ORDER
    # always wins — the pin owns routing, so the policy is dropped in that case (the
    # extension already refrains from sending the policy alongside a pin, but the bridge
    # enforces the precedence defensively too). An unrecognized value is ignored with a
    # warning (fail-open: default routing).
    provider_policy: Optional[str]
    if PROVIDER_POLICY_ENV in env and env[PROVIDER_POLICY_ENV].strip():
        provider_policy = _parse_provider_policy(env[PROVIDER_POLICY_ENV])
        if provider_policy is None:
            _log.warning(
                "Ignoring unrecognized %s=%r (expected one of %s); "
                "applying no provider policy (default routing).",
                PROVIDER_POLICY_ENV,
                env[PROVIDER_POLICY_ENV],
                ", ".join(_PROVIDER_POLICIES),
            )
    else:
        provider_policy = None

    # An explicit non-empty order pin wins over the policy (order-over-policy). The
    # policy is only ever active with no pin: order unset (None) or explicitly empty.
    has_explicit_pin = provider_order is not None and len(provider_order) > 0
    apply_policy = provider_policy is not None and not has_explicit_pin

    any_override = (
        model_id is not None
        or provider_order is not None
        or allow_fallbacks is not None
        or reasoning_effort is not None
        or apply_policy
    )
    if any_override:
        # Deep-copy so an override never mutates a shared/cached Config instance.
        cfg = copy.deepcopy(cfg)
        # Model / provider apply to detection + every fix role (D-019). Reasoning
        # applies to the fix role(s) ONLY (D-029): detection reasoning is fixed
        # off in the bundled config and must not be re-enabled by this env var.
        _apply_api_overrides(
            cfg.detection.api,
            model_id=model_id,
            provider_order=provider_order,
            allow_fallbacks=allow_fallbacks,
        )
        # Provider policy applies to detection + every fix role, and only with no
        # explicit pin (order-over-policy). It runs AFTER the order/fallback override so
        # it owns the provider block (private-cheap replaces it wholesale; balanced
        # drops it). Detection provider follows fix roles (same identity, D-019).
        if apply_policy:
            _apply_provider_policy(cfg.detection.api, provider_policy)  # type: ignore[arg-type]
        for role in cfg.models.values():
            _apply_api_overrides(
                role.api,
                model_id=model_id,
                provider_order=provider_order,
                allow_fallbacks=allow_fallbacks,
            )
            if reasoning_effort is not None:
                _apply_reasoning_override(role.api, reasoning_effort)
            if apply_policy:
                _apply_provider_policy(role.api, provider_policy)  # type: ignore[arg-type]

    # ``reasoning_effort`` reports the fix role's effective value (D-029); the
    # detection role is reported separately. Read from the first fix role (all
    # roles share the same reasoning setting; the bundled config has one).
    fix_reasoning = "default"
    for role in cfg.models.values():
        fix_reasoning = _effective_reasoning_effort(role.api)
        break

    return EffectiveConfig(
        config=cfg,
        model=cfg.detection.api.model,
        provider_order=_effective_provider_order(cfg.detection.api),
        config_source=str(source_path),
        reasoning_effort=fix_reasoning,
        detection_reasoning=_effective_reasoning_effort(cfg.detection.api),
        # The policy that actually took effect: the parsed value when it applied (no
        # explicit pin), else "none" (unset, unrecognized, or an explicit pin won).
        provider_policy=provider_policy if apply_policy else "none",
    )
