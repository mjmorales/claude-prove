---
description: List, install, or remove prove tools
argument-hint: "[list|install <tool>|remove <tool>|status|available]"
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

Run with `list`. Present JSON output as a formatted table.

### install `<tool>`

Run with `install <tool>`. Summarize what was done: hooks added, directories created, config defaults applied.

### remove `<tool>`

Run with `remove <tool>`. Summarize what was cleaned up.

### status `[tool]`

Run with `status [tool]`.

### available

Run with `available`. Show tools that exist in the plugin but aren't enabled in this project. Suggest `install` for any the user might want.
