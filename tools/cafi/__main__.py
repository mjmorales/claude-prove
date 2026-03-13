#!/usr/bin/env python3
"""CAFI CLI — Content-Addressable File Index."""

from __future__ import annotations

import argparse
import json
import os
import sys

# Add the tools directory to sys.path so we can import cafi as a package.
_cafi_dir = os.path.dirname(os.path.abspath(__file__))
_tools_dir = os.path.dirname(_cafi_dir)
if _tools_dir not in sys.path:
    sys.path.insert(0, _tools_dir)

# Derive project root (two levels up from tools/cafi/)
_project_root = os.path.dirname(_tools_dir)

from cafi import indexer  # noqa: E402


def cmd_index(args: argparse.Namespace) -> None:
    """Run full or incremental index."""
    summary = indexer.build_index(args.project_root, force=args.force)
    print(json.dumps(summary, indent=2))
    errors = summary.get("errors", 0)
    if errors > 0:
        print(
            f"Warning: {errors} files received empty descriptions "
            "(Claude CLI may be unavailable)",
            file=sys.stderr,
        )


def cmd_status(args: argparse.Namespace) -> None:
    """Show status counts."""
    status = indexer.get_status(args.project_root)
    print(json.dumps(status, indent=2))


def cmd_get(args: argparse.Namespace) -> None:
    """Print description for a specific file."""
    desc = indexer.get_description(args.project_root, args.path)
    if desc is None:
        print(f"No description found for: {args.path}", file=sys.stderr)
        sys.exit(1)
    print(desc)


def cmd_clear(args: argparse.Namespace) -> None:
    """Remove cache file."""
    removed = indexer.clear_cache(args.project_root)
    if removed:
        print("Cache cleared.")
    else:
        print("No cache file found.")


def cmd_lookup(args: argparse.Namespace) -> None:
    """Search index by keyword."""
    results = indexer.lookup(args.project_root, args.keyword)
    if not results:
        print(f"No files matching: {args.keyword}", file=sys.stderr)
        sys.exit(1)
    for r in results:
        desc = r["description"] or "(no description)"
        print(f"- `{r['path']}`: {desc}")


def cmd_context(args: argparse.Namespace) -> None:
    """Output formatted context block."""
    output = indexer.format_index_for_context(args.project_root)
    if output:
        print(output, end="")
    else:
        print("No indexed files.", file=sys.stderr)
        sys.exit(1)


def main(argv: list[str] | None = None) -> None:
    """Parse arguments and dispatch to the appropriate subcommand."""
    parser = argparse.ArgumentParser(
        prog="cafi",
        description="Content-Addressable File Index for claude-prove.",
    )
    parser.add_argument(
        "--project-root",
        default=_project_root,
        help="Project root directory (default: auto-detected).",
    )

    subparsers = parser.add_subparsers(dest="command")

    # index
    p_index = subparsers.add_parser("index", help="Run full or incremental index.")
    p_index.add_argument("--force", action="store_true", help="Re-describe all files.")
    p_index.set_defaults(func=cmd_index)

    # status
    p_status = subparsers.add_parser("status", help="Show index status counts.")
    p_status.set_defaults(func=cmd_status)

    # get
    p_get = subparsers.add_parser("get", help="Get description for a file.")
    p_get.add_argument("path", help="Relative file path.")
    p_get.set_defaults(func=cmd_get)

    # lookup
    p_lookup = subparsers.add_parser("lookup", help="Search index by keyword.")
    p_lookup.add_argument("keyword", help="Search term (case-insensitive).")
    p_lookup.set_defaults(func=cmd_lookup)

    # clear
    p_clear = subparsers.add_parser("clear", help="Remove cache file.")
    p_clear.set_defaults(func=cmd_clear)

    # context
    p_context = subparsers.add_parser(
        "context", help="Output formatted context block."
    )
    p_context.set_defaults(func=cmd_context)

    args = parser.parse_args(argv)
    if not args.command:
        parser.print_help()
        sys.exit(1)

    args.func(args)


if __name__ == "__main__":
    main()
