#!/usr/bin/env python3
"""ACB v2 CLI — save manifests, assemble, serve review UI, generate prompts.

Usage::

    python3 -m tools.acb save-manifest --branch feat/x --sha abc1234 < manifest.json
    python3 -m tools.acb assemble --base main
    python3 -m tools.acb serve --base main
    python3 -m tools.acb fix
    python3 -m tools.acb discuss
    python3 -m tools.acb resolve
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
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "HEAD"], text=True, stderr=subprocess.DEVNULL,
        ).strip()
    except subprocess.CalledProcessError:
        print("Error: cannot resolve HEAD", file=sys.stderr)
        sys.exit(1)


def _current_branch() -> str:
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            text=True,
            stderr=subprocess.DEVNULL,
        ).strip()
    except subprocess.CalledProcessError:
        return "unknown"


# -- save-manifest -----------------------------------------------------------


def cmd_save_manifest(args: argparse.Namespace) -> None:
    branch = args.branch or _current_branch()
    sha = args.sha or "pending"

    try:
        data = json.load(sys.stdin)
    except json.JSONDecodeError as exc:
        print(f"Error: invalid JSON on stdin: {exc}", file=sys.stderr)
        sys.exit(1)

    from acb.schemas import validate_manifest

    errors = validate_manifest(data)
    if errors:
        print(f"Error: invalid manifest: {'; '.join(errors)}", file=sys.stderr)
        sys.exit(1)

    store = open_store(os.getcwd())
    row_id = store.save_manifest(branch, sha, data)
    store.close()

    json.dump({"saved": True, "id": row_id, "branch": branch, "sha": sha}, sys.stdout)
    print()
    print(f"Manifest saved for {branch} (sha: {sha})", file=sys.stderr)


# -- assemble ----------------------------------------------------------------


def cmd_assemble(args: argparse.Namespace) -> None:
    from acb.assembler import assemble

    branch = args.branch or _current_branch()
    base_sha = _resolve_base_ref(args.base)
    head_sha = _resolve_head_ref()

    store = open_store(os.getcwd())
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


# -- serve -------------------------------------------------------------------


def cmd_serve(args: argparse.Namespace) -> None:
    from acb.server import serve

    branch = args.branch or _current_branch()
    project_root = args.project_root or os.getcwd()
    store = open_store(os.getcwd())

    acb = store.load_acb(branch)
    if acb is None:
        print(f"Error: no ACB document for branch '{branch}'", file=sys.stderr)
        store.close()
        sys.exit(1)

    serve(
        store=store,
        branch=branch,
        project_root=project_root,
        base_ref=args.base,
        port=args.port,
    )


# -- fix / discuss / resolve -------------------------------------------------


def _load_acb_and_review(branch: str) -> tuple[dict, dict]:
    """Load an ACB and its companion review state from the store."""
    from acb.server import _empty_review

    store = open_store(os.getcwd())
    acb = store.load_acb(branch)
    if acb is None:
        # Fall back to most recent ACB if branch has none.
        fallback = store.latest_acb_branch()
        if fallback:
            acb = store.load_acb(fallback)
    if acb is None:
        print(f"Error: no ACB document found (branch: {branch})", file=sys.stderr)
        store.close()
        sys.exit(1)

    review = store.load_review(branch) or _empty_review(acb)
    store.close()
    return acb, review


def cmd_fix(args: argparse.Namespace) -> None:
    from acb.review_prompts import generate_fix_prompt

    branch = args.branch or _current_branch()
    acb, review = _load_acb_and_review(branch)
    print(generate_fix_prompt(acb, review))


def cmd_discuss(args: argparse.Namespace) -> None:
    from acb.review_prompts import generate_discuss_prompt

    branch = args.branch or _current_branch()
    acb, review = _load_acb_and_review(branch)
    print(generate_discuss_prompt(acb, review))


def cmd_resolve(args: argparse.Namespace) -> None:
    from acb.review_prompts import generate_resolve_summary

    branch = args.branch or _current_branch()
    acb, review = _load_acb_and_review(branch)
    print(generate_resolve_summary(acb, review))


# -- CLI entry point ---------------------------------------------------------


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="acb", description="ACB v2 — intent-based code review")
    sub = parser.add_subparsers(dest="command", required=True)

    # save-manifest
    p_save = sub.add_parser("save-manifest", help="Save an intent manifest to the store")
    p_save.add_argument("--branch", default="", help="Branch name (default: current)")
    p_save.add_argument("--sha", default="pending", help="Commit SHA (default: pending)")
    p_save.set_defaults(func=cmd_save_manifest)

    # assemble
    p_asm = sub.add_parser("assemble", help="Assemble manifests into an ACB document")
    p_asm.add_argument("--branch", default="", help="Branch name (default: current)")
    p_asm.add_argument("--base", default="main", help="Base branch (default: main)")
    p_asm.set_defaults(func=cmd_assemble)

    # serve
    p_srv = sub.add_parser("serve", help="Launch the review UI server")
    p_srv.add_argument("--branch", default="", help="Branch name (default: current)")
    p_srv.add_argument("--base", default="main", help="Base ref for diffs")
    p_srv.add_argument("--port", type=int, default=0, help="Port (0 = auto)")
    p_srv.add_argument("--project-root", default="", help="Project root for git commands")
    p_srv.set_defaults(func=cmd_serve)

    # fix
    p_fix = sub.add_parser("fix", help="Generate fix prompt from rejected groups")
    p_fix.add_argument("--branch", default="", help="Branch name (default: current)")
    p_fix.set_defaults(func=cmd_fix)

    # discuss
    p_disc = sub.add_parser("discuss", help="Surface groups needing discussion")
    p_disc.add_argument("--branch", default="", help="Branch name (default: current)")
    p_disc.set_defaults(func=cmd_discuss)

    # resolve
    p_res = sub.add_parser("resolve", help="Show review approval summary")
    p_res.add_argument("--branch", default="", help="Branch name (default: current)")
    p_res.set_defaults(func=cmd_resolve)

    args = parser.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
