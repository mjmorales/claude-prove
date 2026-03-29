---
name: claude-md
description: >
  Generate and maintain an LLM-optimized CLAUDE.md for the target project.
  Scans the codebase (tech stack, conventions, structure), reads .claude/.prove.json
  config, and composes a concise CLAUDE.md with behavioral directives that
  Claude Code follows during the session. Full ownership of the file — safe
  to re-run, always produces deterministic output.
---

# claude-md

1. Parse argument to determine subcommand (default: `generate`)
2. Resolve absolute path to `skills/claude-md/__main__.py` relative to this SKILL.md
3. Run from the user's cwd (the target project, not the plugin directory)
4. Display output in human-friendly format

## Subcommands

`$PLUGIN` = absolute path to this plugin's root directory.

| Subcommand | Purpose | Command |
|------------|---------|---------|
| `generate` (default) | Scan project, write CLAUDE.md | `python3 $PLUGIN/skills/claude-md/__main__.py generate --project-root $CWD --plugin-dir $PLUGIN` |
| `scan` | Scanner only, output JSON | `python3 $PLUGIN/skills/claude-md/__main__.py scan --project-root $CWD --plugin-dir $PLUGIN` |
| `subagent-context` | Compact context for subagent injection | `python3 $PLUGIN/skills/claude-md/__main__.py subagent-context --project-root $CWD --plugin-dir $PLUGIN` |

### Flag Defaults

- `--project-root` -- user's cwd (target project)
- `--plugin-dir` -- `$PLUGIN`
