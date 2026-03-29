#!/usr/bin/env python3
"""Prove tool registry — manage tool installation, hooks, and lifecycle.

Usage::

    python3 tools/registry.py list
    python3 tools/registry.py install acb
    python3 tools/registry.py remove acb
    python3 tools/registry.py status [tool]
    python3 tools/registry.py available
"""

from __future__ import annotations

import argparse
import importlib
import json
import os
import sys
from pathlib import Path


# ---------------------------------------------------------------------------
# Path resolution
# ---------------------------------------------------------------------------

def _find_plugin_root() -> Path:
    """Walk up from this file to find the plugin root (contains .claude/.prove.json)."""
    current = Path(__file__).resolve().parent
    while current != current.parent:
        if (current / ".claude" / ".prove.json").exists():
            return current
        current = current.parent
    # Fallback: assume tools/ is one level below plugin root.
    return Path(__file__).resolve().parent.parent


def _tools_dir(plugin_root: Path) -> Path:
    return plugin_root / "tools"


def _prove_json_path(project_root: Path) -> Path:
    return project_root / ".claude" / ".prove.json"


def _settings_json_path(project_root: Path) -> Path:
    return project_root / ".claude" / "settings.json"


# ---------------------------------------------------------------------------
# Hook variable expansion
# ---------------------------------------------------------------------------

def _expand_hook_vars(entry: dict, plugin_root: Path, project_root: Path) -> dict:
    """Expand $PLUGIN_DIR and $PROJECT_ROOT in hook command strings."""
    result = dict(entry)
    for key in ("command",):
        if key in result and isinstance(result[key], str):
            result[key] = (
                result[key]
                .replace("$PLUGIN_DIR", str(plugin_root))
                .replace("$PROJECT_ROOT", str(project_root))
            )
    return result


# ---------------------------------------------------------------------------
# Low-level I/O helpers
# ---------------------------------------------------------------------------

def _read_json(path: Path) -> dict:
    with open(path) as f:
        return json.load(f)


def _write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")


def _read_prove_json(project_root: Path) -> dict:
    path = _prove_json_path(project_root)
    if not path.exists():
        print(
            f"Error: {path} not found. Run /prove:init first.",
            file=sys.stderr,
        )
        sys.exit(1)
    return _read_json(path)


def _read_settings_json(project_root: Path) -> dict:
    path = _settings_json_path(project_root)
    if not path.exists():
        return {}
    return _read_json(path)


# ---------------------------------------------------------------------------
# Scanning
# ---------------------------------------------------------------------------

def scan_tool_manifests(plugin_root: Path) -> dict[str, dict]:
    """Return {name: manifest} for every tools/*/tool.json found."""
    manifests: dict[str, dict] = {}
    tdir = _tools_dir(plugin_root)
    if not tdir.is_dir():
        return manifests
    for child in sorted(tdir.iterdir()):
        manifest_path = child / "tool.json"
        if child.is_dir() and manifest_path.exists():
            manifest = _read_json(manifest_path)
            manifests[manifest["name"]] = manifest
    return manifests


# ---------------------------------------------------------------------------
# list
# ---------------------------------------------------------------------------

def cmd_list(args: argparse.Namespace) -> None:
    plugin_root = Path(args.plugin_root)
    project_root = Path(args.project_root)

    manifests = scan_tool_manifests(plugin_root)
    prove = _read_prove_json(project_root)
    tools_section = prove.get("tools", {})

    rows: list[dict] = []
    for name, manifest in manifests.items():
        enabled = name in tools_section and tools_section[name].get("enabled", False)
        hooks_count = sum(
            len(entries)
            for entries in manifest.get("hooks", {}).values()
        )
        provides = manifest.get("provides", {})
        commands_count = len(provides.get("commands", []))
        rows.append({
            "name": name,
            "version": manifest.get("version", "0.0.0"),
            "enabled": enabled,
            "hooks": hooks_count,
            "commands": commands_count,
            "description": manifest.get("description", ""),
        })

    # Machine-readable to stdout.
    json.dump({"tools": rows}, sys.stdout, indent=2)
    print()

    # Human-readable table to stderr.
    if not rows:
        print("No tools found.", file=sys.stderr)
        return
    header = f"{'Name':<16} {'Version':<10} {'Enabled':<9} {'Hooks':<7} {'Cmds':<6} Description"
    print(header, file=sys.stderr)
    print("-" * len(header), file=sys.stderr)
    for r in rows:
        en = "yes" if r["enabled"] else "no"
        print(
            f"{r['name']:<16} {r['version']:<10} {en:<9} {r['hooks']:<7} {r['commands']:<6} {r['description']}",
            file=sys.stderr,
        )


# ---------------------------------------------------------------------------
# install
# ---------------------------------------------------------------------------

