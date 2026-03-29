"""Project config loader — shared by CAFI and PCD.

Reads file scanning configuration from .claude/.prove.json.
"""

from __future__ import annotations

import json
import logging
import os

logger = logging.getLogger(__name__)

DEFAULT_CONFIG = {
    "excludes": [],
    "max_file_size": 102400,
    "concurrency": 3,
    "batch_size": 25,
    "triage": True,
}


class MissingConfigError(Exception):
    """Raised when .claude/.prove.json is not found and the tool cannot proceed."""


def load_config(project_root: str, require: bool = True) -> dict:
    """Read index config from ``.claude/.prove.json`` under the ``"index"`` key.

    Args:
        project_root: The project root directory.
        require: If True (default), raise ``MissingConfigError`` when
            ``.claude/.prove.json`` is absent. If False, fall back to defaults.

    Returns:
        Config dict with keys ``excludes``, ``max_file_size``, ``concurrency``.
        Falls back to defaults for any missing keys.

    Raises:
        MissingConfigError: If ``require`` is True and ``.claude/.prove.json`` is absent.
    """
    config_path = os.path.join(project_root, ".claude", ".prove.json")
    result = dict(DEFAULT_CONFIG)

    if not os.path.isfile(config_path):
        if require:
            raise MissingConfigError(
                f"No .claude/.prove.json found.\n"
                f"  Project root: {os.path.abspath(project_root)}\n"
                f"  Expected config: {os.path.abspath(config_path)}\n"
                f"Config is required to run."
            )
        return result

    try:
        with open(config_path, "r") as fh:
            data = json.load(fh)
        index_cfg = data.get("index", {})
        for key in DEFAULT_CONFIG:
            if key in index_cfg:
                result[key] = index_cfg[key]
    except (json.JSONDecodeError, OSError) as exc:
        logger.warning("Could not read config from %s: %s", config_path, exc)

    return result
