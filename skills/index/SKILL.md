---
name: index
description: >
  Build, update, or query the content-addressable file index (CAFI) that helps
  agents navigate the codebase via routing-hint descriptions.
---

# File Index Skill

CLI wrapper for the CAFI topic. Index stored at `.prove/file-index.json`.

Resolve `$PLUGIN` as the absolute path to this plugin's root directory. Run all commands from the user's project directory, not the plugin directory. If indexing reports errors > 0, warn that some descriptions may be empty.

## Subcommands

CAFI uses subcommands, not flags. Default (no argument): `index` (incremental).

| Subcommand | Purpose | Example |
|---|---|---|
| `index [--force]` | Build/update index. `--force` re-describes all files | `bun run $PLUGIN/packages/cli/bin/run.ts cafi index` |
| `status` | Show new/stale/deleted/unchanged counts (no indexing) | `bun run $PLUGIN/packages/cli/bin/run.ts cafi status` |
| `clear` | Remove the cache file | `bun run $PLUGIN/packages/cli/bin/run.ts cafi clear` |
| `lookup <keyword>` | Search by keyword (case-insensitive, paths + descriptions) | `bun run $PLUGIN/packages/cli/bin/run.ts cafi lookup orchestrator` |
| `context` | Output formatted file index | `bun run $PLUGIN/packages/cli/bin/run.ts cafi context` |