def _call_lifecycle(plugin_root: Path, spec: str) -> None:
    """Call a lifecycle function given 'module.path:function_name'."""
    module_path, func_name = spec.rsplit(":", 1)
    # Convert file path to module-style import (tools/acb/lifecycle.py -> tools.acb.lifecycle).
    module_path = module_path.replace("/", ".").removesuffix(".py")
    old_path = sys.path[:]
    try:
        sys.path.insert(0, str(plugin_root))
        mod = importlib.import_module(module_path)
        fn = getattr(mod, func_name)
        fn()
    finally:
        sys.path[:] = old_path


def cmd_install(args: argparse.Namespace) -> None:
    plugin_root = Path(args.plugin_root)
    project_root = Path(args.project_root)
    tool_name = args.tool

    # Load manifest.
    manifest_path = _tools_dir(plugin_root) / tool_name / "tool.json"
    if not manifest_path.exists():
        print(f"Error: no tool.json for '{tool_name}'", file=sys.stderr)
        sys.exit(1)
    manifest = _read_json(manifest_path)

    # --- .claude/.prove.json ---
    prove = _read_prove_json(project_root)
    tools_section = prove.setdefault("tools", {})

    # Build config defaults from schema.
    config_defaults: dict = {}
    for key, schema in manifest.get("config_schema", {}).items():
        if "default" in schema:
            config_defaults[key] = schema["default"]

    tool_entry: dict = {"enabled": True}
    if config_defaults:
        tool_entry["config"] = config_defaults
    tools_section[tool_name] = tool_entry
    _write_json(_prove_json_path(project_root), prove)

    # --- .claude/settings.json ---
    settings = _read_settings_json(project_root)
    hooks_added = 0

    manifest_hooks = manifest.get("hooks", {})
    if manifest_hooks:
        settings_hooks = settings.setdefault("hooks", {})
        for event_name, entries in manifest_hooks.items():
            event_list = settings_hooks.setdefault(event_name, [])
            for entry in entries:
                tagged = _expand_hook_vars(entry, plugin_root, project_root)
                tagged["_tool"] = tool_name
                event_list.append(tagged)
                hooks_added += 1
        _write_json(_settings_json_path(project_root), settings)

    # --- directories ---
    dirs_created = 0
    for d in manifest.get("directories", []):
        dir_path = project_root / d
        if not dir_path.exists():
            dir_path.mkdir(parents=True, exist_ok=True)
            dirs_created += 1

    # --- lifecycle ---
    lifecycle = manifest.get("lifecycle", {})
    if "post_install" in lifecycle:
        try:
            _call_lifecycle(plugin_root, lifecycle["post_install"])
        except Exception as exc:
            print(f"Warning: post_install failed: {exc}", file=sys.stderr)

    result = {
        "installed": tool_name,
        "version": manifest.get("version", "0.0.0"),
        "hooks_added": hooks_added,
        "dirs_created": dirs_created,
    }
    json.dump(result, sys.stdout, indent=2)
    print()
    print(f"Installed {tool_name} v{result['version']}", file=sys.stderr)


# ---------------------------------------------------------------------------
# remove
# ---------------------------------------------------------------------------

def cmd_remove(args: argparse.Namespace) -> None:
    plugin_root = Path(args.plugin_root)
    project_root = Path(args.project_root)
    tool_name = args.tool

    # Load manifest for lifecycle hooks.
    manifest_path = _tools_dir(plugin_root) / tool_name / "tool.json"
    manifest: dict = {}
    if manifest_path.exists():
        manifest = _read_json(manifest_path)

    # --- lifecycle pre_uninstall ---
    lifecycle = manifest.get("lifecycle", {})
    if "pre_uninstall" in lifecycle:
        try:
            _call_lifecycle(plugin_root, lifecycle["pre_uninstall"])
        except Exception as exc:
            print(f"Warning: pre_uninstall failed: {exc}", file=sys.stderr)

    # --- .claude/settings.json: strip tagged hooks ---
    settings = _read_settings_json(project_root)
    hooks_removed = 0
    if "hooks" in settings:
        for event_name in list(settings["hooks"]):
            original = settings["hooks"][event_name]
            filtered = [e for e in original if e.get("_tool") != tool_name]
            hooks_removed += len(original) - len(filtered)
            if filtered:
                settings["hooks"][event_name] = filtered
            else:
                del settings["hooks"][event_name]
        _write_json(_settings_json_path(project_root), settings)

    # --- .claude/.prove.json: remove tool section ---
    prove = _read_prove_json(project_root)
    tools_section = prove.get("tools", {})
    tools_section.pop(tool_name, None)
    _write_json(_prove_json_path(project_root), prove)

    result = {"removed": tool_name, "hooks_removed": hooks_removed}
    json.dump(result, sys.stdout, indent=2)
    print()
    print(f"Removed {tool_name} ({hooks_removed} hooks removed)", file=sys.stderr)


# ---------------------------------------------------------------------------
# status
# ---------------------------------------------------------------------------

