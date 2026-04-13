#!/usr/bin/env python3
"""Claude Code PreToolUse hook for ACB intent capture.

Intercepts ``git commit`` Bash commands BEFORE they execute and checks
whether an intent manifest already exists for the staged changes.  If
not, it blocks the commit and instructs the agent to write the manifest
first.

Install in ``.claude/settings.json``::

    {
      "hooks": {
        "PreToolUse": [
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
import os
import re
import subprocess
import sys

# Set up import path for acb package.
_hook_dir = os.path.dirname(os.path.abspath(__file__))
_tools_dir = os.path.dirname(_hook_dir)
if _tools_dir not in sys.path:
    sys.path.insert(0, _tools_dir)


def _current_branch() -> str | None:
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            text=True,
            stderr=subprocess.DEVNULL,
        ).strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None


def _staged_diff_stat() -> str:
    """Return ``git diff --cached --stat`` output for the staged changes."""
    try:
        return subprocess.check_output(
            ["git", "diff", "--cached", "--stat"],
            text=True,
            stderr=subprocess.DEVNULL,
        ).strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return ""


def _manifest_exists(project_root: str, branch: str) -> bool:
    """Check if any pending intent manifest exists for *branch* in the store."""
    try:
        from acb.store import open_store
        store = open_store(project_root)
        result = store.has_manifest(branch)
        store.close()
        return result
    except Exception:
        return False


_COMMIT_RE = re.compile(r"\bgit\s+commit\b")
_SKIP_BRANCHES = {"main", "master"}


# -- Inline prompt template ---------------------------------------------------

_MANIFEST_PROMPT = """\
Write the intent manifest before committing.

**Staged changes ({branch}):**
```
{diff_stat}
```

**Save via CLI:**
```bash
PYTHONPATH="$PLUGIN_DIR" python3 -m tools.acb save-manifest --branch {branch} --sha pending <<'MANIFEST'
{{
  "acb_manifest_version": "0.2",
  "commit_sha": "pending",
  "timestamp": "<ISO-8601>",
  "intent_groups": [
    {{
      "id": "short-slug",
      "title": "What this group of changes does",
      "classification": "explicit",
      "file_refs": [
        {{"path": "src/example.py", "ranges": ["10-25", "40-42"]}}
      ],
      "annotations": [
        {{"id": "ann-1", "type": "judgment_call", "body": "Why you made a non-obvious decision"}}
      ]
    }}
  ]
}}
MANIFEST
```

**Classification values:** `explicit` (directly requested), `inferred` (logically required), `speculative` (beyond requested).

**Rules:**
1. One intent group per logical unit of change. Group related file edits together.
2. Every changed file must appear in at least one group's `file_refs`.
3. Add a `judgment_call` annotation for any non-trivial design decision or deviation from instructions.
4. Use `ranges` to specify affected line ranges. Omit `ranges` for whole-file changes.

Save the manifest via the CLI command above, then re-run your commit."""


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

    branch = _current_branch()
    if branch is None or branch in _SKIP_BRANCHES:
        return

    project_root = hook_input.get("cwd", os.getcwd())

    # If a manifest already exists for this branch, allow the commit through.
    if _manifest_exists(project_root, branch):
        return

    diff_stat = _staged_diff_stat()
    if not diff_stat:
        # Nothing staged — let git commit fail naturally.
        return

    message = _MANIFEST_PROMPT.format(branch=branch, diff_stat=diff_stat)

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
