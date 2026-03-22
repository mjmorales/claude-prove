---
description: Generate or update the project's CLAUDE.md with LLM-optimized behavioral directives
argument-hint: "[generate | update] [--plugin-dir path]"
---

# Generate CLAUDE.md

Load and follow the claude-md skill (`skills/claude-md/SKILL.md` from the workflow plugin). Default subcommand is `generate` targeting the current working directory. The `--plugin-dir` resolves to the parent of `commands/`.
