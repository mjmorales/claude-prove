---
name: doctor
description: Diagnose prove installation health — checks core config, tooling, and project drift
allowed_tools: Bash, Read, Glob, Grep, AskUserQuestion
---

# Prove Doctor

Diagnose the health of a prove-powered project. Checks that configs are valid, tools are installed, and nothing has drifted. Reports issues grouped by severity tier, then offers to fix what it can.

**This is different from `/prove:init`** — init creates things, doctor checks things.

## Output Format

Use this format for each check result:

```
[✓] Check description
[!] Check description — warning detail
[✗] Check description — failure detail
[–] Check description — skipped (reason)
```

## Instructions

### Step 1: Run Core Checks

Core checks must pass for prove to function. If any fail, skip Tooling and Health tiers — they depend on core being healthy.

#### Check 1.1: .prove.json exists and is valid JSON

```bash
python3 -m tools.schema validate --file .prove.json 2>&1
```

- **Pass**: file exists, valid JSON, no schema errors
- **Warn**: file exists with schema warnings (unknown fields)
- **Fail**: file missing, invalid JSON, or schema errors
- **Fix**: run `/prove:init`

#### Check 1.2: CLAUDE.md exists

Check that `CLAUDE.md` exists in the project root.

- **Pass**: file exists
- **Fail**: file missing
- **Fix**: run `python3 "$PLUGIN_DIR/skills/claude-md/__main__.py" generate --project-root "$(pwd)" --plugin-dir "$PLUGIN_DIR"`

where `$PLUGIN_DIR` is the directory containing this plugin (the parent of `commands/`).

#### Check 1.3: .prove/ directory exists

Check that `.prove/` directory exists (working directory for prove artifacts).

- **Pass**: directory exists
- **Fail**: directory missing
- **Fix**: `mkdir -p .prove`

**If any core check failed**, print the core results and skip to the Fix step. Show:
```
── Core ──
[✗] .prove.json — file not found
[✗] CLAUDE.md — missing
[–] .prove/ directory — skipped (core dependency failed)

Core checks failed. Fix these before other checks can run.
```

### Step 2: Run Tooling Checks

Optional features — only check what's relevant to this project. Read `.prove.json` to determine which tools are configured.

#### Check 2.1: CAFI (Content-Addressable File Index)

Only check if `.prove.json` has an `index` section.

- Run `python3 tools/cafi/__main__.py status 2>&1`
- **Pass**: CAFI reports indexed files
- **Fail**: CAFI errors or index missing
- **Fix**: `python3 tools/cafi/__main__.py index`

#### Check 2.2: ACB CLI

Only check if the project uses ACB (look for `.acb/` directory or `packages/acb-core/`).

1. Check `acb-review` binary: `npx acb-review --version 2>&1`
2. Check git hooks: verify `.git/hooks/pre-commit` and `.git/hooks/post-commit` contain acb-review references
3. Check slash commands: verify `.claude/commands/acb-resolve.md`, `.claude/commands/acb-fix.md`, `.claude/commands/acb-discuss.md` exist

- **Pass**: CLI available, hooks installed, commands present
- **Warn**: CLI available but hooks or commands missing
- **Fail**: CLI not found
- **Fix (CLI)**: `npm install @acb/core`
- **Fix (hooks)**: `npx acb-review install`
- **Fix (commands)**: create the missing command files per `packages/acb-core/docs/claude-code-setup.md`

#### Check 2.3: Validators (Docker)

Only check if `.prove.json` has a `validators` section.

- Run `docker info >/dev/null 2>&1`
- **Pass**: Docker daemon is running
- **Warn**: Docker installed but daemon not running
- **Fail**: Docker not found
- **Fix**: not auto-fixable — report "Docker is required for validators. Install from https://docker.com"

#### Check 2.4: Schema Validator

- Run `python3 -m tools.schema validate --help 2>&1`
- **Pass**: validator module loads successfully
- **Fail**: import errors or missing dependencies
- **Fix**: not auto-fixable — report the error

#### Check 2.5: Reporters

Only check if `.prove.json` has a `reporters` section. For each configured reporter:

- Check that the `run` command exists and is executable
- **Pass**: reporter script exists
- **Warn**: reporter configured but script not found
- **Fix**: run `/prove:notify-setup` to reconfigure

### Step 3: Run Health Checks

Detect drift and staleness in an otherwise-working installation.

#### Check 3.1: CAFI Index Freshness

Only check if CAFI is configured and the index exists.

- Run `python3 tools/cafi/__main__.py status 2>&1` and check for stale/unindexed files
- **Pass**: index is up to date
- **Warn**: N files changed since last index
- **Fix**: `python3 tools/cafi/__main__.py index`

#### Check 3.2: Orphaned Worktrees

- Check if `.claude/worktrees/` exists and has entries
- For each entry, verify the worktree is still valid: `git worktree list 2>&1`
- **Pass**: no orphaned worktrees (or no worktree directory)
- **Warn**: N orphaned worktrees found
- **Fix**: `bash "$PLUGIN_DIR/scripts/cleanup-worktrees.sh"`

#### Check 3.3: CLAUDE.md Staleness

Compare modification times:
- `.prove.json` mtime vs `CLAUDE.md` mtime
- If `.prove.json` was modified more recently, CLAUDE.md may be stale

- **Pass**: CLAUDE.md is newer than .prove.json
- **Warn**: CLAUDE.md may be stale — .prove.json was modified after it
- **Fix**: `python3 "$PLUGIN_DIR/skills/claude-md/__main__.py" generate --project-root "$(pwd)" --plugin-dir "$PLUGIN_DIR"`

#### Check 3.4: Schema Version

- Read `schema_version` from `.prove.json`
- Run `python3 -m tools.schema migrate --dry-run 2>&1` to check if migrations are available

- **Pass**: config is on the latest schema version
- **Warn**: migration available
- **Fix**: run `/prove:update`

### Step 4: Present Results

Print all results grouped by tier:

```
── Core ──
[✓] .prove.json valid
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

### Step 5: Offer Fixes

If there are any failures or warnings with known fixes:

Use `AskUserQuestion` with header "Fix" and options:
- "Fix all" — apply all available fixes
- "Fix failures only" — only fix [✗] items, leave warnings
- "Skip" — just report, I'll handle it

For each fix being applied, show what command is being run. After all fixes, re-run the checks that were failing to confirm they now pass.

If everything passed, end with:
```
All checks passed. Your prove installation is healthy.
```
