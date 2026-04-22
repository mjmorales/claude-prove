---
description: Diagnose prove installation health — checks core config, tooling, and project drift
---

# Prove Doctor

Validate configs, check tool installation, detect drift. Report by severity tier, then offer fixes.

## Output Format

```
[✓] Check description
[!] Check description — warning detail
[✗] Check description — failure detail
[–] Check description — skipped (reason)
```

## Step 0: Guard

1. Verify `$PLUGIN_DIR` is set. If not, error: "Cannot resolve plugin directory."
2. Verify `$(pwd)` is NOT inside `~/.claude/`. If it is, error: "You are inside the plugin directory. Run this command from your project root."

Stop on any failure.

## Step 1: Core Checks

Core checks gate all subsequent tiers. On any failure, skip Steps 2-3 and go to Step 5.

#### 1.1: .claude/.prove.json

```bash
prove schema validate --file "$(pwd)/.claude/.prove.json" 2>&1
```

- Pass: valid JSON, no schema errors
- Warn: schema warnings (unknown fields)
- Fail: missing, invalid JSON, or schema errors — fix: `/prove:init`

#### 1.2: CLAUDE.md exists

- Fail fix: `python3 "$PLUGIN_DIR/skills/claude-md/__main__.py" generate --project-root "$(pwd)" --plugin-dir "$PLUGIN_DIR"`

#### 1.3: .prove/ directory exists

- Fail fix: `mkdir -p .prove`

On core failure, print results and skip to Step 5:
```
── Core ──
[✗] .claude/.prove.json — file not found
[✗] CLAUDE.md — missing
[–] .prove/ directory — skipped (core dependency failed)

Core checks failed. Fix these before other checks can run.
```

## Step 2: Tooling Checks

Only check tools relevant to this project's `.claude/.prove.json`.

#### 2.1: Tool Registry Health

```bash
PYTHONPATH="$PLUGIN_DIR" python3 "$PLUGIN_DIR/tools/registry.py" \
  --plugin-root "$PLUGIN_DIR" --project-root "$(pwd)" status
```

- Pass: all enabled tools healthy, hooks in sync
- Warn: available tools not installed — suggest `/prove:tools available`
- Fail: enabled tool missing requirements or hooks out of sync — fix: `/prove:tools install <tool>`

#### 2.2: CAFI

Skip unless `tools.cafi.enabled` is true.

```bash
bun run $PLUGIN_DIR/packages/cli/bin/run.ts cafi status 2>&1
```

- Pass: reports indexed files
- Fail: errors or index missing — fix: `bun run $PLUGIN_DIR/packages/cli/bin/run.ts cafi index`

#### 2.3: Docker

Skip unless `.claude/.prove.json` has a `validators` section.

```bash
docker info >/dev/null 2>&1
```

- Pass: daemon running
- Warn: installed but daemon not running
- Fail: not found — not auto-fixable, report "Docker required: https://docker.com"

#### 2.4: Schema Validator

```bash
prove schema validate --help 2>&1
```

- Pass: CLI loads
- Fail: command errors — not auto-fixable, report the error

#### 2.5: Reporters

Skip unless `.claude/.prove.json` has a `reporters` section. Check each reporter's `run` command exists and is executable.

- Pass: script exists
- Warn: configured but script not found — fix: `/prove:notify:notify-setup`

#### 2.6: Pack Symlink Health

For each enabled tool with `kind: "pack"` in its `tool.json`, verify expected symlinks exist and resolve correctly.

```bash
PYTHONPATH="$PLUGIN_DIR" python3 "$PLUGIN_DIR/tools/registry.py" \
  --plugin-root "$PLUGIN_DIR" --project-root "$(pwd)" status
```

For each enabled pack (check `kind` field in the status output), verify symlinks:
- For each entry in `provides.skills`: check `$PLUGIN_DIR/skills/<name>` is a symlink resolving into `$PLUGIN_DIR/tools/<pack>/skills/`
- For each entry in `provides.agents`: check `$PLUGIN_DIR/agents/<name>.md` is a symlink resolving into `$PLUGIN_DIR/tools/<pack>/agents/`
- For each entry in `provides.commands`: check `$PLUGIN_DIR/commands/<name>.md` is a symlink resolving into `$PLUGIN_DIR/tools/<pack>/commands/`

- Pass: all expected symlinks exist and resolve correctly
- Warn: pack enabled but no symlinks found — fix: `/prove:tools remove <pack> && /prove:tools install <pack>`
- Fail: broken symlinks (exist but don't resolve) — fix: `/prove:tools remove <pack> && /prove:tools install <pack>`

## Step 3: Health Checks

#### 3.1: CAFI Index Freshness

Skip unless CAFI configured and index exists.

```bash
bun run $PLUGIN_DIR/packages/cli/bin/run.ts cafi status 2>&1
```

- Pass: up to date
- Warn: N files changed — fix: `bun run $PLUGIN_DIR/packages/cli/bin/run.ts cafi index`

#### 3.2: Orphaned Worktrees

Check `.claude/worktrees/` entries against `git worktree list 2>&1`.

- Pass: none (or no worktree directory)
- Warn: N orphaned — fix: `bash "$PLUGIN_DIR/scripts/cleanup-worktrees.sh"`

#### 3.3: CLAUDE.md Staleness

Compare `.claude/.prove.json` mtime vs `CLAUDE.md` mtime.

- Pass: CLAUDE.md newer
- Warn: .prove.json modified after CLAUDE.md — fix: `python3 "$PLUGIN_DIR/skills/claude-md/__main__.py" generate --project-root "$(pwd)" --plugin-dir "$PLUGIN_DIR"`

#### 3.4: Schema Version

```bash
prove schema migrate --file "$(pwd)/.claude/.prove.json" --dry-run 2>&1
```

- Pass: latest schema version
- Warn: migration available — fix: `/prove:update`

## Step 4: Present Results

Group by tier:

```
── Core ──
[✓] .claude/.prove.json valid
[✓] CLAUDE.md exists
[✓] .prove/ directory exists

── Tooling ──
[✓] CAFI configured and accessible
[!] ACB CLI found, but git hooks missing
[✓] Docker available
[✓] Schema validator working
[–] Reporters — none configured

── Health ──
[!] CAFI index stale (12 files changed)
[✓] No orphaned worktrees
[✓] CLAUDE.md up to date
[✓] Schema version current

Summary: 8 passed, 2 warnings, 0 failures
```

## Step 5: Offer Fixes

If all checks passed: "All checks passed. Your prove installation is healthy."

If failures or warnings have known fixes, `AskUserQuestion` with header "Fix":
- "Fix all" — apply all fixes
- "Fix failures only" — fix [✗] items only
- "Skip" — report only

Show each command as it runs. After fixes, re-run failed checks to confirm resolution.
