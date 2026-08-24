"""Bundled-config resolution tests (V3b round 23).

A wheel-only install (vsix bootstrap venv) has no ``services/repair-api/config``
dev tree — the old dev-relative CONFIG_PATH degenerated to a nonexistent
``lib/python3.10/config/…`` and /health silently reported an empty model. The
resolution is now dev-tree-first with a packaged-resource fallback, and a
missing config is an ERROR log at startup (no silent empty model). Hermetic:
candidates are injected tmp paths; no bridge is started.
"""

from __future__ import annotations

import logging
from pathlib import Path

from repair_api import main as main_mod


def _capture_main_logs(run) -> list:
    """Run ``run()`` with an ERROR-capable capture handler on repair_api.main.

    Attached directly to the module logger (main.py sets propagate=False on the
    ``repair_api`` parent, which would hide records from pytest's caplog).
    """
    records: list = []

    class Capture(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            records.append(record)

    lg = logging.getLogger("repair_api.main")
    handler = Capture()
    old_level = lg.level
    lg.addHandler(handler)
    lg.setLevel(logging.INFO)
    try:
        run()
    finally:
        lg.removeHandler(handler)
        lg.setLevel(old_level)
    return records


def test_dev_tree_config_wins_over_packaged(tmp_path) -> None:
    dev = tmp_path / "dev" / "config.yaml"
    dev.parent.mkdir()
    dev.write_text("detection: {}\n", encoding="utf-8")
    packaged = tmp_path / "pkg" / "config.yaml"
    packaged.parent.mkdir()
    packaged.write_text("detection: {}\n", encoding="utf-8")
    assert main_mod.resolve_bundled_config(dev, packaged) == dev


def test_packaged_resource_is_the_wheel_fallback(tmp_path) -> None:
    dev = tmp_path / "dev" / "config.yaml"  # does not exist (wheel-only layout)
    packaged = tmp_path / "pkg" / "config.yaml"
    packaged.parent.mkdir()
    packaged.write_text("detection: {}\n", encoding="utf-8")
    records = _capture_main_logs(
        lambda: None,
    )
    assert main_mod.resolve_bundled_config(dev, packaged) == packaged
    assert records == []  # a successful fallback is not an error


def test_both_missing_logs_error_no_silent_empty_model(tmp_path) -> None:
    dev = tmp_path / "dev" / "config.yaml"
    packaged = tmp_path / "pkg" / "config.yaml"
    results: list = []
    records = _capture_main_logs(
        lambda: results.append(main_mod.resolve_bundled_config(dev, packaged))
    )
    # Degrades to the dev candidate (nonexistent) but is LOUD about it.
    assert results[0] == dev
    errors = [r for r in records if r.levelno == logging.ERROR]
    assert len(errors) == 1
    assert "bundled config not found" in errors[0].getMessage()
    # None-packaged (importlib resolution unavailable) behaves the same.
    assert main_mod.resolve_bundled_config(dev, None) == dev


def test_live_config_path_resolves_to_an_existing_file() -> None:
    # In the dev tree (this checkout) the module-level CONFIG_PATH must point at
    # the real bundled yaml — the pre-round-23 behaviour, unchanged for dev.
    assert main_mod.CONFIG_PATH.exists()
    assert main_mod.CONFIG_PATH.name == "deepseek-v4-flash-openrouter.yaml"
    assert main_mod.CONFIG_PATH == Path(main_mod.__file__).resolve().parents[2] / "config" / main_mod.CONFIG_PATH.name
