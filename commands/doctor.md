---
description: Diagnose prove installation health — checks core config, tooling, and project drift
---

# Prove Doctor

Diagnose project health: validate configs, check tool installation, detect drift. Report issues by severity tier, then offer fixes.

`$PLUGIN_DIR` refers to this plugin's root (parent of `commands/`).

## Output Format

```
[✓] Check description
[!] Check description — warning detail
[✗] Check description — failure detail
[–] Check description — skipped (reason)
```

## Instructions

### Step 0: Guard — verify target project

**MUST check before proceeding:**

1. Verify `$PLUGIN_DIR` is set (resolved from this plugin's root). If not, error: "Cannot resolve plugin directory."
2. Verify `$(pwd)` is NOT inside `~/.claude/` (e.g., `~/.claude/plugins/prove`, `~/.claude/extensions/*/prove`). If it is, error: "You are inside the plugin directory. Run this command from your project root, not the plugin installation."

Do NOT proceed if any check fails.

### Step 1: Core Checks

Core checks must pass for prove to function. If any fail, skip Tooling and Health tiers and go to Step 5.

#### 1.1: .prove.json exists and is valid JSON

```bash
PYTHONPATH="$PLUGIN_DIR" python3 -m tools.schema validate --file "$(pwd)/.prove.json" 2>&1
```

- **Pass**: valid JSON, no schema errors
- **Warn**: schema warnings (unknown fields)
- **Fail**: missing, invalid JSON, or schema errors
- **Fix**: `/prove:init`

#### 1.2: CLAUDE.md exists

- **Pass**: file exists
- **Fail**: missing
- **Fix**: `python3 "$PLUGIN_DIR/skills/claude-md/__main__.py" generate --project-root "$(pwd)" --plugin-dir "$PLUGIN_DIR"`

#### 1.3: .prove/ directory exists

- **Pass**: exists
- **Fail**: missing
- **Fix**: `mkdir -p .prove`

On core failure, print results and skip to Step 5:
```
── Core ──
[✗] .prove.json — file not found
[✗] CLAUDE.md — missing
[–] .prove/ directory — skipped (core dependency failed)

Core checks failed. Fix these before other checks can run.
```

### Step 2: Tooling Checks

Only check tools relevant to this project. Read `.prove.json` to determine which are configured.

#### 2.1: CAFI (Content-Addressable File Index)

Skip unless `.prove.json` has an `index` section.

- Run `python3 $PLUGIN_DIR/tools/cafi/__main__.py status 2>&1`
- **Pass**: reports indexed files
- **Fail**: errors or index missing
- **Fix**: `python3 $PLUGIN_DIR/tools/cafi/__main__.py index`

#### 2.2: Validators (Docker)

Skip unless `.prove.json` has a `validators` section.

- Run `docker info >/dev/null 2>&1`
- **Pass**: Docker daemon running
- **Warn**: installed but daemon not running
- **Fail**: not found
- **Fix**: not auto-fixable — report "Docker required. Install from https://docker.com"

#### 2.3: Schema Validator

- Run `PYTHONPATH="$PLUGIN_DIR" python3 -m tools.schema validate --help 2>&1`
- **Pass**: module loads
- **Fail**: import errors
- **Fix**: not auto-fixable — report the error

#### 2.4: Reporters

Skip unless `.prove.json` has a `reporters` section.

- Check each reporter's `run` command exists and is executable
- **Pass**: script exists
- **Warn**: configured but script not found
- **Fix**: `/prove:notify:notify-setup`

### Step 3: Health Checks

Detect drift and staleness.

#### 3.1: CAFI Index Freshness

Skip unless CAFI configured and index exists.

- Run `python3 $PLUGIN_DIR/tools/cafi/__main__.py status 2>&1`
- **Pass**: up to date
- **Warn**: N files changed since last index
- **Fix**: `python3 $PLUGIN_DIR/tools/cafi/__main__.py index`

#### 3.2: Orphaned Worktrees

- Check `.claude/worktrees/` for entries, cross-reference with `git worktree list 2>&1`
- **Pass**: none (or no worktree directory)
- **Warn**: N orphaned worktrees
- **Fix**: `bash "$PLUGIN_DIR/scripts/cleanup-worktrees.sh"`

#### 3.3: CLAUDE.md Staleness

- Compare `.prove.json` mtime vs `CLAUDE.md` mtime
- **Pass**: CLAUDE.md newer
- **Warn**: .prove.json modified after CLAUDE.md
- **Fix**: `python3 "$PLUGIN_DIR/skills/claude-md/__main__.py" generate --project-root "$(pwd)" --plugin-dir "$PLUGIN_DIR"`

#### 3.4: Schema Version

- Run `PYTHONPATH="$PLUGIN_DIR" python3 -m tools.schema migrate --file "$(pwd)/.prove.json" --dry-run 2>&1`
- **Pass**: latest schema version
- **Warn**: migration available
- **Fix**: `/prove:update`

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

If all checks passed:
```
All checks passed. Your prove installation is healthy.
```

If failures or warnings have known fixes, `AskUserQuestion` with header "Fix" and options:
- "Fix all" — apply all fixes
- "Fix failures only" — fix [✗] items only
- "Skip" — report only

Show each command as it runs. After fixes, re-run failed checks to confirm resolution.
