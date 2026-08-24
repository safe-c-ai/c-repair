"""CertFix in-process adapter package."""

from repair_api.adapter.certfix_adapter import (
    ADAPTER_ID,
    ADAPTER_VERSION,
    RULE_PROFILE_ID,
    RULE_PROFILE_VERSION,
    run_scan,
)

__all__ = [
    "ADAPTER_ID",
    "ADAPTER_VERSION",
    "RULE_PROFILE_ID",
    "RULE_PROFILE_VERSION",
    "run_scan",
]
