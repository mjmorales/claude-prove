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
2. Resolve absolute path to the prove CLI at `$PLUGIN/packages/cli/bin/run.ts`
3. Run from the user's cwd (the target project, not the plugin directory)
4. Display output in human-friendly format

## Subcommands

`$PLUGIN` = absolute path to this plugin's root directory.

| Subcommand | Purpose | Command |
|------------|---------|---------|
| `generate` (default) | Scan project, write CLAUDE.md | `bun run $PLUGIN/packages/cli/bin/run.ts claude-md generate --project-root $CWD --plugin-dir $PLUGIN` |
| `scan` | Scanner only, output JSON | `bun run $PLUGIN/packages/cli/bin/run.ts claude-md scan --project-root $CWD --plugin-dir $PLUGIN` |
| `subagent-context` | Compact context for subagent injection | `bun run $PLUGIN/packages/cli/bin/run.ts claude-md subagent-context --project-root $CWD --plugin-dir $PLUGIN` |

### Flag Defaults

- `--project-root` -- user's cwd (target project)
- `--plugin-dir` -- `$PLUGIN`
