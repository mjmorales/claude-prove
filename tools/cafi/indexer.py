"""Index manager — ties hasher and describer together."""

from __future__ import annotations

import json
import logging
import os
import sys

from cafi.describer import describe_files, triage_files
from cafi.hasher import (
    compute_hash,
    diff_cache,
    load_cache,
    save_cache,
    walk_project,
)

logger = logging.getLogger(__name__)

CACHE_FILENAME = "file-index.json"

DEFAULT_CONFIG = {
    "excludes": [],
    "max_file_size": 102400,
    "concurrency": 3,
    "batch_size": 25,
    "triage": True,
}


class MissingConfigError(Exception):
    """Raised when .claude/.prove.json is not found and CAFI cannot proceed."""


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
                f"CAFI requires a .claude/.prove.json config to run."
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


def _cache_path(project_root: str) -> str:
    """Return the absolute path to the cache file."""
    return os.path.join(project_root, ".prove", CACHE_FILENAME)


def build_index(project_root: str, force: bool = False) -> dict:
    """Run a full or incremental index build.

    1. Load config from ``.claude/.prove.json``
    2. Walk the project to discover files
    3. Compute SHA-256 hashes for each file
    4. Diff against the existing cache
    5. Describe new/stale files via the Claude CLI
    6. Merge results into the cache and persist

    Args:
        project_root: The project root directory.
        force: If True, re-describe every file regardless of cache state.

    Returns:
        Summary dict with counts: ``new``, ``stale``, ``deleted``,
        ``unchanged``, ``total``.
    """
    config = load_config(project_root)
    files = walk_project(
        project_root,
        excludes=config["excludes"],
        max_file_size=config["max_file_size"],
    )

    # Triage: let Claude filter the file list to only index-worthy files
    if config.get("triage", True):
        files = triage_files(files)

    current_hashes: dict[str, str] = {}
    for fp in files:
        full_path = os.path.join(project_root, fp)
        current_hashes[fp] = compute_hash(full_path)

    cache = load_cache(_cache_path(project_root))
    new, stale, deleted, unchanged = diff_cache(current_hashes, cache)

    if force:
        # Treat every current file as needing re-description
        to_describe = list(current_hashes.keys())
        stale = [f for f in current_hashes if f not in new]
        unchanged = []
    else:
        to_describe = new + stale

    # Generate descriptions for new/stale files
    def _progress(done: int, total: int, path: str) -> None:
        print(f"\r  [{done}/{total}] {path}", end="", file=sys.stderr, flush=True)
        if done == total:
            print(file=sys.stderr)

    if to_describe:
        descriptions = describe_files(
            to_describe,
            project_root,
            concurrency=config["concurrency"],
            batch_size=config["batch_size"],
            on_progress=_progress,
        )
    else:
        descriptions = {}

    # Count files that received empty descriptions (CLI failures)
    error_count = sum(1 for fp in to_describe if not descriptions.get(fp))

    # Merge into cache
    cached_files = cache.get("files", {})

    # Remove deleted entries
    for fp in deleted:
        cached_files.pop(fp, None)

    # Update new and stale entries
    for fp in to_describe:
        cached_files[fp] = {
            "hash": current_hashes[fp],
            "description": descriptions.get(fp, ""),
        }

    # Ensure unchanged entries still have their hash up-to-date
    for fp in unchanged:
        if fp in cached_files:
            cached_files[fp]["hash"] = current_hashes[fp]

    cache["files"] = cached_files
    save_cache(_cache_path(project_root), cache)

    return {
        "new": len(new),
        "stale": len(stale),
        "deleted": len(deleted),
        "unchanged": len(unchanged),
        "total": len(current_hashes),
        "errors": error_count,
    }


def get_status(project_root: str) -> dict:
    """Quick status check without running descriptions.

    Args:
        project_root: The project root directory.

    Returns:
        Dict with counts ``new``, ``stale``, ``deleted``, ``unchanged``,
        and ``cache_exists`` boolean.
    """
    config = load_config(project_root)
    files = walk_project(
        project_root,
        excludes=config["excludes"],
        max_file_size=config["max_file_size"],
    )

    current_hashes: dict[str, str] = {}
    for fp in files:
        full_path = os.path.join(project_root, fp)
        current_hashes[fp] = compute_hash(full_path)

    cp = _cache_path(project_root)
    cache = load_cache(cp)
    new, stale, deleted, unchanged = diff_cache(current_hashes, cache)

    return {
        "new": len(new),
        "stale": len(stale),
        "deleted": len(deleted),
        "unchanged": len(unchanged),
        "cache_exists": os.path.isfile(cp),
    }


def get_description(project_root: str, file_path: str) -> str | None:
    """Look up the cached description for a single file.

    Args:
        project_root: The project root directory.
        file_path: Relative path to the file.

    Returns:
        The description string, or None if not in cache.
    """
    cache = load_cache(_cache_path(project_root))
    entry = cache.get("files", {}).get(file_path)
    if entry is None:
        return None
    return entry.get("description")


def clear_cache(project_root: str) -> bool:
    """Delete the cache file.

    Args:
        project_root: The project root directory.

    Returns:
        True if the file existed and was deleted, False otherwise.
    """
    cp = _cache_path(project_root)
    if os.path.isfile(cp):
        os.remove(cp)
        return True
    return False


def lookup(project_root: str, keyword: str) -> list[dict]:
    """Search the file index by keyword, matching against paths and descriptions.

    Args:
        project_root: The project root directory.
        keyword: Search term (case-insensitive). Matches against file paths
                 and routing-hint descriptions.

    Returns:
        List of dicts with ``path`` and ``description`` for matching files,
        sorted by path.
    """
    cache = load_cache(_cache_path(project_root))
    files = cache.get("files", {})
    if not files:
        return []

    keyword_lower = keyword.lower()
    results: list[dict] = []

    for path in sorted(files.keys()):
        entry = files[path]
        desc = entry.get("description", "")
        if keyword_lower in path.lower() or keyword_lower in desc.lower():
            results.append({"path": path, "description": desc})

    return results


def format_index_for_context(project_root: str) -> str:
    """Format all cached descriptions as a compact Markdown block.

    This output is intended for injection into the session context so
    that the LLM agent knows which files exist and when to read them.

    Args:
        project_root: The project root directory.

    Returns:
        Markdown-formatted string, or an empty string if no cache exists.
    """
    cache = load_cache(_cache_path(project_root))
    files = cache.get("files", {})
    if not files:
        return ""

    lines = ["# Project File Index", ""]
    for path in sorted(files.keys()):
        desc = files[path].get("description", "")
        if desc:
            lines.append(f"- `{path}`: {desc}")
        else:
            lines.append(f"- `{path}`: (no description)")

    return "\n".join(lines) + "\n"
