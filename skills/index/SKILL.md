---
name: index
description: >
  Build, update, or query the content-addressable file index (CAFI) that helps
  agents navigate the codebase via routing-hint descriptions.
---

# File Index Skill

Thin CLI wrapper for the CAFI tool. Index is stored at `.prove/file-index.json`.

## Behavior

1. Parse the user's argument to determine the subcommand
2. Resolve the absolute path to `tools/cafi/__main__.py` relative to this plugin — if this skill loaded from `/path/to/prove/skills/index/SKILL.md`, the CLI is at `/path/to/prove/tools/cafi/__main__.py`
3. Run the command from the **user's project directory** (cwd), NOT the plugin directory
4. If errors > 0 during indexing, warn that some descriptions may be empty

## Subcommands

The CAFI CLI uses **subcommands**, not flags. Replace `$PLUGIN` below with the absolute path to this plugin's root directory.

- **`index [--force]`** — Build or update the file index. `--force` re-describes ALL files.
  ```bash
  python3 $PLUGIN/tools/cafi/__main__.py index          # incremental
  python3 $PLUGIN/tools/cafi/__main__.py index --force   # full rebuild
  ```
- **`status`** — Show counts of new/stale/deleted/unchanged files (no indexing).
  ```bash
  python3 $PLUGIN/tools/cafi/__main__.py status
  ```
- **`clear`** — Remove the cache file.
  ```bash
  python3 $PLUGIN/tools/cafi/__main__.py clear
  ```
- **`lookup <keyword>`** — Search the index by keyword (case-insensitive, matches paths and descriptions).
  ```bash
  python3 $PLUGIN/tools/cafi/__main__.py lookup orchestrator
  ```
- **`context`** — Output the formatted file index.
  ```bash
  python3 $PLUGIN/tools/cafi/__main__.py context
  ```

Default (no argument): run `index` (incremental).
