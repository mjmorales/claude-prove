---
description: List, install, or remove prove tools
argument-hint: "[list|install <tool>|remove <tool>|status|available|sync|settings [tool] [--apply|--strip]]"
core: true
summary: Manage prove tools — list, install, remove, status
---

# Tools: $ARGUMENTS

Parse `$ARGUMENTS` to determine the subcommand. Default to `list` if empty.

All subcommands use:
```bash
PYTHONPATH="$PLUGIN_DIR" python3 "$PLUGIN_DIR/tools/registry.py" \
  --plugin-root "$PLUGIN_DIR" --project-root "$(pwd)" <subcommand> [args]
```

### list (default)

Run with `list`. Present JSON output as a formatted table. Output is grouped by kind: "Infrastructure" for tools and "Workflow Packs" for packs. Packs are optional workflow bundles (skills + agents + commands) that users opt into.

### install `<tool>`

For packs (`kind: "pack"`): if `$PLUGIN_DIR` != `$(pwd)`, ask install scope via `AskUserQuestion` (header: "Scope"):
- "User (Recommended)" — symlinks in plugin dir, available to all projects
- "Project" — symlinks in project dir, this project only

If dogfooding (`$PLUGIN_DIR` == `$(pwd)`) or for infrastructure tools (`kind: "tool"`), default to `--scope user` without asking.

Run with `install <tool> --scope <user|project>`. Summarize what was done: scope, hooks added, directories created, config defaults applied. For packs, also report symlinks created and where they were linked (plugin dir or project dir).

### remove `<tool>`

Run with `remove <tool>`. Summarize what was cleaned up, including symlinks removed for packs.

### status `[tool]`

Run with `status [tool]`.

### available

Run with `available`. Show tools that exist in the plugin but aren't enabled in this project. Suggest `install` for any the user might want.

### sync

Run with `sync`. Reconciles hooks and symlinks for all enabled tools against their manifests. Fixes drift caused by plugin updates, path changes, or manual edits to settings.json. Report what changed.

### settings `[tool]` `[--apply|--strip]`

Run with `settings [tool] [--apply|--strip]`. Manages Claude settings.json hook entries for tools/packs.

- **No args**: overview table of all tools — manifest hook count vs active count in settings.json, sync status
- **With tool**: detail view showing manifest hooks and active hooks side-by-side
- **`--apply`**: write hooks from the tool's manifest to settings.json (strips existing first, then re-adds with fresh `$PLUGIN_DIR` expansion)
- **`--strip`**: remove this tool's hooks from settings.json

Present the JSON output as a formatted table/detail view. Flag any DRIFT (manifest vs settings.json mismatch) clearly.
