---
name: claude-md
description: >
  Generate and maintain an LLM-optimized CLAUDE.md for the target project.
  Scans the codebase (tech stack, conventions, structure), reads .prove.json
  config, and composes a concise CLAUDE.md with behavioral directives that
  Claude Code follows during the session. Full ownership of the file — safe
  to re-run, always produces deterministic output.
---

# CLAUDE.md Generator Skill

## Behavior

1. Parse the user's argument (if any) to determine which subcommand to run
2. Determine the absolute path to `skills/claude-md/__main__.py` — resolve relative to the directory this SKILL.md was loaded from
3. Run the command from the **user's current working directory** (the target project, NOT the plugin directory)
4. Display the CLI output in a human-friendly format

## Subcommands

Replace `$PLUGIN` below with the absolute path to this plugin's root directory.

- **`generate [--project-root DIR] [--plugin-dir DIR]`** — Scan project and write CLAUDE.md
  ```bash
  python3 $PLUGIN/skills/claude-md/__main__.py generate --project-root /path/to/project --plugin-dir $PLUGIN
  ```
- **`scan [--project-root DIR] [--plugin-dir DIR]`** — Run scanner only, output JSON (no file written)
  ```bash
  python3 $PLUGIN/skills/claude-md/__main__.py scan --project-root /path/to/project --plugin-dir $PLUGIN
  ```
- **`subagent-context [--project-root DIR] [--plugin-dir DIR]`** — Output compact context block for subagent prompt injection
  ```bash
  python3 $PLUGIN/skills/claude-md/__main__.py subagent-context --project-root /path/to/project --plugin-dir $PLUGIN
  ```

**Default**: `generate` — runs when no subcommand is given.

### Flag defaults

- `--project-root` — pass the user's current working directory (the target project, NOT the plugin directory)
- `--plugin-dir` — pass `$PLUGIN` (the absolute path to this plugin's root)
