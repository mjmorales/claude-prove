"""File hasher and cache manager for CAFI.

Walks the project tree, computes SHA256 hashes, and diffs against
a cached file index to identify new, stale, deleted, and unchanged files.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import tempfile
from pathlib import PurePath

CACHE_VERSION = 1
DEFAULT_MAX_FILE_SIZE = 102400  # 100KB


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


def is_binary(file_path: str) -> bool:
    """Check whether a file is binary by looking for null bytes in the first 8KB."""
    try:
        with open(file_path, "rb") as f:
            chunk = f.read(8192)
            return b"\x00" in chunk
    except OSError:
        return True


def _git_ls_files(root: str) -> set[str] | None:
    """Return the set of tracked files via git ls-files, or None if not a git repo."""
    try:
        result = subprocess.run(
            ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
            cwd=root,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0:
            return None
        files = set()
        for line in result.stdout.strip().splitlines():
            line = line.strip()
            if line:
                files.add(line)
        return files
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None


def _git_check_ignore(root: str, paths: list[str]) -> set[str]:
    """Return the subset of *paths* that are gitignored.

    Uses ``git check-ignore --stdin`` which respects all .gitignore
    layers (repo, global, nested), even for tracked-but-ignored files.
    Returns an empty set if git is unavailable.
    """
    if not paths:
        return set()
    try:
        result = subprocess.run(
            ["git", "check-ignore", "--stdin"],
            cwd=root,
            input="\n".join(paths),
            capture_output=True,
            text=True,
            timeout=30,
        )
        # Exit 0 = some ignored, exit 1 = none ignored, other = error
        if result.returncode not in (0, 1):
            return set()
        ignored = set()
        for line in result.stdout.strip().splitlines():
            line = line.strip()
            if line:
                ignored.add(line)
        return ignored
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return set()


def _normalize_pattern(pattern: str) -> str:
    """Normalize an exclude pattern for use with PurePath.full_match().

    - Bare directory names (``dist``, ``client/addons/gut``) → ``**/dist/**``, etc.
    - Trailing-slash directories (``dist/``) → ``dist/**``
    - Simple extension globs (``*.log``) → ``**/*.log``
    - Patterns already containing ``**`` or ``/`` with wildcards pass through.
    """
    stripped = pattern.rstrip("/")

    # Bare directory name — no wildcards at all
    if not any(c in stripped for c in "*?["):
        if "/" in stripped:
            # Rooted directory like client/addons/gut → match anything under it
            return stripped + "/**"
        # Top-level name like dist → match anywhere in tree
        return "**/" + stripped + "/**"

    # Trailing-slash directory with wildcards (unusual but handle it)
    if pattern.endswith("/"):
        return stripped + "/**"

    # Simple basename glob like *.log — match at any depth
    if "/" not in pattern:
        return "**/" + pattern

    return pattern


def _matches_any(path: str, patterns: list[str]) -> bool:
    """Check if a relative path matches any of the given glob patterns.

    Uses PurePath.full_match() with normalized patterns for recursive
    directory matching.  Bare directory names, extension globs, and
    ``**`` patterns are all supported.
    """
    p = PurePath(path)
    for pattern in patterns:
        if p.full_match(_normalize_pattern(pattern)):
            return True
    return False


def walk_project(
    root: str,
    excludes: list[str] | None = None,
    max_file_size: int = DEFAULT_MAX_FILE_SIZE,
) -> list[str]:
    """Walk the project tree and return eligible file paths (relative to root).

    Respects .gitignore via git ls-files, skips binary files, files over
    max_file_size, the .prove/ directory, and any extra exclude patterns.
    """
    root = os.path.abspath(root)
    excludes = excludes or []
    result = []

    git_files = _git_ls_files(root)

    if git_files is not None:
        # Use git's list — --exclude-standard filters untracked files but
        # not tracked-then-ignored ones, so we post-filter with check-ignore.
        candidates = sorted(git_files)
    else:
        # Fallback: walk the filesystem manually
        candidates = []
        for dirpath, dirnames, filenames in os.walk(root):
            # Skip hidden dirs and .prove
            dirnames[:] = [
                d for d in dirnames
                if not d.startswith(".") and d != ".prove"
            ]
            for fname in filenames:
                full = os.path.join(dirpath, fname)
                rel = os.path.relpath(full, root)
                candidates.append(rel)
        candidates.sort()

    # Filter out anything matched by .gitignore (covers tracked-but-ignored
    # files that git ls-files --exclude-standard misses, and also handles
    # the non-git fallback path when git is still available).
    ignored = _git_check_ignore(root, candidates)
    if ignored:
        candidates = [c for c in candidates if c not in ignored]

    for rel_path in candidates:
        # Skip .prove directory and .claude/.prove.json config
        if rel_path.startswith(".prove") or rel_path.startswith(os.sep + ".prove"):
            continue
        if rel_path == os.path.join(".claude", ".prove.json"):
            continue

        # Skip if matches exclude patterns
        if _matches_any(rel_path, excludes):
            continue

        full_path = os.path.join(root, rel_path)

        # Skip if file doesn't exist (e.g. deleted but still in git index)
        if not os.path.isfile(full_path):
            continue

        # Skip if over size limit
        try:
            if os.path.getsize(full_path) > max_file_size:
                continue
        except OSError:
            continue

        # Skip binary files
        if is_binary(full_path):
            continue

        result.append(rel_path)

    return result


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
        # Clean up temp file on failure
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise
