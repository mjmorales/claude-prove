#!/usr/bin/env python3
"""PreToolUse hook — blocks direct Write/Edit on state.json.

``state.json`` is the hot-path run state file. All mutations must go
through the blessed CLI::

    python3 -m tools.run_state step start <id>
    python3 -m tools.run_state step complete <id>
    python3 -m tools.run_state validator set <step> <phase> <status>
    python3 -m tools.run_state task review <id> --verdict ...

Direct edits bypass the transition invariants (illegal status jumps,
missing timestamps, dispatch dedup) that the CLI enforces.

To override in exceptional cases, set ``RUN_STATE_ALLOW_DIRECT=1``.
"""

from __future__ import annotations

import json
import os
import sys


def _is_state_file(path: str) -> bool:
    normalized = path.replace("\\", "/")
    return normalized.endswith("/state.json") and "/.prove/runs/" in normalized


def main() -> None:
    try:
        hook_input = json.load(sys.stdin)
    except (json.JSONDecodeError, EOFError):
        return

    tool_name = hook_input.get("tool_name", "")
    if tool_name not in ("Write", "Edit", "MultiEdit"):
        return

    tool_input = hook_input.get("tool_input") or {}
    file_path = tool_input.get("file_path") or ""
    if not file_path or not _is_state_file(file_path):
        return

    if os.environ.get("RUN_STATE_ALLOW_DIRECT") == "1":
        return

    message = (
        f"Direct edits to {file_path} are blocked. "
        "Use `python3 -m tools.run_state step|validator|task|dispatch ...` to mutate state.json. "
        "Set RUN_STATE_ALLOW_DIRECT=1 only for emergency manual recovery."
    )

    json.dump(
        {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": message,
            }
        },
        sys.stdout,
    )


if __name__ == "__main__":
    main()
