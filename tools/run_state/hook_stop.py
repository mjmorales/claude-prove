#!/usr/bin/env python3
"""Stop hook — reconcile in_progress steps before the session ends.

Any step left in ``in_progress`` when the user's top-level session
terminates is halted with a diagnostic reason. This prevents stale
state: a fresh session always sees either an accurate in-flight run
or a clean halt, never a ghost step that was never closed out.

Runs across every active run under ``$CLAUDE_PROJECT_DIR/.prove/runs/``.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

_THIS = Path(__file__).resolve().parent
_REPO = _THIS.parent.parent
if str(_REPO) not in sys.path:
    sys.path.insert(0, str(_REPO))

from tools.run_state import state as state_mod  # noqa: E402
from tools.run_state.state import RunPaths  # noqa: E402


_HALT_REASON = "session ended with step still in_progress — no completion recorded"


def _iter_active_runs(runs_root: Path):
    if not runs_root.exists():
        return
    for state_path in runs_root.rglob("state.json"):
        try:
            data = json.loads(state_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if data.get("kind") != "state":
            continue
        if data.get("run_status") in ("completed",):
            continue
        run_dir = state_path.parent
        slug = run_dir.name
        branch = run_dir.parent.name
        paths = RunPaths(
            root=run_dir,
            prd=run_dir / "prd.json",
            plan=run_dir / "plan.json",
            state=state_path,
            state_lock=run_dir / "state.json.lock",
            reports_dir=run_dir / "reports",
        )
        yield branch, slug, paths


def main() -> None:
    try:
        hook_input = json.load(sys.stdin)
    except (json.JSONDecodeError, EOFError):
        hook_input = {}

    project = hook_input.get("cwd") or os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
    runs_root = Path(project) / ".prove" / "runs"

    # Fast path — vastly more common than having an active orchestrator run
    if not runs_root.is_dir():
        return

    all_changes: list[dict] = []
    for branch, slug, paths in _iter_active_runs(runs_root):
        changes = state_mod.reconcile(paths, reason_on_halt=_HALT_REASON)
        for c in changes:
            all_changes.append({"branch": branch, "slug": slug, **c})

    if not all_changes:
        return

    lines = ["run_state: reconciled in_progress steps at session end:"]
    for c in all_changes:
        lines.append(f"- {c['branch']}/{c['slug']} {c['step_id']} → {c['action']}: {c['detail']}")

    # Stop hook does not accept hookSpecificOutput; use systemMessage for a
    # user-visible notice. State is already persisted — next session's
    # SessionStart hook surfaces the halted runs via additionalContext.
    json.dump({"systemMessage": "\n".join(lines)}, sys.stdout)


if __name__ == "__main__":
    main()
