---
name: claude-md
description: Generate or update the project's CLAUDE.md with LLM-optimized behavioral directives
allowed_tools: Bash, Read, Write, Glob

---

# Generate CLAUDE.md

Load and follow the claude-md skill at `skills/claude-md/SKILL.md`.

Parse the user's arguments (if any) and run the appropriate subcommand. If no arguments, default to `generate` targeting the current working directory.

The `--plugin-dir` should resolve to the directory containing this plugin (the parent of `commands/`).
