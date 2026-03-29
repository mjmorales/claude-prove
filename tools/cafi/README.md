# CAFI — Content-Addressable File Index

A content-addressable file index that maps SHA256 hashes of project files to agent-optimized routing-hint descriptions. Re-describes only stale/new files via incremental indexing.

## Setup

The recommended way is via `/prove:init`, which auto-configures CAFI using `tool.json`.

Add index config to `.claude/.prove.json`:

```json
{
  "index": {
    "excludes": ["*.lock", "node_modules/**", "vendor/**"],
    "max_file_size": 102400,
    "concurrency": 3
  }
}
```

## Usage

```bash
/prove:index              # Build/update index (incremental)
/prove:index --force      # Re-describe all files
/prove:index status       # Show new/stale/deleted/unchanged counts
/prove:index clear        # Remove cache
```

## How It Works

1. Run `/prove:index` to build or update the file index
2. Only new or changed files are sent to Claude for description
3. Descriptions are formatted as routing hints: "Read this file when [doing X]"
4. Use `/prove:index context` to view the full index

## Architecture

```
tools/cafi/
├── tool.json         # Tool manifest (config, requirements)
├── hasher.py         # SHA256 hashing, .gitignore-aware file walking, cache diff
├── describer.py      # Claude CLI integration, routing-hint prompt, batch processing
├── indexer.py        # Orchestrates: hash → diff → describe → save
├── __main__.py       # CLI entry point (index, status, get, clear, context)
└── test_*.py         # Unit tests (40 total)
```

**Runtime artifacts** (written to `.prove/`, gitignored):
- `.prove/file-index.json` — The cache file mapping paths to hashes + descriptions

## CLI Reference

```bash
python3 tools/cafi/__main__.py index [--force]   # Build/update index
python3 tools/cafi/__main__.py status             # Show change counts
python3 tools/cafi/__main__.py get <path>         # Get description for a file
python3 tools/cafi/__main__.py clear              # Delete cache
python3 tools/cafi/__main__.py context            # Output formatted index
```

## Description Format

Descriptions follow a strict routing-hint format:

> Read this file when [specific task/scenario]. Contains [what the file contains]. Key exports: [main functions/classes/constants].

This tells the agent *when* to read a file, not just *what* it contains.
