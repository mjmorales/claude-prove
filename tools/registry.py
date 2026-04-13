#!/usr/bin/env python3
"""Prove tool registry — manage tool installation, hooks, and lifecycle.

Usage::

    python3 tools/registry.py list
    python3 tools/registry.py install acb
    python3 tools/registry.py remove acb
    python3 tools/registry.py status [tool]
    python3 tools/registry.py available
    python3 tools/registry.py settings [tool] [--apply|--strip]
"""

from __future__ import annotations

import argparse
import importlib
import json
import os
import sys
from pathlib import Path


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

KIND_LABELS: dict[str, str] = {"tool": "Infrastructure", "pack": "Workflow Packs"}


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
# Symlink management
# ---------------------------------------------------------------------------

SYMLINK_CATEGORIES = ("skills", "agents", "commands")


def _create_symlinks(target_root: Path, tool_dir: Path) -> int:
    """Create relative symlinks from target_root categories into tool subdirectories.

    Scans tool_dir/skills/, tool_dir/agents/, tool_dir/commands/ and creates
    symlinks at target_root/<category>/<child.name> pointing to the tool's copy.
    target_root is plugin_root for user-scoped installs, project_root for
    project-scoped installs.
    Returns the number of symlinks created.
    """
    count = 0
    for category in SYMLINK_CATEGORIES:
        source_dir = tool_dir / category
        if not source_dir.is_dir():
            continue
        target_parent = target_root / category
        target_parent.mkdir(parents=True, exist_ok=True)
        # Resolve real paths to handle filesystem symlinks (e.g. /tmp -> /private/tmp on macOS)
        real_target_parent = Path(os.path.realpath(target_parent))
        for child in sorted(source_dir.iterdir()):
            link_path = target_parent / child.name
            real_child = Path(os.path.realpath(child))
            rel_target = os.path.relpath(real_child, real_target_parent)
            if link_path.exists() or link_path.is_symlink():
                if link_path.is_symlink():
                    existing = os.readlink(str(link_path))
                    if existing == rel_target:
                        continue  # idempotent — already points to the same target
                raise RuntimeError(f"Conflict: {link_path} already exists")
            os.symlink(rel_target, str(link_path))
            count += 1
    return count


def _remove_symlinks(target_root: Path, tool_dir: Path) -> int:
    """Remove symlinks from target_root categories that point into tool_dir.

    Only removes symlinks whose resolved target is inside tool_dir.
    target_root is plugin_root for user-scoped installs, project_root for
    project-scoped installs.
    Returns the number of symlinks removed.
    """
    real_tool_dir = os.path.realpath(tool_dir)
    count = 0
    for category in SYMLINK_CATEGORIES:
        source_dir = tool_dir / category
        if not source_dir.is_dir():
            continue
        target_parent = target_root / category
        if not target_parent.is_dir():
            continue
        for child in sorted(source_dir.iterdir()):
            link_path = target_parent / child.name
            if link_path.is_symlink():
                real_target = os.path.realpath(link_path)
                if real_target.startswith(real_tool_dir + os.sep) or real_target.startswith(real_tool_dir):
                    link_path.unlink()
                    count += 1
    return count


# ---------------------------------------------------------------------------
# Hook variable expansion
# ---------------------------------------------------------------------------

