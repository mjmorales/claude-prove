"""File index cache I/O — shared by CAFI and PCD."""

from __future__ import annotations

import json
import os
import tempfile

CACHE_VERSION = 1


def load_cache(cache_path: str) -> dict:
    """Load the file index cache from disk, or return an empty cache."""
    try:
        with open(cache_path, "r") as f:
            data = json.load(f)
        if isinstance(data, dict) and data.get("version") == CACHE_VERSION:
            return data
    except (OSError, json.JSONDecodeError, KeyError):
        pass
    return {"version": CACHE_VERSION, "files": {}}


def save_cache(cache_path: str, cache: dict) -> None:
    """Write cache to disk atomically using a temp file + rename."""
    cache_dir = os.path.dirname(cache_path)
    if cache_dir:
        os.makedirs(cache_dir, exist_ok=True)

    fd, tmp_path = tempfile.mkstemp(
        dir=cache_dir or ".", suffix=".tmp", prefix=".file-index-"
    )
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(cache, f, indent=2, sort_keys=True)
            f.write("\n")
        os.replace(tmp_path, cache_path)
    except BaseException:  # Catch KeyboardInterrupt etc. to ensure temp file cleanup
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise
