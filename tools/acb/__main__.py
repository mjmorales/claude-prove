#!/usr/bin/env python3
"""ACB v2 CLI — save manifests and assemble intent groups.

Usage::

    python3 -m tools.acb save-manifest --branch feat/x --sha abc1234 < manifest.json
    python3 -m tools.acb assemble --base main

Review UI (verdicts, fix/discuss/resolve prompts) lives in
``tools/review-ui/`` and is launched via ``/prove:review-ui``.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys

_acb_dir = os.path.dirname(os.path.abspath(__file__))
_tools_dir = os.path.dirname(_acb_dir)
if _tools_dir not in sys.path:
    sys.path.insert(0, _tools_dir)

from acb import _git, _slug
from acb.store import open_store


def _resolve_base_ref(base: str) -> str:
    """Resolve a branch name to a full SHA."""
    try:
        return subprocess.check_output(
            ["git", "rev-parse", base], text=True, stderr=subprocess.DEVNULL,
        ).strip()
    except subprocess.CalledProcessError:
        print(f"Error: cannot resolve base ref '{base}'", file=sys.stderr)
        sys.exit(1)


def _resolve_head_ref() -> str:
    sha = _git.head_sha()
    if sha is None:
        print("Error: cannot resolve HEAD", file=sys.stderr)
        sys.exit(1)
    return sha


def _current_branch() -> str:
    return _git.current_branch() or "unknown"


def _store_root(override: str | None = None) -> str:
    """Return the workspace root for store access.

    When *override* is set (``--workspace-root``), it wins unconditionally —
    this is how hook-driven invocations from linked worktrees pin writes
    to the main worktree's ``.prove/acb.db``. Otherwise fall back to
    ``git rev-parse --git-common-dir`` and finally to the current cwd.
    """
    if override:
        return override
    root = _git.main_worktree_root()
    return str(root) if root is not None else os.getcwd()


# -- save-manifest -----------------------------------------------------------


def cmd_save_manifest(args: argparse.Namespace) -> None:
    branch = args.branch or _current_branch()
    sha = args.sha or _resolve_head_ref()
    run_slug = args.slug or _slug.resolve_run_slug(os.getcwd())

    try:
        data = json.load(sys.stdin)
    except json.JSONDecodeError as exc:
        print(f"Error: invalid JSON on stdin: {exc}", file=sys.stderr)
        sys.exit(1)

    # Keep the manifest body consistent with the row's commit_sha.
    data["commit_sha"] = sha

    from acb.schemas import validate_manifest

    errors = validate_manifest(data)
    if errors:
        print(f"Error: invalid manifest: {'; '.join(errors)}", file=sys.stderr)
        sys.exit(1)

    store = open_store(_store_root(override=args.workspace_root))
    row_id = store.save_manifest(branch, sha, data, run_slug=run_slug)
    store.close()

    json.dump(
        {
            "saved": True,
            "id": row_id,
            "branch": branch,
            "sha": sha,
            "run_slug": run_slug,
        },
        sys.stdout,
    )
    print()
    tail = f" run:{run_slug}" if run_slug else ""
    print(f"Manifest saved for {branch} (sha: {sha}){tail}", file=sys.stderr)


# -- assemble ----------------------------------------------------------------


def cmd_assemble(args: argparse.Namespace) -> None:
    from acb.assembler import assemble

    branch = args.branch or _current_branch()
    base_sha = _resolve_base_ref(args.base)
    head_sha = _resolve_head_ref()

    store = open_store(_store_root())
    acb = assemble(
        store=store,
        branch=branch,
        base_ref=base_sha,
        head_ref=head_sha,
    )

    # Save ACB to store.
    store.save_acb(branch, acb)

    # Clean up manifests after assembly.
    cleared = store.clear_manifests(branch)
    store.close()

    n_groups = len(acb.get("intent_groups", []))
    n_manifests = acb.get("manifest_count", 0)
    n_uncovered = len(acb.get("uncovered_files", []))
    print(f"Assembled {n_manifests} manifests → {n_groups} intent groups", file=sys.stderr)
    if n_uncovered:
        print(f"  {n_uncovered} files not covered by any manifest", file=sys.stderr)
    if cleared:
        print(f"  Cleared {cleared} manifests from store", file=sys.stderr)

    # Machine-readable output.
    json.dump({"branch": branch, "groups": n_groups, "uncovered": n_uncovered}, sys.stdout)
    print()


# -- CLI entry point ---------------------------------------------------------


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="acb", description="ACB v2 — intent-based code review")
    sub = parser.add_subparsers(dest="command", required=True)

    # save-manifest
    p_save = sub.add_parser("save-manifest", help="Save an intent manifest to the store")
    p_save.add_argument("--branch", default="", help="Branch name (default: current)")
    p_save.add_argument("--sha", default="", help="Commit SHA (default: current HEAD)")
    p_save.add_argument(
        "--slug",
        default="",
        help="Orchestrator run slug (default: PROVE_RUN_SLUG env or .prove/RUN_SLUG marker)",
    )
    p_save.add_argument(
        "--workspace-root",
        default="",
        help="Absolute path to the main worktree; pins the store to "
        "<workspace-root>/.prove/acb.db regardless of cwd. Required when "
        "invoked from a linked worktree (hook use case).",
    )
    p_save.set_defaults(func=cmd_save_manifest)

    # assemble
    p_asm = sub.add_parser("assemble", help="Assemble manifests into an ACB document")
    p_asm.add_argument("--branch", default="", help="Branch name (default: current)")
    p_asm.add_argument("--base", default="main", help="Base branch (default: main)")
    p_asm.set_defaults(func=cmd_assemble)

    args = parser.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