def _expand_hook_vars(entry: dict, plugin_root: Path, project_root: Path) -> dict:
    """Expand $PLUGIN_DIR and $PROJECT_ROOT in hook command strings."""

    def _expand(obj):
        if isinstance(obj, dict):
            return {k: _expand(v) for k, v in obj.items()}
        if isinstance(obj, list):
            return [_expand(item) for item in obj]
        if isinstance(obj, str) and ("$PLUGIN_DIR" in obj or "$PROJECT_ROOT" in obj):
            return obj.replace("$PLUGIN_DIR", str(plugin_root)).replace("$PROJECT_ROOT", str(project_root))
        return obj

    return _expand(entry)


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
            "kind": manifest.get("kind", "tool"),
            "enabled": enabled,
            "hooks": hooks_count,
            "commands": commands_count,
            "description": manifest.get("description", ""),
        })

    # Machine-readable to stdout.
    json.dump({"tools": rows}, sys.stdout, indent=2)
    print()

    # Human-readable table to stderr, grouped by kind.
    if not rows:
        print("No tools found.", file=sys.stderr)
        return
    header = f"  {'Name':<16} {'Version':<10} {'Enabled':<9} {'Hooks':<7} {'Cmds':<6} Description"
    grouped: dict[str, list[dict]] = {}
    for r in rows:
        grouped.setdefault(r["kind"], []).append(r)
    for kind in ("tool", "pack"):
        group = grouped.get(kind)
        if not group:
            continue
        print(f"\n{KIND_LABELS.get(kind, kind)}:", file=sys.stderr)
        print(header, file=sys.stderr)
        print("  " + "-" * (len(header) - 2), file=sys.stderr)
        for r in group:
            en = "yes" if r["enabled"] else "no"
            print(
                f"  {r['name']:<16} {r['version']:<10} {en:<9} {r['hooks']:<7} {r['commands']:<6} {r['description']}",
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


def _resolve_symlink_root(scope: str, plugin_root: Path, project_root: Path) -> Path:
    """Return the root directory where symlinks should be created/removed."""
    if scope == "project":
        return project_root
    return plugin_root


def _check_requires(requires: list[str]) -> list[str]:
    """Validate that required dependencies are available. Return missing ones."""
    import shutil

    missing: list[str] = []
    for dep in requires:
        # Check as executable on PATH first.
        if shutil.which(dep):
            continue
        # Check as importable Python module.
        try:
            importlib.import_module(dep)
        except ImportError:
            missing.append(dep)
    return missing


def cmd_install(args: argparse.Namespace) -> None:
    plugin_root = Path(args.plugin_root)
    project_root = Path(args.project_root)
    tool_name = args.tool
    scope = getattr(args, "scope", "user")

    # Load manifest.
    manifest_path = _tools_dir(plugin_root) / tool_name / "tool.json"
    if not manifest_path.exists():
        print(f"Error: no tool.json for '{tool_name}'", file=sys.stderr)
        sys.exit(1)
    manifest = _read_json(manifest_path)

    # --- dependency validation ---
    requires = manifest.get("requires", [])
    if requires:
        missing = _check_requires(requires)
        if missing:
            print(
                f"Error: missing dependencies for '{tool_name}': {', '.join(missing)}\n"
                f"Install them and retry.",
                file=sys.stderr,
            )
            json.dump({"error": "missing_dependencies", "missing": missing}, sys.stdout)
            print()
            sys.exit(1)

    # --- .claude/.prove.json ---
    prove = _read_prove_json(project_root)
    tools_section = prove.setdefault("tools", {})

    # Build config defaults from schema.
    config_defaults: dict = {}
    for key, schema in manifest.get("config_schema", {}).items():
        if "default" in schema:
            config_defaults[key] = schema["default"]

    tool_entry: dict = {"enabled": True, "scope": scope}
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

    # --- symlinks (packs with skills/agents/commands) ---
    tool_dir = _tools_dir(plugin_root) / tool_name
    symlink_root = _resolve_symlink_root(scope, plugin_root, project_root)
    symlinks_created = _create_symlinks(symlink_root, tool_dir)

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
        "scope": scope,
        "hooks_added": hooks_added,
        "dirs_created": dirs_created,
        "symlinks_created": symlinks_created,
    }
    json.dump(result, sys.stdout, indent=2)
    print()
    print(f"Installed {tool_name} v{result['version']} (scope: {scope})", file=sys.stderr)


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

    # Read scope from .prove.json to know where symlinks live.
    prove = _read_prove_json(project_root)
    scope = prove.get("tools", {}).get(tool_name, {}).get("scope", "user")

    # --- symlinks (remove before lifecycle and config cleanup) ---
    tool_dir = _tools_dir(plugin_root) / tool_name
    symlink_root = _resolve_symlink_root(scope, plugin_root, project_root)
    symlinks_removed = _remove_symlinks(symlink_root, tool_dir)

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

    result = {
        "removed": tool_name,
        "hooks_removed": hooks_removed,
        "symlinks_removed": symlinks_removed,
    }
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
            "kind": manifest.get("kind", "tool"),
            "enabled": enabled,
            "scope": prove_entry.get("scope", "user"),
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
        scope = s.get("scope", "user")
        print(f"  {s['name']} v{s['version']} [{en}, {scope}]", file=sys.stderr)
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
                "kind": manifest.get("kind", "tool"),
                "description": manifest.get("description", ""),
            })

    json.dump({"available": available}, sys.stdout, indent=2)
    print()

    if not available:
        print("All tools are already enabled.", file=sys.stderr)
    else:
        grouped: dict[str, list[dict]] = {}
        for t in available:
            grouped.setdefault(t["kind"], []).append(t)
        for kind in ("tool", "pack"):
            group = grouped.get(kind)
            if not group:
                continue
            print(f"\n{KIND_LABELS.get(kind, kind)}:", file=sys.stderr)
            for t in group:
                print(f"  {t['name']} v{t['version']} — {t['description']}", file=sys.stderr)


