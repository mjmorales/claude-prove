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
2. Run the appropriate CLI subcommand (see below)
3. Display the output in a human-friendly format
4. If errors > 0 during indexing, warn that some descriptions may be empty

## Subcommands

The CAFI CLI uses **subcommands**, not flags. The base invocation is `python3 tools/cafi/__main__.py`.

- **`index [--force]`** — Build or update the file index. `--force` re-describes ALL files.
  ```bash
  python3 tools/cafi/__main__.py index          # incremental
  python3 tools/cafi/__main__.py index --force   # full rebuild
  ```
- **`status`** — Show counts of new/stale/deleted/unchanged files (no indexing).
  ```bash
  python3 tools/cafi/__main__.py status
  ```
- **`clear`** — Remove the cache file.
  ```bash
  python3 tools/cafi/__main__.py clear
  ```
- **`context`** — Output the formatted file index (used by the SessionStart hook).
  ```bash
  python3 tools/cafi/__main__.py context
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
