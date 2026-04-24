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

- Fail fix: `bun run "$PLUGIN_DIR/packages/cli/bin/run.ts" claude-md generate --project-root "$(pwd)" --plugin-dir "$PLUGIN_DIR"`

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

#### 2.0: claude-prove binary on PATH

```bash
command -v claude-prove >/dev/null 2>&1
```

- Pass: `claude-prove` is on `$PATH` (compiled install)
- Warn: not on PATH but `$PLUGIN_DIR/packages/cli/bin/run.ts` exists — bun-run fallback works, but downstream checks that shell out to bare `claude-prove` will miss. Fix: `bash "$PLUGIN_DIR/scripts/install.sh"` (fetches the latest release binary, or refreshes the plugin clone if the binary 404s and falls back to `bun run`)
- Fail: neither available — fix: `bash "$PLUGIN_DIR/scripts/install.sh"`

Alternative fix (when `claude-prove` is already on PATH but stale): `claude-prove install upgrade` atomically swaps in the latest release binary.

#### 2.1: CAFI

Skip unless `tools.cafi.enabled` is true.

```bash
bun run $PLUGIN_DIR/packages/cli/bin/run.ts cafi status 2>&1
```

- Pass: reports indexed files
- Fail: errors or index missing — fix: `bun run $PLUGIN_DIR/packages/cli/bin/run.ts cafi index`

#### 2.2: Docker

Skip unless `.claude/.prove.json` has a `validators` section.

```bash
docker info >/dev/null 2>&1
```

- Pass: daemon running
- Warn: installed but daemon not running
- Fail: not found — not auto-fixable, report "Docker required: https://docker.com"

#### 2.3: Schema Validator

```bash
prove schema validate --help 2>&1
```

- Pass: CLI loads
- Fail: command errors — not auto-fixable, report the error

#### 2.4: Reporters

Skip unless `.claude/.prove.json` has a `reporters` section. Check each reporter's `run` command exists and is executable.

- Pass: script exists
- Warn: configured but script not found — fix: `/prove:notify setup`

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
- Warn: .prove.json modified after CLAUDE.md — fix: `bun run "$PLUGIN_DIR/packages/cli/bin/run.ts" claude-md generate --project-root "$(pwd)" --plugin-dir "$PLUGIN_DIR"`

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
[✓] claude-prove binary on PATH
[✓] CAFI configured and accessible
[✓] Docker available
[✓] Schema validator working
[–] Reporters — none configured

── Health ──
[!] CAFI index stale (12 files changed)
[✓] No orphaned worktrees
[✓] CLAUDE.md up to date
[✓] Schema version current

Summary: 9 passed, 1 warning, 0 failures
```

## Step 5: Offer Fixes

If all checks passed: "All checks passed. Your prove installation is healthy."

If failures or warnings have known fixes, `AskUserQuestion` with header "Fix":
- "Fix all" — apply all fixes
- "Fix failures only" — fix [✗] items only
- "Skip" — report only

Show each command as it runs. After fixes, re-run failed checks to confirm resolution.
