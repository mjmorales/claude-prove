#!/usr/bin/env python3
"""ACB v2 CLI — assemble manifests, serve review UI, generate prompts.

Usage::

    python3 -m tools.acb assemble --intents-dir .prove/intents --base main
    python3 -m tools.acb serve --acb .prove/reviews/branch.acb.json
    python3 -m tools.acb fix --acb .prove/reviews/branch.acb.json
    python3 -m tools.acb discuss --acb .prove/reviews/branch.acb.json
    python3 -m tools.acb resolve --acb .prove/reviews/branch.acb.json
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


def _branch_slug() -> str:
    try:
        branch = subprocess.check_output(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            text=True,
            stderr=subprocess.DEVNULL,
        ).strip()
        return branch.replace("/", "-").replace(" ", "-")
    except subprocess.CalledProcessError:
        return "unknown"


def cmd_assemble(args: argparse.Namespace) -> None:
    from acb.assembler import assemble

    intents_dir = args.intents_dir
    if not os.path.isdir(intents_dir):
        print(f"Error: intents directory not found: {intents_dir}", file=sys.stderr)
        sys.exit(1)

    base_sha = _resolve_base_ref(args.base)
    head_sha = _resolve_head_ref()

    acb = assemble(
        intents_dir=intents_dir,
        base_ref=base_sha,
        head_ref=head_sha,
    )

    # Write to output path.
    out_dir = args.output_dir
    os.makedirs(out_dir, exist_ok=True)
    slug = _branch_slug()
    out_path = os.path.join(out_dir, f"{slug}.acb.json")
    with open(out_path, "w") as f:
        json.dump(acb, f, indent=2)
        f.write("\n")

    n_groups = len(acb.get("intent_groups", []))
    n_manifests = acb.get("manifest_count", 0)
    n_uncovered = len(acb.get("uncovered_files", []))
    print(f"Assembled {n_manifests} manifests → {n_groups} intent groups", file=sys.stderr)
    if n_uncovered:
        print(f"  {n_uncovered} files not covered by any manifest", file=sys.stderr)
    print(f"Written to: {out_path}", file=sys.stderr)

    # Machine-readable output.
    json.dump({"path": out_path, "groups": n_groups, "uncovered": n_uncovered}, sys.stdout)
    print()


def cmd_serve(args: argparse.Namespace) -> None:
    from acb.server import serve

    acb_path = args.acb
    if not os.path.isfile(acb_path):
        print(f"Error: ACB file not found: {acb_path}", file=sys.stderr)
        sys.exit(1)

    review_path = acb_path.replace(".acb.json", ".review.json")
    project_root = args.project_root or os.getcwd()

    serve(
        acb_path=acb_path,
        review_path=review_path,
        project_root=project_root,
        base_ref=args.base,
        port=args.port,
    )


def _load_acb_and_review(acb_path: str) -> tuple[dict, dict]:
    """Load an ACB and its companion review state."""
    from acb.server import _empty_review

    if not os.path.isfile(acb_path):
        print(f"Error: ACB file not found: {acb_path}", file=sys.stderr)
        sys.exit(1)

    with open(acb_path) as f:
        acb = json.load(f)

    review_path = acb_path.replace(".acb.json", ".review.json")
    try:
        with open(review_path) as f:
            review = json.load(f)
    except (OSError, json.JSONDecodeError):
        review = _empty_review(acb)

    return acb, review


def cmd_fix(args: argparse.Namespace) -> None:
    from acb.review_prompts import generate_fix_prompt

    acb, review = _load_acb_and_review(args.acb)
    print(generate_fix_prompt(acb, review))


def cmd_discuss(args: argparse.Namespace) -> None:
    from acb.review_prompts import generate_discuss_prompt

    acb, review = _load_acb_and_review(args.acb)
    print(generate_discuss_prompt(acb, review))


def cmd_resolve(args: argparse.Namespace) -> None:
    from acb.review_prompts import generate_resolve_summary

    acb, review = _load_acb_and_review(args.acb)
    print(generate_resolve_summary(acb, review))


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="acb", description="ACB v2 — intent-based code review")
    sub = parser.add_subparsers(dest="command", required=True)

    # assemble
    p_asm = sub.add_parser("assemble", help="Assemble manifests into an ACB document")
    p_asm.add_argument("--intents-dir", default=".prove/intents", help="Directory of manifest JSON files")
    p_asm.add_argument("--base", default="main", help="Base branch (default: main)")
    p_asm.add_argument("--output-dir", default=".prove/reviews", help="Output directory for ACB")
    p_asm.set_defaults(func=cmd_assemble)

    # serve
    p_srv = sub.add_parser("serve", help="Launch the review UI server")
    p_srv.add_argument("--acb", required=True, help="Path to .acb.json file")
    p_srv.add_argument("--base", default="main", help="Base ref for diffs")
    p_srv.add_argument("--port", type=int, default=0, help="Port (0 = auto)")
    p_srv.add_argument("--project-root", default="", help="Project root for git commands")
    p_srv.set_defaults(func=cmd_serve)

    # fix
    p_fix = sub.add_parser("fix", help="Generate fix prompt from rejected groups")
    p_fix.add_argument("--acb", required=True, help="Path to .acb.json file")
    p_fix.set_defaults(func=cmd_fix)

    # discuss
    p_disc = sub.add_parser("discuss", help="Surface groups needing discussion")
    p_disc.add_argument("--acb", required=True, help="Path to .acb.json file")
    p_disc.set_defaults(func=cmd_discuss)

    # resolve
    p_res = sub.add_parser("resolve", help="Show review approval summary")
    p_res.add_argument("--acb", required=True, help="Path to .acb.json file")
    p_res.set_defaults(func=cmd_resolve)

    args = parser.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
