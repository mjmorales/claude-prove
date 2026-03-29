---
description: List, install, or remove prove tools
argument-hint: "[list|install <tool>|remove <tool>|status|available]"
core: true
summary: Manage prove tools — list, install, remove, status
---

# Tools: $ARGUMENTS

Manage prove tools — list available tools, install new ones, remove unused ones.

`$PLUGIN_DIR` refers to this plugin's root (parent of `commands/`).

## Instructions

Parse `$ARGUMENTS` to determine the subcommand. If empty, default to `list`.

### list (default)

```bash
PYTHONPATH="$PLUGIN_DIR" python3 "$PLUGIN_DIR/tools/registry.py" \
  --plugin-root "$PLUGIN_DIR" \
  --project-root "$(pwd)" \
  list
```

Present the JSON output as a formatted table to the user.

### install `<tool>`

```bash
PYTHONPATH="$PLUGIN_DIR" python3 "$PLUGIN_DIR/tools/registry.py" \
  --plugin-root "$PLUGIN_DIR" \
  --project-root "$(pwd)" \
  install <tool>
```

After install, summarize what was done: hooks added, directories created, config defaults applied.

### remove `<tool>`

```bash
PYTHONPATH="$PLUGIN_DIR" python3 "$PLUGIN_DIR/tools/registry.py" \
  --plugin-root "$PLUGIN_DIR" \
  --project-root "$(pwd)" \
  remove <tool>
```

After remove, summarize what was cleaned up.

### status `[tool]`

```bash
PYTHONPATH="$PLUGIN_DIR" python3 "$PLUGIN_DIR/tools/registry.py" \
  --plugin-root "$PLUGIN_DIR" \
  --project-root "$(pwd)" \
  status [tool]
```

### available

```bash
PYTHONPATH="$PLUGIN_DIR" python3 "$PLUGIN_DIR/tools/registry.py" \
  --plugin-root "$PLUGIN_DIR" \
  --project-root "$(pwd)" \
  available
```

Show tools that exist in the plugin but aren't enabled in this project. Suggest `install` for any the user might want.
