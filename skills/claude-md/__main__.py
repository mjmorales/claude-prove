#!/usr/bin/env python3
"""CLAUDE.md generator CLI.

Usage:
    python3 skills/claude-md/__main__.py generate [--project-root DIR] [--plugin-dir DIR]
    python3 skills/claude-md/__main__.py scan [--project-root DIR] [--plugin-dir DIR]
    python3 skills/claude-md/__main__.py subagent-context [--project-root DIR] [--plugin-dir DIR]
"""

from __future__ import annotations

import argparse
import json
import os
import sys

# Add this skill's directory to path for sibling imports
_skill_dir = os.path.dirname(os.path.abspath(__file__))
_skills_dir = os.path.dirname(_skill_dir)
if _skill_dir not in sys.path:
    sys.path.insert(0, _skill_dir)

# Derive defaults
_project_root = os.path.dirname(_skills_dir)  # plugin root, not target project
_plugin_dir = _project_root


def _add_common_args(parser: argparse.ArgumentParser) -> None:
    """Add --project-root and --plugin-dir to a subparser."""
    parser.add_argument(
        "--project-root",
        default=os.getcwd(),
        help="Target project root (default: cwd).",
    )
    parser.add_argument(
        "--plugin-dir",
        default=_plugin_dir,
        help="Path to the prove plugin directory.",
    )


def cmd_generate(args: argparse.Namespace) -> None:
    """Scan project and generate CLAUDE.md."""
    from scanner import scan_project
    from composer import compose, write_claude_md

    scan = scan_project(args.project_root, args.plugin_dir)
    content = compose(scan, args.plugin_dir)
    path = write_claude_md(args.project_root, content)
    print(json.dumps({
        "status": "generated",
        "path": path,
        "sections": _count_sections(content),
    }, indent=2))


def cmd_scan(args: argparse.Namespace) -> None:
    """Run scanner only and output results as JSON."""
    from scanner import scan_project

    scan = scan_project(args.project_root, args.plugin_dir)
    print(json.dumps(scan, indent=2))


def cmd_subagent_context(args: argparse.Namespace) -> None:
    """Generate compact context block for subagent prompt injection."""
    from scanner import scan_project
    from composer import compose_subagent_context

    scan = scan_project(args.project_root, args.plugin_dir)
    print(compose_subagent_context(scan, args.plugin_dir))


def _count_sections(content: str) -> int:
    """Count ## sections in generated content."""
    return sum(1 for line in content.splitlines() if line.startswith("## "))


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        prog="claude-md",
        description="Generate LLM-optimized CLAUDE.md for a project.",
    )

    subparsers = parser.add_subparsers(dest="command")

    p_gen = subparsers.add_parser("generate", help="Generate CLAUDE.md.")
    _add_common_args(p_gen)
    p_gen.set_defaults(func=cmd_generate)

    p_scan = subparsers.add_parser("scan", help="Scan project and output JSON.")
    _add_common_args(p_scan)
    p_scan.set_defaults(func=cmd_scan)

    p_ctx = subparsers.add_parser(
        "subagent-context", help="Output compact context for subagent prompts."
    )
    _add_common_args(p_ctx)
    p_ctx.set_defaults(func=cmd_subagent_context)

    args = parser.parse_args(argv)
    if not args.command:
        parser.print_help()
        sys.exit(1)

    args.func(args)


if __name__ == "__main__":
    main()
