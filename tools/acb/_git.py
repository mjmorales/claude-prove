"""Git helpers shared by the ACB CLI and hook.

Centralizes resolution of the current branch, HEAD SHA, the current
worktree root, and the main worktree root. ACB always writes to the
main worktree's ``.prove/acb.db`` so that all manifests for a session
are visible from the repository root, regardless of which worktree
produced the commit.

Every helper accepts an optional ``cwd`` so callers that are not
running in the relevant working directory (e.g. the PostToolUse hook,
which is handed a ``cwd`` via the hook event JSON) can scope git
invocations correctly.
"""

from __future__ import annotations

import subprocess
from pathlib import Path


def _git(*args: str, cwd: str | Path | None = None) -> str | None:
    try:
        return subprocess.check_output(
            ["git", *args],
            cwd=str(cwd) if cwd is not None else None,
            text=True,
            stderr=subprocess.DEVNULL,
        ).strip() or None
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None


def current_branch(cwd: str | Path | None = None) -> str | None:
    """Return the current branch name, or None if detached/unknown."""
    out = _git("rev-parse", "--abbrev-ref", "HEAD", cwd=cwd)
    if out is None or out == "HEAD":
        return None
    return out


def head_sha(cwd: str | Path | None = None) -> str | None:
    """Return HEAD as a full SHA, or None if not resolvable."""
    return _git("rev-parse", "HEAD", cwd=cwd)


def worktree_root(cwd: str | Path | None = None) -> Path | None:
    """Return the current worktree root (may be the main worktree or a linked one)."""
    out = _git("rev-parse", "--show-toplevel", cwd=cwd)
    return Path(out) if out else None


def main_worktree_root(cwd: str | Path | None = None) -> Path | None:
    """Return the main worktree root, even when invoked from a linked worktree.

    Uses ``git rev-parse --path-format=absolute --git-common-dir`` which
    returns the shared ``.git`` directory of the repository (the main
    repo's ``.git``, not the linked worktree's ``.git`` file). The
    parent of that path is the main worktree root for non-bare repos.
    Returns ``None`` for bare repos or on any git failure.
    """
    common = _git("rev-parse", "--path-format=absolute", "--git-common-dir", cwd=cwd)
    if not common:
        return None
    p = Path(common)
    if p.name != ".git":
        return None
    return p.parent
