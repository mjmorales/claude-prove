---
name: index
description: >
  Build or update the content-addressable file index (CAFI). Hashes all project
  files, compares against cache, and generates routing-hint descriptions for
  new/changed files via Claude CLI. Descriptions are formatted as "Read this
  file when [doing X]" to help agents navigate the codebase.
---

# File Index Skill

Manages the content-addressable file index stored at `.prove/file-index.json`.

## Behavior

1. Parse the user's argument to determine which subcommand to run
2. Determine the absolute path to this plugin's `tools/cafi/__main__.py` — use the directory this SKILL.md was loaded from to resolve it (e.g., if this skill is at `/path/to/prove/skills/index/SKILL.md`, the CLI is at `/path/to/prove/tools/cafi/__main__.py`)
3. Run the command from the **user's current working directory** (the project being indexed, NOT the plugin directory)
4. Display the output in a human-friendly format
5. If errors > 0 during indexing, warn that some descriptions may be empty

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
  python3 $PLUGIN/tools/cafi/__main__.py lookup validation
  ```
- **`context`** — Output the formatted file index.
  ```bash
  python3 $PLUGIN/tools/cafi/__main__.py context
  ```

Default (no argument): run `index` (incremental).

## Output Format

After `index`:
```
File Index Updated:
  New files described: 5
  Stale files updated: 2
  Deleted from cache: 1
  Unchanged: 42
  Total: 49
  Cache: .prove/file-index.json
```

After `status`:
```
File Index Status:
  New (unindexed): 3
  Stale (changed): 1
  Deleted (removed): 0
  Unchanged: 45
  Cache exists: yes
```
