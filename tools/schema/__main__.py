"""CLI for prove config schema tools.

Usage:
    python3 tools/schema validate [--file PATH] [--strict]
    python3 tools/schema migrate  [--file PATH] [--dry-run]
    python3 tools/schema diff     [--file PATH]
    python3 tools/schema summary
"""

import argparse
import os
import sys
from pathlib import Path

from tools.schema.validate import validate_file
from tools.schema.migrate import apply_migration, plan_migration, detect_version
from tools.schema.diff import config_diff, summary
from tools.schema.schemas import CURRENT_SCHEMA_VERSION


def _guard_plugin_dir() -> None:
    """Error if running against the plugin directory instead of a target project.

    Detects when cwd is inside ~/.claude/ (the plugin install location).
    This prevents accidentally validating/migrating the plugin's own .claude/.prove.json.
    """
    cwd = Path.cwd().resolve()
    claude_dir = Path.home() / ".claude"
    if cwd == claude_dir or claude_dir in cwd.parents:
        print(
            "ERROR: Working directory is inside ~/.claude/ (the plugin install location).\n"
            "Run this command from your project root, not the plugin directory.\n"
            f"  cwd: {cwd}",
            file=sys.stderr,
        )
        sys.exit(2)


def cmd_validate(args: argparse.Namespace) -> int:
    path = args.file or ".claude/.prove.json"
    config, errors = validate_file(path, strict=args.strict)

    if config is None:
        for e in errors:
            print(e)
        return 1

    err_count = sum(1 for e in errors if e.severity == "error")
    warn_count = sum(1 for e in errors if e.severity == "warning")

    if errors:
        for e in errors:
            print(e)
        print()

    if err_count > 0:
        print(f"FAIL: {err_count} error(s), {warn_count} warning(s)")
        return 1

    version = detect_version(config)
    print(f"PASS: {path} is valid (schema v{version}, {warn_count} warning(s))")
    return 0


def cmd_migrate(args: argparse.Namespace) -> int:
    path = args.file or ".claude/.prove.json"

    if args.dry_run:
        import json
        from pathlib import Path

        with open(Path(path)) as f:
            config = json.load(f)

        target, changes = plan_migration(config)

        if not changes:
            print(f"No migration needed — {path} is at schema v{CURRENT_SCHEMA_VERSION}")
            return 0

        print(f"Migration plan for {path} (v{detect_version(config)} -> v{CURRENT_SCHEMA_VERSION}):")
        for c in changes:
            print(c)
        return 0

    backup_path, changes = apply_migration(path)

    if not changes:
        print(f"No migration needed — {path} is at schema v{CURRENT_SCHEMA_VERSION}")
        return 0

    print(f"Migrated {path} (backup: {backup_path}):")
    for c in changes:
        print(c)
    return 0


def cmd_diff(args: argparse.Namespace) -> int:
    path = args.file or ".claude/.prove.json"
    print(config_diff(path))
    return 0


def cmd_summary(args: argparse.Namespace) -> int:
    print(summary())
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Prove config schema validation and migration"
    )
    sub = parser.add_subparsers(dest="command")

    # validate
    p_val = sub.add_parser("validate", help="Validate a config file against schema")
    p_val.add_argument("--file", "-f", help="Config file path (default: .claude/.prove.json)")
    p_val.add_argument(
        "--strict", action="store_true", help="Treat warnings as errors"
    )

    # migrate
    p_mig = sub.add_parser("migrate", help="Migrate config to latest schema version")
    p_mig.add_argument("--file", "-f", help="Config file path (default: .claude/.prove.json)")
    p_mig.add_argument(
        "--dry-run", action="store_true", help="Show plan without applying"
    )

    # diff
    p_diff = sub.add_parser("diff", help="Show diff between current and target config")
    p_diff.add_argument("--file", "-f", help="Config file path (default: .claude/.prove.json)")

    # summary
    sub.add_parser("summary", help="Show combined summary for all config files")

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        return 1

    # Guard: prevent running against plugin directory
    _guard_plugin_dir()

    commands = {
        "validate": cmd_validate,
        "migrate": cmd_migrate,
        "diff": cmd_diff,
        "summary": cmd_summary,
    }

    return commands[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
