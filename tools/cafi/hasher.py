"""File hasher and cache manager for CAFI.

Computes SHA256 hashes and diffs against a cached file index to
identify new, stale, deleted, and unchanged files.

File walking, cache I/O, and binary detection live in ``_lib`` (shared
with PCD). This module re-exports them for backwards compatibility.
"""

from __future__ import annotations

import hashlib
import os

# Re-export shared utilities so existing imports (tests, __main__) keep working.
from _lib.cache import CACHE_VERSION, load_cache, save_cache  # noqa: F401
from _lib.file_walker import (  # noqa: F401
    DEFAULT_MAX_FILE_SIZE,
    _git_check_ignore,
    _matches_any,
    is_binary,
    walk_project,
)


def compute_hash(file_path: str) -> str:
    """Compute SHA256 hex digest of a file."""
    h = hashlib.sha256()
    with open(file_path, "rb") as f:
        while True:
            chunk = f.read(8192)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def diff_cache(
    current_files: dict[str, str],
    cache: dict,
) -> tuple[list[str], list[str], list[str], list[str]]:
    """Compare current file hashes against the cached index.

    Args:
        current_files: mapping of relative path -> sha256 hex digest
        cache: the full cache dict (with "version" and "files" keys)

    Returns:
        Tuple of (new, stale, deleted, unchanged) lists of relative paths.
    """
    cached_files = cache.get("files", {})

    current_set = set(current_files.keys())
    cached_set = set(cached_files.keys())

    new = sorted(current_set - cached_set)
    deleted = sorted(cached_set - current_set)

    stale = []
    unchanged = []
    for path in sorted(current_set & cached_set):
        if current_files[path] != cached_files[path].get("hash"):
            stale.append(path)
        else:
            unchanged.append(path)

    return new, stale, deleted, unchanged
