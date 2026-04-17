#!/usr/bin/env python3
"""SessionStart hook — print active run summary at session resume.

Reads ``$CLAUDE_PROJECT_DIR/.prove/runs/<branch>/<slug>/state.json`` for
every run under the project and emits a compact summary via
``hookSpecificOutput.additionalContext`` so Claude inherits awareness of
in-flight work.

Safe to run when no runs exist — outputs nothing.
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


def _collect_active_runs(runs_root: Path) -> list[dict]:
    if not runs_root.exists():
        return []
    found: list[dict] = []
    for state_path in runs_root.rglob("state.json"):
        try:
            with open(state_path, encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, json.JSONDecodeError):
            continue
        if data.get("kind") != "state":
            continue
        if data.get("run_status") in ("completed",):
            continue
        found.append(data)
    return found


def _format(active: list[dict]) -> str:
    lines: list[str] = ["Active .prove runs:"]
    for s in active:
        lines.append(
            f"- {s.get('branch', '?')}/{s.get('slug', '?')}: "
            f"{s.get('run_status', '?')}"
            + (f" @ {s.get('current_step')}" if s.get("current_step") else "")
        )
    return "\n".join(lines)


def main() -> None:
    try:
        hook_input = json.load(sys.stdin)
    except (json.JSONDecodeError, EOFError):
        hook_input = {}

    project = hook_input.get("cwd") or os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
    runs_root = Path(project) / ".prove" / "runs"

    active = _collect_active_runs(runs_root)
    if not active:
        return

    json.dump(
        {
            "hookSpecificOutput": {
                "hookEventName": "SessionStart",
                "additionalContext": _format(active),
            }
        },
        sys.stdout,
    )


if __name__ == "__main__":
    main()
