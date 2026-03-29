#!/usr/bin/env python3
"""Claude Code PostToolUse hook for ACB intent capture.

Detects ``git commit`` commands in Bash tool results and returns a
message prompting the agent to write an intent manifest.

Skips when the active branch is main or master.

Install in ``.claude/settings.json``::

    {
      "hooks": {
        "PostToolUse": [
          {
            "matcher": "Bash",
            "hooks": [
              {
                "type": "command",
                "command": "python3 $PLUGIN_DIR/tools/acb/hook.py"
              }
            ]
          }
        ]
      }
    }
"""

from __future__ import annotations

import json
import re
import subprocess
import sys


def _current_branch() -> str | None:
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            text=True,
            stderr=subprocess.DEVNULL,
        ).strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None


def _head_short_sha() -> str | None:
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "--short", "HEAD"],
            text=True,
            stderr=subprocess.DEVNULL,
        ).strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None


_COMMIT_RE = re.compile(r"\bgit\s+commit\b")
_SKIP_BRANCHES = {"main", "master"}


def main() -> None:
    try:
        hook_input = json.load(sys.stdin)
    except (json.JSONDecodeError, EOFError):
        return

    tool_name = hook_input.get("tool_name", "")
    if tool_name != "Bash":
        return

    command = hook_input.get("tool_input", {}).get("command", "")
    if not _COMMIT_RE.search(command):
        return

    # Detect failed commits — no point prompting.
    stdout = hook_input.get("tool_result", {}).get("stdout", "")
    stderr = hook_input.get("tool_result", {}).get("stderr", "")
    combined = stdout + stderr
    if "nothing to commit" in combined or "no changes added" in combined:
        return

    branch = _current_branch()
    if branch is None or branch in _SKIP_BRANCHES:
        return

    sha = _head_short_sha()
    if sha is None:
        return

    from acb.templates import render

    message = render("hook_prompt.j2", sha=sha, branch=branch)
    json.dump({"systemMessage": message}, sys.stdout)


if __name__ == "__main__":
    main()
