"""Run-slug resolution for ACB manifests.

A ``run_slug`` ties a manifest to an orchestrator run
(``/prove:full-auto``, ``/prove:autopilot``). Orchestrator-review and
other consumers query manifests by slug to reconstruct per-run
activity.

Discovery order (first match wins):

1. ``PROVE_RUN_SLUG`` environment variable — set by the orchestrator
   when spawning a worktree-agent subprocess.
2. Explicit registration at ``<main-tree>/.prove/runs/<slug>/worktree``
   whose contents match the current worktree root. Cheapest
   unambiguous lookup; preferred for orchestrator integration.
3. Parse ``<main-tree>/.prove/runs/<slug>/TASK_PLAN.md`` and match its
   ``**Worktree:**`` field against the current worktree root.
   Zero-config fallback that reuses data the orchestrator already
   writes.
4. ``<worktree-root>/.prove/RUN_SLUG`` marker file. Manual escape hatch.
5. ``None`` — standalone commit outside an orchestrator run.
"""

from __future__ import annotations

import os
import re
from pathlib import Path


_ENV_VAR = "PROVE_RUN_SLUG"
_MARKER_REL = Path(".prove") / "RUN_SLUG"
_RUNS_REL = Path(".prove") / "runs"
_WORKTREE_FILE = "worktree"
_TASK_PLAN = "TASK_PLAN.md"

# Matches `**Worktree:** <path>`, tolerant of surrounding whitespace and
# optional trailing fields. Captures the path verbatim; callers
# normalize before comparing.
_WORKTREE_RE = re.compile(r"^\*\*Worktree:\*\*\s*(.+?)\s*$", re.MULTILINE)


def resolve_run_slug(cwd: str | Path | None = None) -> str | None:
    """Return the current run slug, or None if not inside an orchestrator run.

    See module docstring for the resolution order.
    """
    env = os.environ.get(_ENV_VAR, "").strip()
    if env:
        return env

    from acb import _git

    wt = _git.worktree_root(cwd=cwd)
    main = _git.main_worktree_root(cwd=cwd)

    if main is not None and wt is not None:
        runs_dir = main / _RUNS_REL
        wt_norm = _normalize(wt)
        if runs_dir.is_dir():
            for entry in sorted(runs_dir.iterdir()):
                if not entry.is_dir():
                    continue
                slug = _match_run_dir(entry, wt_norm)
                if slug is not None:
                    return slug

    root = Path(cwd) if cwd is not None else (wt if wt is not None else Path.cwd())
    marker = root / _MARKER_REL
    if marker.is_file():
        try:
            text = marker.read_text(encoding="utf-8").strip()
        except OSError:
            return None
        if text:
            return text

    return None


def _match_run_dir(run_dir: Path, wt_norm: str) -> str | None:
    """Return the run slug if *run_dir* registers *wt_norm*, else None."""
    worktree_file = run_dir / _WORKTREE_FILE
    if worktree_file.is_file():
        try:
            declared = worktree_file.read_text(encoding="utf-8").strip()
        except OSError:
            declared = ""
        if declared and _normalize(Path(declared)) == wt_norm:
            return run_dir.name

    task_plan = run_dir / _TASK_PLAN
    if task_plan.is_file():
        try:
            content = task_plan.read_text(encoding="utf-8")
        except OSError:
            return None
        for match in _WORKTREE_RE.finditer(content):
            declared = match.group(1).strip()
            if declared and _normalize(Path(declared)) == wt_norm:
                return run_dir.name

    return None


def _normalize(path: Path) -> str:
    """Canonical path string for comparison across symlink/realpath variations."""
    try:
        return str(path.resolve())
    except OSError:
        return str(path)
