---
name: acb-setup
description: >
  Set up, diagnose, and migrate ACB (Agent Change Brief) intent hooks in any git project.
  Handles first-time install, hook mode migration (copy->link), config creation, and
  provides agent-facing documentation for writing intent manifests.
argument-hint: "[setup | doctor | info]"
allowed_tools: Bash, Read, Write, Glob, Grep, AskUserQuestion
---

# ACB Setup: $ARGUMENTS

Set up, diagnose, or document the ACB intent hook system. Subcommands:

- **setup** (default) — Install or repair ACB hooks and config
- **doctor** — Check health of existing ACB installation
- **info** — Print agent-facing reference for writing intent manifests

Parse `$ARGUMENTS` to determine which subcommand to run. If empty or unrecognized, run **setup**.

## Resolving the ACB CLI

This skill runs as part of the prove plugin. The ACB CLI is accessed via npx from the plugin's acb-core package:

```bash
ACB_CLI="npx --prefix $PLUGIN_DIR/packages/acb-core acb-review"
```

where `$PLUGIN_DIR` is the plugin root (parent of `commands/` and `skills/`).

Use `$ACB_CLI` for all CLI invocations throughout this skill (e.g., `$ACB_CLI install --link`).

If the CLI fails (dist/ not built), tell the user to run:
```bash
cd "$PLUGIN_DIR/packages/acb-core" && npm install && npx tsc
```

The hooks directory is at `$PLUGIN_DIR/packages/acb-core/hooks/`.

---

## Subcommand: setup

### Step 1: Detect Current State

Run these in parallel:

```bash
# Is this a git repo?
git rev-parse --show-toplevel

# Verify CLI is available
$ACB_CLI --help 2>&1

# Current hook mode
git config core.hooksPath 2>/dev/null

# Check .git/hooks for copied ACB hooks
grep -l "acb-review" .git/hooks/* 2>/dev/null
```

Also check:
- Does `.acb/` exist?
- Does `.acb/config.json` exist?
- Does `.acb/.gitignore` exist with `intents/`?
- Do `.claude/commands/acb-*.md` files exist?

### Step 2: Determine Action

Based on detected state, classify as one of:

| State | Action |
|-------|--------|
| No git repo | Error: "Not a git repository. ACB requires git." |
| CLI not found | Error: "ACB CLI not found. Check plugin installation." |
| No hooks at all | Fresh install |
| Hooks in copy mode (.git/hooks/) | Migrate to link mode |
| Hooks in link mode (core.hooksPath) | Check for missing hooks (e.g., post-checkout) |
| Everything present | Report healthy, offer to re-scaffold commands |

### Step 3: Install or Migrate

**Fresh install** — use link mode (preferred):

```bash
$ACB_CLI install --link
```

If `--framework claudecode` is appropriate (detected by presence of `.claude/` directory):

```bash
$ACB_CLI install --link --framework claudecode
```

**Migration from copy mode** — clean up copied hooks, switch to link:

1. Show the user what will change:
   ```
   Current: hooks copied to .git/hooks/ (copy mode)
   Target:  hooks linked via core.hooksPath (link mode)

   Benefits:
   - Hooks stay in sync with package updates
   - core.hooksPath is shared across worktrees
   - post-checkout hook enables worktree intent symlinks
   ```

2. Use `AskUserQuestion` with header "Hook Migration" and options:
   - "Migrate to link mode" — proceed
   - "Keep copy mode" — skip migration

3. On "Migrate":
   ```bash
   # Uninstall old hooks
   $ACB_CLI uninstall
   # Reinstall in link mode
   $ACB_CLI install --link
   ```

**Adding missing hooks** (e.g., post-checkout added after initial install):

If `core.hooksPath` is set and points to the plugin's hooks directory, new hooks are picked up automatically — no action needed, just inform the user. If `core.hooksPath` points elsewhere, update it:

```bash
git config core.hooksPath "$PLUGIN_DIR/packages/acb-core/hooks"
```

### Step 4: Configure

Create or update `.acb/config.json` if it doesn't exist:

```json
{
  "trunk_branch": "main"
}
```

Detect the trunk branch name:

```bash
# Check common names
git rev-parse --verify main 2>/dev/null && echo "main"
git rev-parse --verify master 2>/dev/null && echo "master"
```

If both exist, use `AskUserQuestion` with header "Trunk Branch" and the detected branch names as options.

If `.acb/config.json` already exists, read it and verify `trunk_branch` is set. Don't overwrite existing config.

### Step 5: Scaffold Commands

If `.claude/` directory exists (Claude Code project) and ACB commands are missing:

```bash
$ACB_CLI install --framework claudecode
```

This is idempotent — it only creates missing command files.

### Step 6: Summary

Print a status summary:

```
ACB Setup Complete
==================
Hook mode:      link (core.hooksPath)
Hooks:          pre-commit, post-commit, post-checkout
Config:         .acb/config.json (trunk: main)
Commands:       .claude/commands/acb-{resolve,fix,discuss}.md
Intents dir:    .acb/intents/ (gitignored)

Agents must write .acb/intents/staged.json before each commit.
Run `/prove:acb-setup info` for the full manifest reference.
```

---

## Subcommand: doctor

Diagnose the health of an existing ACB installation.

### Checks

Run all checks and present results using the standard prove doctor format: `── ACB Health ──` header, then `[✓]`/`[✗]` per check with a short description.

**Checks:**

1. **Git repo** — `git rev-parse --show-toplevel`
2. **ACB CLI** — `$ACB_CLI --help 2>&1`
3. **Hook mode** — check `core.hooksPath` vs `.git/hooks/`
4. **Hook files** — verify pre-commit, post-commit, post-checkout all exist in the hooks directory
5. **Config** — `.acb/config.json` exists and has `trunk_branch`
6. **Gitignore** — `.acb/.gitignore` contains `intents/`
7. **Intents not tracked** — `git ls-files .acb/intents/` should be empty
8. **Commands** — check for `acb-resolve.md`, `acb-fix.md`, `acb-discuss.md` in `.claude/commands/`

If any checks fail, use `AskUserQuestion` with header "Fix" and options:
- "Fix all" — run setup to repair
- "Skip" — just report

---

## Subcommand: info

Read and output the contents of `references/intent-manifest-reference.md` to the user. No other tool calls needed.

---

## Rules

- **Never force-add intents to git** — `.acb/intents/` is gitignored by design. Never `git add -f` anything in this directory.
- **Idempotent** — running setup multiple times must be safe. Never overwrite existing `.acb/config.json`.
- **Always use $ACB_CLI** — never run bare `npx acb-review`.

**Interaction patterns**: See `references/interaction-patterns.md` for when to use `AskUserQuestion` vs free-form discussion.