# ---------------------------------------------------------------------------
# sync
# ---------------------------------------------------------------------------

def cmd_sync(args: argparse.Namespace) -> None:
    """Reconcile hooks and symlinks for all enabled tools against their manifests.

    For each enabled tool:
    1. Remove all hooks tagged with ``_tool: <name>`` from settings.json
    2. Re-add hooks from the manifest with fresh $PLUGIN_DIR expansion
    3. Reconcile symlinks for packs (remove stale, create missing)

    This fixes drift caused by plugin relocation, manifest changes, or
    manual settings.json edits.
    """
    plugin_root = Path(args.plugin_root)
    project_root = Path(args.project_root)

    manifests = scan_tool_manifests(plugin_root)
    prove = _read_prove_json(project_root)
    tools_section = prove.get("tools", {})
    settings = _read_settings_json(project_root)

    hooks_removed = 0
    hooks_added = 0
    symlinks_removed = 0
    symlinks_created = 0

    # --- Phase 1: Strip ALL tool-tagged hooks ---
    if "hooks" in settings:
        for event_name in list(settings["hooks"]):
            original = settings["hooks"][event_name]
            filtered = [e for e in original if "_tool" not in e]
            hooks_removed += len(original) - len(filtered)
            if filtered:
                settings["hooks"][event_name] = filtered
            else:
                del settings["hooks"][event_name]

    # --- Phase 2: Re-add hooks for enabled tools from manifests ---
    for name, prove_entry in tools_section.items():
        if not prove_entry.get("enabled", False):
            continue
        manifest = manifests.get(name, {})
        manifest_hooks = manifest.get("hooks", {})
        if not manifest_hooks:
            continue
        settings_hooks = settings.setdefault("hooks", {})
        for event_name, entries in manifest_hooks.items():
            event_list = settings_hooks.setdefault(event_name, [])
            for entry in entries:
                tagged = _expand_hook_vars(entry, plugin_root, project_root)
                tagged["_tool"] = name
                event_list.append(tagged)
                hooks_added += 1

    _write_json(_settings_json_path(project_root), settings)

    # --- Phase 3: Reconcile symlinks for packs ---
    for name, prove_entry in tools_section.items():
        if not prove_entry.get("enabled", False):
            continue
        manifest = manifests.get(name, {})
        tool_dir = _tools_dir(plugin_root) / name
        if not tool_dir.is_dir():
            continue

        scope = prove_entry.get("scope", "user")
        symlink_root = _resolve_symlink_root(scope, plugin_root, project_root)

        # Remove stale symlinks, then re-create
        removed = _remove_symlinks(symlink_root, tool_dir)
        symlinks_removed += removed
        try:
            created = _create_symlinks(symlink_root, tool_dir)
            symlinks_created += created
        except RuntimeError as exc:
            print(f"Warning: symlink conflict for {name}: {exc}", file=sys.stderr)

    result = {
        "hooks_removed": hooks_removed,
        "hooks_added": hooks_added,
        "symlinks_removed": symlinks_removed,
        "symlinks_created": symlinks_created,
    }
    json.dump(result, sys.stdout, indent=2)
    print()

    changes = hooks_removed + hooks_added + symlinks_removed + symlinks_created
    if changes == 0:
        print("Already in sync.", file=sys.stderr)
    else:
        print(
            f"Synced: {hooks_removed} hooks removed, {hooks_added} added, "
            f"{symlinks_removed} symlinks removed, {symlinks_created} created",
            file=sys.stderr,
        )


