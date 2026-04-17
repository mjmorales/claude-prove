#!/usr/bin/env python3
"""PostToolUse hook — validates .prove/runs JSON writes against their schema.

Fires on ``Write``/``Edit`` tool calls. If the written file lives under
``.prove/runs/**/`` and matches a known schema kind (prd/plan/state/report),
the file is parsed and validated. Schema errors surface as a hook error
string via ``hookSpecificOutput`` so Claude sees them and can self-correct.

Non-matching writes are ignored (the hook exits 0 silently).
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

from tools.run_state.schemas import infer_kind  # noqa: E402
from tools.run_state.validate import validate_file  # noqa: E402


def _is_run_artifact(file_path: str) -> bool:
    # Normalize and require ``.prove/runs/`` in the path
    normalized = file_path.replace("\\", "/")
    return "/.prove/runs/" in normalized


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
    if not file_path or not _is_run_artifact(file_path):
        return

    kind = infer_kind(file_path)
    if kind is None:
        # Not a schema-tracked artifact (e.g., reports/legacy-run-log.md). Ignore.
        return

    if not os.path.exists(file_path):
        # File disappeared — nothing to validate
        return

    _, errors = validate_file(file_path, kind=kind)
    hard = [e for e in errors if e.severity == "error"]
    if not hard:
        return

    # Build a human-readable error message
    msg_lines = [f"Schema validation failed for {os.path.basename(file_path)} ({kind}):"]
    for e in hard:
        msg_lines.append(f"  - {e.path}: {e.message}")
    msg_lines.append(
        "Fix the file or revert. state.json must be mutated via "
        "`python3 -m tools.run_state step|validator|task ...`."
    )
    message = "\n".join(msg_lines)

    # Block / surface the error to Claude
    json.dump(
        {
            "hookSpecificOutput": {
                "hookEventName": "PostToolUse",
                "additionalContext": message,
            },
            "decision": "block",
            "reason": message,
        },
        sys.stdout,
    )


if __name__ == "__main__":
    main()
