"""Run-slug resolution for ACB manifests.

A ``run_slug`` ties a manifest to an orchestrator run
(``/prove:full-auto``, ``/prove:autopilot``). Orchestrator-review and
other consumers query manifests by slug to reconstruct per-run
activity.

Discovery order (first match wins):

1. ``PROVE_RUN_SLUG`` environment variable — set by the orchestrator
   when spawning a worktree-agent subprocess.
2. ``<worktree-root>/.prove-wt-slug.txt`` marker written by
   ``manage-worktree.sh create``. Cheapest unambiguous lookup;
   pinned to the worktree itself.
3. Scan ``<main-tree>/.prove/runs/**/plan.json`` and match the
   task's ``worktree.path`` against the current worktree root.
4. ``<worktree-root>/.prove/RUN_SLUG`` marker file. Manual escape hatch.
5. ``None`` — standalone commit outside an orchestrator run.
"""

from __future__ import annotations

import json
import os
from pathlib import Path


_ENV_VAR = "PROVE_RUN_SLUG"
_WT_SLUG_FILE = ".prove-wt-slug.txt"
_MARKER_REL = Path(".prove") / "RUN_SLUG"
_RUNS_REL = Path(".prove") / "runs"


def resolve_run_slug(cwd: str | Path | None = None) -> str | None:
    """Return the current run slug, or None if not inside an orchestrator run."""
    env = os.environ.get(_ENV_VAR, "").strip()
    if env:
        return env

    from acb import _git

    wt = _git.worktree_root(cwd=cwd)
    main = _git.main_worktree_root(cwd=cwd)

    if wt is not None:
        wt_marker = wt / _WT_SLUG_FILE
        if wt_marker.is_file():
            try:
                text = wt_marker.read_text(encoding="utf-8").strip()
            except OSError:
                text = ""
            if text:
                return text

    if main is not None and wt is not None:
        runs_dir = main / _RUNS_REL
        wt_norm = _normalize(wt)
        if runs_dir.is_dir():
            slug = _scan_plans_for_worktree(runs_dir, wt_norm)
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


def _scan_plans_for_worktree(runs_dir: Path, wt_norm: str) -> str | None:
    """Return the slug whose plan.json registers ``wt_norm`` as a worktree."""
    for plan_path in runs_dir.rglob("plan.json"):
        try:
            plan = json.loads(plan_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        for task in plan.get("tasks", []):
            wt = (task.get("worktree") or {}).get("path", "")
            if wt and _normalize(Path(wt)) == wt_norm:
                # Slug = name of directory containing plan.json
                return plan_path.parent.name
    return None


def _normalize(path: Path) -> str:
    """Canonical path string for comparison across symlink/realpath variations."""
    try:
        return str(path.resolve())
    except OSError:
        return str(path)