def cmd_status(args: argparse.Namespace) -> None:
    plugin_root = Path(args.plugin_root)
    project_root = Path(args.project_root)
    tool_name: str | None = args.tool

    manifests = scan_tool_manifests(plugin_root)
    prove = _read_prove_json(project_root)
    tools_section = prove.get("tools", {})
    settings = _read_settings_json(project_root)

    def _tool_status(name: str) -> dict:
        manifest = manifests.get(name, {})
        prove_entry = tools_section.get(name, {})
        enabled = prove_entry.get("enabled", False)

        # Count hooks in settings.json tagged for this tool.
        active_hooks = 0
        for entries in settings.get("hooks", {}).values():
            for entry in entries:
                if entry.get("_tool") == name:
                    active_hooks += 1

        provides = manifest.get("provides", {})
        return {
            "name": name,
            "version": manifest.get("version", "unknown"),
            "enabled": enabled,
            "config": prove_entry.get("config", {}),
            "active_hooks": active_hooks,
            "provides": provides,
            "requires": manifest.get("requires", []),
            "description": manifest.get("description", ""),
            "has_lifecycle": bool(manifest.get("lifecycle")),
        }

    if tool_name:
        if tool_name not in manifests and tool_name not in tools_section:
            print(f"Error: unknown tool '{tool_name}'", file=sys.stderr)
            sys.exit(1)
        status = _tool_status(tool_name)
        json.dump(status, sys.stdout, indent=2)
        print()
        _print_status_table([status])
    else:
        all_names = sorted(set(manifests) | set(tools_section))
        statuses = [_tool_status(n) for n in all_names]
        json.dump({"tools": statuses}, sys.stdout, indent=2)
        print()
        _print_status_table(statuses)


def _print_status_table(statuses: list[dict]) -> None:
    for s in statuses:
        en = "enabled" if s["enabled"] else "disabled"
        print(f"  {s['name']} v{s['version']} [{en}]", file=sys.stderr)
        if s["config"]:
            print(f"    config: {json.dumps(s['config'])}", file=sys.stderr)
        if s["active_hooks"]:
            print(f"    active hooks: {s['active_hooks']}", file=sys.stderr)
        provides = s.get("provides", {})
        if provides.get("commands"):
            print(f"    commands: {', '.join(provides['commands'])}", file=sys.stderr)
        if provides.get("skills"):
            print(f"    skills: {', '.join(provides['skills'])}", file=sys.stderr)


# ---------------------------------------------------------------------------
# available
# ---------------------------------------------------------------------------

def cmd_available(args: argparse.Namespace) -> None:
    plugin_root = Path(args.plugin_root)
    project_root = Path(args.project_root)

    manifests = scan_tool_manifests(plugin_root)
    prove = _read_prove_json(project_root)
    enabled_tools = set(prove.get("tools", {}).keys())

    available = []
    for name, manifest in manifests.items():
        if name not in enabled_tools:
            available.append({
                "name": name,
                "version": manifest.get("version", "0.0.0"),
                "description": manifest.get("description", ""),
            })

    json.dump({"available": available}, sys.stdout, indent=2)
    print()

    if not available:
        print("All tools are already enabled.", file=sys.stderr)
    else:
        for t in available:
            print(f"  {t['name']} v{t['version']} — {t['description']}", file=sys.stderr)


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> None:
    default_plugin_root = str(_find_plugin_root())
    default_project_root = os.getcwd()

    parser = argparse.ArgumentParser(
        prog="registry",
        description="Prove tool registry — manage tool installation and lifecycle.",
    )
    parser.add_argument(
        "--project-root",
        default=default_project_root,
        help="Project root directory (default: cwd).",
    )
    parser.add_argument(
        "--plugin-root",
        default=default_plugin_root,
        help="Plugin root directory (default: auto-detected).",
    )

    sub = parser.add_subparsers(dest="command")

    # list
    p_list = sub.add_parser("list", help="List all tools and their status.")
    p_list.set_defaults(func=cmd_list)

    # install
    p_install = sub.add_parser("install", help="Install (activate) a tool.")
    p_install.add_argument("tool", help="Tool name (directory under tools/).")
    p_install.set_defaults(func=cmd_install)

    # remove
    p_remove = sub.add_parser("remove", help="Remove (deactivate) a tool.")
    p_remove.add_argument("tool", help="Tool name to remove.")
    p_remove.set_defaults(func=cmd_remove)

    # status
    p_status = sub.add_parser("status", help="Show detailed tool status.")
    p_status.add_argument("tool", nargs="?", default=None, help="Tool name (optional).")
    p_status.set_defaults(func=cmd_status)

    # available
    p_available = sub.add_parser("available", help="Show tools not yet enabled.")
    p_available.set_defaults(func=cmd_available)

    args = parser.parse_args(argv)
    if not args.command:
        parser.print_help()
        sys.exit(1)

    args.func(args)


if __name__ == "__main__":
    main()
