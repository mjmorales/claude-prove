#!/usr/bin/env python3
"""SubagentStop hook — reconcile in_progress steps in the subagent's worktree.

When a worktree implementation subagent finishes, check whether the step
it was working on is still ``in_progress``. If the subagent produced a
new commit on the branch, auto-complete the step with that SHA. If not,
halt it with a diagnostic reason.

Scope is deliberately narrow: we only touch the run that corresponds to
the subagent's CWD (resolved via ``.prove-wt-slug.txt``). Sessions with
no active run, and runs not tied to the subagent's worktree, are left
untouched so this hook never interferes with unrelated work.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

_THIS = Path(__file__).resolve().parent
_REPO = _THIS.parent.parent
if str(_REPO) not in sys.path:
    sys.path.insert(0, str(_REPO))

from tools.run_state import state as state_mod  # noqa: E402
from tools.run_state.state import RunPaths  # noqa: E402


_HALT_REASON = "subagent exited without recording completion; no new commits found"


def _read_marker(path: Path) -> str | None:
    try:
        text = path.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return text or None


_MAX_ANCESTOR_DEPTH = 16  # safety cap when running outside any git repo


def _resolve_slug(cwd: Path) -> str | None:
    """Walk cwd upward for a .prove-wt-slug.txt marker. Stop at repo root.

    Returns fast: typically 1-5 stat() calls. Capped at _MAX_ANCESTOR_DEPTH
    to avoid a long walk when invoked outside any repo.
    """
    for depth, p in enumerate((cwd, *cwd.parents)):
        if depth > _MAX_ANCESTOR_DEPTH:
            break
        marker = p / ".prove-wt-slug.txt"
        if marker.is_file():
            slug = _read_marker(marker)
            if slug:
                return slug
        if (p / ".git").exists():
            break
    return None


def _main_worktree(cwd: Path) -> Path:
    try:
        out = subprocess.check_output(
            ["git", "worktree", "list", "--porcelain"],
            cwd=str(cwd),
            text=True,
            stderr=subprocess.DEVNULL,
        )
    except (subprocess.CalledProcessError, FileNotFoundError):
        return cwd
    for line in out.splitlines():
        if line.startswith("worktree "):
            return Path(line[len("worktree "):].strip())
    return cwd


def _latest_commit(cwd: Path) -> str | None:
    try:
        sha = subprocess.check_output(
            ["git", "rev-parse", "HEAD"],
            cwd=str(cwd),
            text=True,
            stderr=subprocess.DEVNULL,
        ).strip()
        return sha or None
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None


def _new_commits_since(cwd: Path, iso_ts: str) -> bool:
    """True if HEAD's commit timestamp is >= iso_ts.

    Compares via unix epoch seconds to avoid ISO-8601 timezone-offset parsing
    quirks (git's %cI includes a TZ offset while run_state writes ``Z``).
    """
    if not iso_ts:
        return False
    try:
        head_unix = int(
            subprocess.check_output(
                ["git", "log", "-1", "--format=%ct", "HEAD"],
                cwd=str(cwd),
                text=True,
                stderr=subprocess.DEVNULL,
            ).strip()
        )
    except (subprocess.CalledProcessError, FileNotFoundError, ValueError):
        return False

    import datetime as _dt

    try:
        # Accept both "2026-04-17T14:00:00Z" and "+00:00" forms
        normalized = iso_ts.replace("Z", "+00:00")
        started = _dt.datetime.fromisoformat(normalized)
        if started.tzinfo is None:
            started = started.replace(tzinfo=_dt.timezone.utc)
        started_unix = int(started.timestamp())
    except ValueError:
        return False
    return head_unix >= started_unix


def _find_paths(main_root: Path, slug: str) -> tuple[str, RunPaths] | None:
    runs_root = main_root / ".prove" / "runs"
    if not runs_root.exists():
        return None
    for state_path in runs_root.glob(f"*/{slug}/state.json"):
        run_dir = state_path.parent
        branch = run_dir.parent.name
        paths = RunPaths(
            root=run_dir,
            prd=run_dir / "prd.json",
            plan=run_dir / "plan.json",
            state=state_path,
            state_lock=run_dir / "state.json.lock",
            reports_dir=run_dir / "reports",
        )
        return branch, paths
    return None


def main() -> None:
    try:
        hook_input = json.load(sys.stdin)
    except (json.JSONDecodeError, EOFError):
        return

    # Resolve the subagent's cwd and run slug
    cwd = Path(hook_input.get("cwd") or os.getcwd())
    slug = _resolve_slug(cwd)
    if not slug:
        return

    main_root = _main_worktree(cwd)
    found = _find_paths(main_root, slug)
    if not found:
        return
    branch, paths = found

    try:
        state = state_mod.load_state(paths)
    except FileNotFoundError:
        return

    inprogress = state_mod.find_inprogress_steps(state)
    if not inprogress:
        return

    # Narrow to steps whose started_at predates HEAD's commit timestamp.
    # If any new commit lands in the subagent worktree during its lifetime,
    # that counts as productive work and we can auto-complete.
    latest_sha = _latest_commit(cwd)

    scope_ids = {sid for (_tid, sid) in inprogress}
    any_new_commit = False
    for _, sid in inprogress:
        step = next(
            (
                s
                for t in state.get("tasks", [])
                for s in t.get("steps", [])
                if s["id"] == sid
            ),
            None,
        )
        if step and _new_commits_since(cwd, step.get("started_at", "")):
            any_new_commit = True
            break

    changes = state_mod.reconcile(
        paths,
        worktree_latest_commit=(latest_sha if any_new_commit else None),
        scope_step_ids=scope_ids,
        reason_on_halt=_HALT_REASON,
    )

    if not changes:
        return

    lines = [f"run_state: reconciled {branch}/{slug} after subagent stop:"]
    for c in changes:
        lines.append(f"- {c['step_id']} → {c['action']}: {c['detail']}")

    # SubagentStop does not accept hookSpecificOutput; emit as systemMessage
    # so the user sees the reconcile notice. state.json is already updated.
    json.dump({"systemMessage": "\n".join(lines)}, sys.stdout)


if __name__ == "__main__":
    main()
