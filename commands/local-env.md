---
description: Point this machine at its claude-prove checkout — writes the per-machine env block into .claude/settings.local.json
---

# Prove Local Env

Write this machine's claude-prove checkout path into the `env` block of `.claude/settings.local.json` (auto-gitignored, injected by Claude Code into hooks and Bash).

Why: git-tracked artifacts (hook commands in `.claude/settings.json`, CLAUDE.md command examples) reference `${CLAUDE_PROVE_PLUGIN_DIR:-$HOME/.claude/plugins/prove}` instead of an absolute checkout path, so each machine supplies its own value here.

## Step 1: Detect the checkout

Resolve the plugin checkout directory, first match wins:

1. `$CLAUDE_PLUGIN_ROOT` if set and it contains `packages/cli/bin/run.ts`
2. `$(pwd)` if it contains both `.claude-plugin/plugin.json` and `packages/cli/bin/run.ts` (you are inside the claude-prove repo itself)
3. Otherwise ask the user free-form: "Where is your claude-prove checkout?"

Validate the candidate contains `packages/cli/bin/run.ts`. If not, report the path and ask again — do not write anything.

## Step 2: Confirm

`AskUserQuestion` with header "Local env":

- question: "Write `CLAUDE_PROVE_PLUGIN_DIR=<resolved path>` into `.claude/settings.local.json`? This file is local to this machine and gitignored."
- "Write it" — proceed
- "Change path" — ask free-form for the correct checkout path, re-validate, re-confirm

## Step 3: Write

```bash
claude-prove install local-env --plugin-dir "<resolved path>"
```

On failure, surface the CLI error verbatim and stop.

## Step 4: Verify and repair drift

Run `claude-prove install doctor` and inspect the two related checks:

- `plugin-dir-env` — must PASS now (source `process-env` or `settings.local.json`)
- `hook-paths[...]` — a WARN mentioning "machine-absolute dev prefix" means `.claude/settings.json` still carries the pre-portable format

If the drift warning appears, `AskUserQuestion` with header "Regenerate":

- "Regenerate" — run `claude-prove install init-hooks --force`, then `claude-prove claude-md generate --project-root "$(pwd)"`, then re-run `claude-prove install doctor` to confirm the warning cleared
- "Leave as-is" — report that the tracked files still embed this machine's absolute path and will break for other contributors

## Step 5: Report

State what was written, the resolved checkout path, and remind the user: the `env` block is injected at session start, so hooks pick up the new value after the Claude Code session restarts.
