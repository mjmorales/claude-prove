---
name: index
description: >
  Build, update, or query the content-addressable file index (CAFI) that helps
  agents navigate the codebase via routing-hint descriptions.
---

# File Index Skill

CLI wrapper for the CAFI tool. Index stored at `.prove/file-index.json`.

Resolve `$PLUGIN` as the absolute path to this plugin's root directory. Run all commands from the user's project directory, not the plugin directory. If indexing reports errors > 0, warn that some descriptions may be empty.

## Subcommands

CAFI uses subcommands, not flags. Default (no argument): `index` (incremental).

| Subcommand | Purpose | Example |
|---|---|---|
| `index [--force]` | Build/update index. `--force` re-describes all files | `python3 $PLUGIN/tools/cafi/__main__.py index` |
| `status` | Show new/stale/deleted/unchanged counts (no indexing) | `python3 $PLUGIN/tools/cafi/__main__.py status` |
| `clear` | Remove the cache file | `python3 $PLUGIN/tools/cafi/__main__.py clear` |
| `lookup <keyword>` | Search by keyword (case-insensitive, paths + descriptions) | `python3 $PLUGIN/tools/cafi/__main__.py lookup orchestrator` |
| `context` | Output formatted file index | `python3 $PLUGIN/tools/cafi/__main__.py context` |
