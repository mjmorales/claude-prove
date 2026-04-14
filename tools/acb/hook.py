#!/usr/bin/env python3
"""Claude Code PostToolUse hook for ACB intent capture.

Fires AFTER every successful ``git commit`` Bash call. Resolves the
resulting commit SHA, checks the main-worktree ACB store for a manifest
keyed to that SHA, and — if none exists — blocks the agent with a
``decision: block`` response that prompts it to run
``python3 -m tools.acb save-manifest`` for the real SHA.

Design notes:

* No PreToolUse. Manifests describe what actually landed, so blocking
  before the commit adds race conditions (agent writes a manifest,
  commit fails, stale manifest lingers with a SHA that never existed).
* No ``pending`` placeholder. ``save-manifest`` defaults ``--sha`` to
  ``git rev-parse HEAD`` so every row has a real SHA.
* Writes always land in the main worktree's ``.prove/acb.db``
  (resolved via ``git rev-parse --git-common-dir``) so linked
  worktrees do not fragment the store.

Install in ``.claude/settings.json``::

    {
      "hooks": {
        "PostToolUse": [
          {
            "matcher": "Bash",
            "hooks": [
              {
                "type": "command",
                "if": "Bash(git commit*)",
                "command": "python3 $PLUGIN_DIR/tools/acb/hook.py --workspace-root $CLAUDE_PROJECT_DIR"
              }
            ]
          }
        ]
      }
    }

``--workspace-root`` is required: it pins the ACB store to the main
worktree so commits made from linked worktrees write their manifests
into the same ``.prove/acb.db`` the review tooling reads, and it gets
echoed back into the ``save-manifest`` prompt so the agent's follow-up
command targets the same root regardless of its own cwd.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone

_hook_dir = os.path.dirname(os.path.abspath(__file__))
_tools_dir = os.path.dirname(_hook_dir)
if _tools_dir not in sys.path:
    sys.path.insert(0, _tools_dir)


_COMMIT_RE = re.compile(r"\bgit\s+commit\b")
_SKIP_BRANCHES = {"main", "master"}


def _head_diff_stat(sha: str, cwd: str | None = None) -> str:
    """Return ``git show --stat`` output for *sha*."""
    try:
        return subprocess.check_output(
            ["git", "show", "--stat", "--format=", sha],
            cwd=cwd,
            text=True,
            stderr=subprocess.DEVNULL,
        ).strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return ""


def _manifest_exists(
    store_root: str,
    commit_sha: str,
    run_slug: str | None = None,
) -> bool:
    """Check the main-tree ACB store for a manifest keyed to *commit_sha*.

    When *run_slug* is set, only manifests tagged with that slug count.
    """
    try:
        from acb.store import open_store

        store = open_store(store_root)
        try:
            return store.has_manifest_for_sha(commit_sha, run_slug=run_slug)
        finally:
            store.close()
    except Exception:
        return False


def _commit_succeeded(tool_response: object) -> bool:
    """Best-effort check that the git commit call did not error out.

    Claude Code's Bash PostToolUse payload is not fully standardized
    across versions, so we treat anything that looks like an error as
    a failed commit and skip the hook.
    """
    if not isinstance(tool_response, dict):
        return True
    if tool_response.get("is_error") is True:
        return False
    if tool_response.get("isError") is True:
        return False
    code = tool_response.get("exit_code", tool_response.get("exitCode"))
    if isinstance(code, int) and code != 0:
        return False
    return True


_MANIFEST_PROMPT = """\
ACTION REQUIRED — commit {short_sha} on `{branch}`{slug_clause} has no intent manifest. Your next tool call MUST be this exact Bash invocation (no variations, no prefix commands):

```bash
PYTHONPATH={plugin_dir} python3 -m tools.acb save-manifest --workspace-root {workspace_root} --branch {branch} --sha {sha}{slug_flag} <<'MANIFEST'
{{
  "acb_manifest_version": "0.2",
  "commit_sha": "{sha}",
  "timestamp": "{now_iso}",
  "intent_groups": [
    {{
      "id": "<slug-for-this-group>",
      "title": "<what-this-group-does>",
      "classification": "explicit",
      "file_refs": [
        {{"path": "<path/to/file>", "ranges": ["<start>-<end>"]}}
      ],
      "annotations": [
        {{"id": "ann-1", "type": "judgment_call", "body": "<why-if-non-obvious>"}}
      ]
    }}
  ]
}}
MANIFEST
```

Rules for filling in `intent_groups` (everything else above is fixed — do NOT edit the flags, PYTHONPATH, or JSON keys):
1. One group per logical unit of change. Group related file edits together.
2. Every file in the diff below MUST appear in at least one group's `file_refs`.
3. `classification` ∈ `explicit` (user asked for it), `inferred` (logically required), `speculative` (beyond asked).
4. `ranges` is optional — omit for whole-file changes; use `"<start>-<end>"` for partial.
5. Add a `judgment_call` annotation only for non-obvious decisions; omit `annotations` entirely if none.

Diff for {short_sha}:
```
{diff_stat}
```

Do not run any other command until the manifest is saved. The hook will re-fire on the next commit for its own SHA."""


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--workspace-root",
        required=True,
        help="Absolute path to the main worktree / project root. The ACB "
        "store at <workspace-root>/.prove/acb.db is the single source of "
        "truth; this path is also echoed into the save-manifest prompt.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    args = _parse_args(argv)
    workspace_root = args.workspace_root

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

    if not _commit_succeeded(hook_input.get("tool_response")):
        return

    from acb import _git, _slug

    cwd = hook_input.get("cwd") or os.getcwd()

    branch = _git.current_branch(cwd=cwd)
    if branch is None or branch in _SKIP_BRANCHES:
        return

    sha = _git.head_sha(cwd=cwd)
    if sha is None:
        return

    run_slug = _slug.resolve_run_slug(cwd)

    if _manifest_exists(workspace_root, sha, run_slug=run_slug):
        return

    diff_stat = _head_diff_stat(sha, cwd=cwd)
    plugin_dir = os.path.dirname(_tools_dir)
    now_iso = datetime.now(timezone.utc).isoformat(timespec="seconds")
    message = _MANIFEST_PROMPT.format(
        branch=branch,
        sha=sha,
        short_sha=sha[:12],
        diff_stat=diff_stat or "(no diff stat available)",
        slug_clause=f" (run `{run_slug}`)" if run_slug else "",
        slug_flag=f" --slug {run_slug}" if run_slug else "",
        plugin_dir=plugin_dir,
        workspace_root=workspace_root,
        now_iso=now_iso,
    )

    json.dump({"decision": "block", "reason": message}, sys.stdout)


if __name__ == "__main__":
    main()
