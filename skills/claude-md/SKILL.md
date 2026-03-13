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

Generates a project-level `CLAUDE.md` optimized for LLM consumption. Uses a static
codebase scanner (no LLM calls) to detect tech stack, conventions, and structure,
then composes targeted behavioral directives.

## Behavior

1. Parse the user's argument (if any) to determine which subcommand to run
2. Run the appropriate CLI subcommand
3. Display the output in a human-friendly format

## Subcommands

The CLI entry point is `python3 skills/claude-md/__main__.py`.

- **`generate [--project-root DIR] [--plugin-dir DIR]`** — Scan project and write CLAUDE.md
  ```bash
  python3 skills/claude-md/__main__.py generate --project-root /path/to/project --plugin-dir /path/to/prove
  ```
- **`scan [--project-root DIR] [--plugin-dir DIR]`** — Run scanner only, output JSON (no file written)
  ```bash
  python3 skills/claude-md/__main__.py scan --project-root /path/to/project --plugin-dir /path/to/prove
  ```
- **`subagent-context [--project-root DIR] [--plugin-dir DIR]`** — Output compact context block for subagent prompt injection
  ```bash
  python3 skills/claude-md/__main__.py subagent-context --project-root /path/to/project --plugin-dir /path/to/prove
  ```

Default (no argument): run `generate` targeting the current working directory.

## What Gets Generated

The CLAUDE.md includes only sections relevant to the project:

| Section | Included when | Content |
|---------|--------------|---------|
| Identity | Always | Project name + tech stack |
| Structure | Key dirs detected | Directory layout with purposes |
| Conventions | Naming detected | File naming, test patterns |
| Validation | .prove.json validators | Build/lint/test commands |
| Discovery Protocol | CAFI index exists | Index-first discovery rules |
| Prove Commands | .prove.json exists | Available slash commands |

## Output Format

After `generate`:
```json
{
  "status": "generated",
  "path": "/absolute/path/to/CLAUDE.md",
  "sections": 5
}
```

After `scan`:
```json
{
  "project": {"name": "my-project"},
  "tech_stack": {"languages": ["Go"], "frameworks": [], "build_systems": ["go"]},
  "key_dirs": {"cmd": "Go CLI entry points", "internal": "Internal packages"},
  "conventions": {"naming": "snake_case", "test_patterns": ["*_test.ext (suffix)"]},
  "prove_config": {"exists": true, "validators": [...], "has_index": true},
  "cafi": {"available": true, "file_count": 120}
}
```

## Design Principles

- **Behavioral directives** — every line is imperative ("Do X", "Never Y", "Before Z, always W")
- **No documentation** — CLAUDE.md tells Claude what to do, not what things are
- **Minimal** — only include what changes Claude's behavior
- **Deterministic** — same project state produces same output (no LLM in the loop)
- **Idempotent** — safe to re-run at any time