# ---------------------------------------------------------------------------
# settings
# ---------------------------------------------------------------------------

def cmd_settings(args: argparse.Namespace) -> None:
    """Show and manage Claude settings.json hook entries for tools/packs."""
    plugin_root = Path(args.plugin_root)
    project_root = Path(args.project_root)
    tool_name: str | None = args.tool
    do_apply = getattr(args, "apply", False)
    do_strip = getattr(args, "strip", False)

    manifests = scan_tool_manifests(plugin_root)
    prove = _read_prove_json(project_root)
    tools_section = prove.get("tools", {})
    settings = _read_settings_json(project_root)

    def _count_active(name: str) -> int:
        count = 0
        for entries in settings.get("hooks", {}).values():
            for entry in entries:
                if entry.get("_tool") == name:
                    count += 1
        return count

    def _strip(name: str) -> int:
        removed = 0
        if "hooks" not in settings:
            return removed
        for event_name in list(settings["hooks"]):
            original = settings["hooks"][event_name]
            filtered = [e for e in original if e.get("_tool") != name]
            removed += len(original) - len(filtered)
            if filtered:
                settings["hooks"][event_name] = filtered
            else:
                del settings["hooks"][event_name]
        return removed

    def _apply(name: str, manifest_hooks: dict) -> int:
        added = 0
        if not manifest_hooks:
            return added
        settings_hooks = settings.setdefault("hooks", {})
        for event_name, entries in manifest_hooks.items():
            event_list = settings_hooks.setdefault(event_name, [])
            for entry in entries:
                tagged = _expand_hook_vars(entry, plugin_root, project_root)
                tagged["_tool"] = name
                event_list.append(tagged)
                added += 1
        return added

    if tool_name:
        if tool_name not in manifests:
            print(f"Error: unknown tool '{tool_name}'", file=sys.stderr)
            sys.exit(1)

        manifest = manifests[tool_name]
        manifest_hooks = manifest.get("hooks", {})

        if do_apply:
            _strip(tool_name)
            added = _apply(tool_name, manifest_hooks)
            _write_json(_settings_json_path(project_root), settings)
            result = {"tool": tool_name, "action": "apply", "hooks_added": added}
            json.dump(result, sys.stdout, indent=2)
            print()
            print(f"Applied {added} hooks for {tool_name}", file=sys.stderr)
            return

        if do_strip:
            removed = _strip(tool_name)
            _write_json(_settings_json_path(project_root), settings)
            result = {"tool": tool_name, "action": "strip", "hooks_removed": removed}
            json.dump(result, sys.stdout, indent=2)
            print()
            print(f"Stripped {removed} hooks for {tool_name}", file=sys.stderr)
            return

        # Show mode — detail for one tool
        manifest_count = sum(len(v) for v in manifest_hooks.values())
        active_count = _count_active(tool_name)
        active_hooks = []
        for event_name, entries in settings.get("hooks", {}).items():
            for entry in entries:
                if entry.get("_tool") == tool_name:
                    active_hooks.append({"event": event_name, **entry})

        result = {
            "tool": tool_name,
            "manifest_hooks": manifest_hooks,
            "active_hooks": active_hooks,
            "in_sync": active_count == manifest_count,
        }
        json.dump(result, sys.stdout, indent=2)
        print()

        if manifest_hooks:
            print(f"\n{tool_name} manifest hooks:", file=sys.stderr)
            for event, entries in manifest_hooks.items():
                for e in entries:
                    for h in e.get("hooks", []):
                        print(f"  {event}: {h.get('command', '<no command>')}", file=sys.stderr)
        else:
            print(f"\n{tool_name}: no hooks in manifest", file=sys.stderr)

        if active_hooks:
            print(f"\nActive in settings.json:", file=sys.stderr)
            for h in active_hooks:
                event = h["event"]
                for hk in h.get("hooks", []):
                    print(f"  {event}: {hk.get('command', '<no command>')}", file=sys.stderr)
        else:
            print("No active hooks in settings.json", file=sys.stderr)

        if active_count != manifest_count:
            print(
                f"\nOut of sync: {manifest_count} in manifest, {active_count} active. "
                f"Run with --apply to fix.",
                file=sys.stderr,
            )
    else:
        # Overview mode — all tools
        rows = []
        for name in sorted(manifests):
            manifest = manifests[name]
            manifest_hooks = manifest.get("hooks", {})
            manifest_count = sum(len(v) for v in manifest_hooks.values())
            active_count = _count_active(name)
            enabled = name in tools_section and tools_section[name].get("enabled", False)
            rows.append({
                "name": name,
                "enabled": enabled,
                "kind": manifest.get("kind", "tool"),
                "manifest_hooks": manifest_count,
                "active_hooks": active_count,
                "in_sync": (not enabled and active_count == 0)
                    or (enabled and active_count == manifest_count),
                "events": list(manifest_hooks.keys()),
            })

        json.dump({"tools": rows}, sys.stdout, indent=2)
        print()

        header = f"  {'Name':<16} {'Enabled':<9} {'Manifest':<10} {'Active':<8} {'Sync':<6} Events"
        print(header, file=sys.stderr)
        print("  " + "-" * (len(header) - 2), file=sys.stderr)
        for r in rows:
            en = "yes" if r["enabled"] else "no"
            sync_label = "ok" if r["in_sync"] else "DRIFT"
            events = ", ".join(r["events"]) if r["events"] else "-"
            print(
                f"  {r['name']:<16} {en:<9} {r['manifest_hooks']:<10} {r['active_hooks']:<8} {sync_label:<6} {events}",
                file=sys.stderr,
            )


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
    p_install.add_argument(
        "--scope",
        choices=["user", "project"],
        default="user",
        help="Install scope: 'user' symlinks into plugin dir (all projects), "
             "'project' symlinks into project dir (this project only).",
    )
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

    # sync
    p_sync = sub.add_parser("sync", help="Reconcile hooks and symlinks for enabled tools.")
    p_sync.set_defaults(func=cmd_sync)

    # settings
    p_settings = sub.add_parser("settings", help="Show and manage settings.json hooks for tools.")
    p_settings.add_argument("tool", nargs="?", default=None, help="Tool name (optional).")
    p_settings_action = p_settings.add_mutually_exclusive_group()
    p_settings_action.add_argument(
        "--apply", action="store_true",
        help="Write hooks from manifest to settings.json (strips existing first).",
    )
    p_settings_action.add_argument(
        "--strip", action="store_true",
        help="Remove this tool's hooks from settings.json.",
    )
    p_settings.set_defaults(func=cmd_settings)

    args = parser.parse_args(argv)
    if not args.command:
        parser.print_help()
        sys.exit(1)

    args.func(args)


if __name__ == "__main__":
    main()
