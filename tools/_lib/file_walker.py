"""Project file walker — shared by CAFI and PCD.

Walks the project tree respecting .gitignore, binary detection,
size limits, and exclude patterns.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import PurePath

DEFAULT_MAX_FILE_SIZE = 102400  # 100KB


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
