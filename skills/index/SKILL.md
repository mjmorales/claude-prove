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

1. Parse arguments — check for `--force` flag
2. Run the indexer: `python3 .prove/cafi/__main__.py index` (or `index --force`)
3. Capture and display the summary output to the user
4. If errors > 0, warn that some descriptions may be empty
5. Show the total indexed file count and cache location

## Arguments

- `--force` — Re-describe ALL files, not just new/changed ones
- `--status` — Just show counts of new/stale/deleted/unchanged (no indexing)
- `--clear` — Remove the cache file

## Output Format

Show a human-friendly summary:
```
File Index Updated:
  New files described: 5
  Stale files updated: 2
  Deleted from cache: 1
  Unchanged: 42
  Total: 49
  Cache: .prove/file-index.json
```

If `--status`:
```
File Index Status:
  New (unindexed): 3
  Stale (changed): 1
  Deleted (removed): 0
  Unchanged: 45
  Cache exists: yes
```
