#!/usr/bin/env python3
"""PCD CLI — Progressive Context Distillation pipeline tooling."""

from __future__ import annotations

import argparse
import json
import os
import sys

# Add the tools directory to sys.path so we can import pcd as a package.
_pcd_dir = os.path.dirname(os.path.abspath(__file__))
_tools_dir = os.path.dirname(_pcd_dir)
if _tools_dir not in sys.path:
    sys.path.insert(0, _tools_dir)

# Default project root is the caller's working directory, not the plugin's location.
_project_root = os.getcwd()

# Artifact directory relative to project root.
_PCD_DIR = ".prove/steward/pcd"


def _pcd_path(project_root: str) -> str:
    """Return the absolute path to the PCD artifact directory."""
    return os.path.join(project_root, _PCD_DIR)


def _ensure_pcd_dir(project_root: str) -> str:
    """Create the PCD artifact directory if it doesn't exist and return its path."""
    path = _pcd_path(project_root)
    os.makedirs(path, exist_ok=True)
    return path


# ---------------------------------------------------------------------------
# Subcommand handlers
# ---------------------------------------------------------------------------


def cmd_map(args: argparse.Namespace) -> None:
    """Generate structural map (Round 0a)."""
    from pcd.structural_map import generate_structural_map

    project_root = os.path.abspath(args.project_root)
    pcd_dir = _ensure_pcd_dir(project_root)

    raw_scope: str | None = getattr(args, "scope", None)
    scope: list[str] | None = (
        [s.strip() for s in raw_scope.split(",") if s.strip()]
        if raw_scope
        else None
    )
    structural_map = generate_structural_map(project_root, scope)

    out_path = os.path.join(pcd_dir, "structural-map.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(structural_map, f, indent=2)

    # Machine-readable output to stdout.
    print(json.dumps(structural_map, indent=2))

    # Human-readable summary to stderr.
    summary = structural_map.get("summary", {})
    clusters = structural_map.get("clusters", [])
    edges = structural_map.get("dependency_edges", [])
    languages = summary.get("languages", {})
    lang_parts = [f"{lang}: {count}" for lang, count in sorted(languages.items())]
    print(
        f"Structural map: {summary.get('total_files', 0)} files, "
        f"{', '.join(lang_parts) if lang_parts else 'no languages detected'}, "
        f"{len(clusters)} clusters, {len(edges)} edges",
        file=sys.stderr,
    )
    print(f"Written to {out_path}", file=sys.stderr)


def cmd_collapse(args: argparse.Namespace) -> None:
    """Collapse triage manifest."""
    from pcd.collapse import collapse_manifest

    project_root = os.path.abspath(args.project_root)
    pcd_dir = _ensure_pcd_dir(project_root)

    manifest_path = os.path.join(pcd_dir, "triage-manifest.json")
    if not os.path.isfile(manifest_path):
        print(f"Error: triage manifest not found: {manifest_path}", file=sys.stderr)
        sys.exit(1)

    with open(manifest_path, encoding="utf-8") as f:
        manifest = json.load(f)

    token_budget: int = getattr(args, "token_budget", 8000)
    collapsed = collapse_manifest(manifest, token_budget)

    out_path = os.path.join(pcd_dir, "collapsed-manifest.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(collapsed, f, indent=2)

    # Machine-readable output to stdout.
    print(json.dumps(collapsed, indent=2))

    # Human-readable summary to stderr.
    stats = collapsed.get("stats", {})
    print(
        f"Collapse: {stats.get('total_cards', 0)} total cards, "
        f"{stats.get('preserved', 0)} preserved, "
        f"{stats.get('collapsed', 0)} collapsed, "
        f"compression ratio {stats.get('compression_ratio', 0):.2f}",
        file=sys.stderr,
    )
    print(f"Written to {out_path}", file=sys.stderr)


def cmd_batch(args: argparse.Namespace) -> None:
    """Form Round 2 review batches."""
    from pcd.batch_former import form_batches

    project_root = os.path.abspath(args.project_root)
    pcd_dir = _ensure_pcd_dir(project_root)

    collapsed_path = os.path.join(pcd_dir, "collapsed-manifest.json")
    struct_map_path = os.path.join(pcd_dir, "structural-map.json")

    if not os.path.isfile(collapsed_path):
        print(
            f"Error: collapsed manifest not found: {collapsed_path}",
            file=sys.stderr,
        )
        sys.exit(1)
    if not os.path.isfile(struct_map_path):
        print(
            f"Error: structural map not found: {struct_map_path}",
            file=sys.stderr,
        )
        sys.exit(1)

    with open(collapsed_path, encoding="utf-8") as f:
        collapsed = json.load(f)
    with open(struct_map_path, encoding="utf-8") as f:
        structural_map = json.load(f)

    max_files: int = getattr(args, "max_files", 15)
    batches = form_batches(collapsed, structural_map, max_files)

    out_path = os.path.join(pcd_dir, "batch-definitions.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(batches, f, indent=2)

    # Machine-readable output to stdout.
    print(json.dumps(batches, indent=2))

    # Human-readable summary to stderr.
    batch_list = batches if isinstance(batches, list) else batches.get("batches", [])
    files_per_batch = [len(b.get("files", [])) for b in batch_list]
    total_tokens = sum(b.get("estimated_tokens", 0) for b in batch_list)
    print(
        f"Batches: {len(batch_list)} batches, "
        f"files per batch: {files_per_batch}, "
        f"total estimated tokens: {total_tokens}",
        file=sys.stderr,
    )
    print(f"Written to {out_path}", file=sys.stderr)


def cmd_status(args: argparse.Namespace) -> None:
    """Show pipeline status."""
    project_root = os.path.abspath(args.project_root)
    pcd_dir = _pcd_path(project_root)

    status_path = os.path.join(pcd_dir, "pipeline-status.json")

    if os.path.isfile(status_path):
        with open(status_path, encoding="utf-8") as f:
            status = json.load(f)
        # Machine-readable output to stdout.
        print(json.dumps(status, indent=2))

        # Human-readable round-by-round table to stderr.
        print("Pipeline status:", file=sys.stderr)
        rounds = status.get("rounds", {})
        for round_name, round_data in sorted(rounds.items()):
            if isinstance(round_data, dict):
                state = round_data.get("status", "unknown")
                print(f"  {round_name}: {state}", file=sys.stderr)
            else:
                print(f"  {round_name}: {round_data}", file=sys.stderr)
        return

    # No status file — report which artifacts exist.
    artifacts = {
        "structural-map.json": "Round 0a (structural map)",
        "triage-manifest.json": "Round 1 (triage)",
        "collapsed-manifest.json": "Round 1b (collapse)",
        "batch-definitions.json": "Round 2 (batch formation)",
    }
    found: dict[str, str] = {}
    missing: dict[str, str] = {}
    for filename, label in artifacts.items():
        path = os.path.join(pcd_dir, filename)
        if os.path.isfile(path):
            found[filename] = label
        else:
            missing[filename] = label

    report = {"found": found, "missing": missing}
    # Machine-readable output to stdout.
    print(json.dumps(report, indent=2))

    # Human-readable summary to stderr.
    print("No pipeline-status.json found. Artifact check:", file=sys.stderr)
    for filename, label in artifacts.items():
        marker = "OK" if filename in found else "MISSING"
        print(f"  [{marker}] {label} ({filename})", file=sys.stderr)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> None:
    """Parse arguments and dispatch to the appropriate subcommand."""
    parser = argparse.ArgumentParser(
        prog="pcd",
        description="Progressive Context Distillation pipeline tooling.",
    )
    parser.add_argument(
        "--project-root",
        default=_project_root,
        help="Project root directory (default: cwd).",
    )

    subparsers = parser.add_subparsers(dest="command")

    # map
    p_map = subparsers.add_parser("map", help="Generate structural map (Round 0a)")
    p_map.add_argument(
        "--scope",
        default=None,
        help="Comma-separated file list or directory path to restrict analysis",
    )
    p_map.set_defaults(func=cmd_map)

    # collapse
    p_collapse = subparsers.add_parser("collapse", help="Collapse triage manifest")
    p_collapse.add_argument(
        "--token-budget",
        type=int,
        default=8000,
        dest="token_budget",
        help="Approximate token target (default: 8000)",
    )
    p_collapse.set_defaults(func=cmd_collapse)

    # batch
    p_batch = subparsers.add_parser("batch", help="Form Round 2 review batches")
    p_batch.add_argument(
        "--max-files",
        type=int,
        default=15,
        dest="max_files",
        help="Max files per batch (default: 15)",
    )
    p_batch.set_defaults(func=cmd_batch)

    # status
    p_status = subparsers.add_parser("status", help="Show pipeline status")
    p_status.set_defaults(func=cmd_status)

    args = parser.parse_args(argv)
    if not args.command:
        parser.print_help()
        sys.exit(1)

    abs_root = os.path.abspath(args.project_root)
    print(f"PCD: project_root={abs_root}", file=sys.stderr)

    try:
        args.func(args)
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
