---
name: cleanup
description: Clean up all task artifacts (plans, reports, branches, handoff context) with optional archiving to .prove/archive/. Use after a task lifecycle is complete to archive key documents and remove working artifacts.
argument-hint: "[task-slug or plan-number]"
---

# Task Cleanup: $ARGUMENTS

Clean up all artifacts from a completed task lifecycle, archiving key documents before removal.

## Scripts

Use `scripts/cleanup.sh` from the plugin directory for scanning, archiving, and removing artifacts. The script handles file operations; this skill handles user interaction and SUMMARY.md generation.

## Phase 1: Identify Task (Dry Run)

Run the cleanup script in dry-run mode to scan for artifacts:

```bash
bash "$PLUGIN_DIR/scripts/cleanup.sh" --dry-run [task-slug]
# Or to scan everything:
bash "$PLUGIN_DIR/scripts/cleanup.sh" --dry-run --all
```

If `$ARGUMENTS` is provided, pass it as the task-slug. Otherwise, use `--all`.

Present the dry-run output, then use AskUserQuestion with header "Cleanup" and options: "Proceed" (archive and delete listed artifacts) / "Cancel" (abort cleanup).

## Phase 2: Archive & Remove

On user approval, run the script without `--dry-run`:

```bash
bash "$PLUGIN_DIR/scripts/cleanup.sh" [task-slug]
# Or:
bash "$PLUGIN_DIR/scripts/cleanup.sh" --all
```

The script will:
1. Archive key files to `.prove/archive/<YYYY-MM-DD>_<task-slug>/`
2. Remove working artifacts (reports, plans, context, PRD.md, TASK_PLAN.md, PROGRESS.md)
3. Delete merged branches (skips unmerged ones with a warning)
4. Clean up empty parent directories

## Phase 3: Generate SUMMARY.md

After the script runs, generate a `SUMMARY.md` in the archive directory. This requires reading the archived files to summarize what was done:

```markdown
# Task Summary: <Task Name>

**Completed**: <date>
**Branch**: orchestrator/<task-slug>
**Final Status**: <from workflow report or manual>

## What Was Done
<brief summary from archived TASK_PLAN.md or PRD.md>

## Key Decisions
<extracted from archived design-decisions.md, if present>

## Files Changed
<from archived files-changed.txt, if present>
```

## Phase 4: Confirm

Output:
- What was archived and where
- What was deleted
- Any items skipped (unmerged branches, missing files)
- Path to archive: `.prove/archive/<date>_<task-slug>/`

## Committing

When archiving or removing artifacts results in changes that should be committed, delegate to the `commit` skill. Do not create ad-hoc commits. The commit skill reads `MANIFEST` for valid scopes and uses conventional commit format.

Example: `chore(cleanup): archive and remove api-refactor artifacts`

## Safety Rules

- **Always archive before deleting** — the script does this automatically
- **Verify changes landed on main** before deleting branches — the script checks this and skips unmerged branches
- **Confirm with user** before starting cleanup — use AskUserQuestion with "Proceed" / "Cancel" options
- **Show dry-run first** — always run with `--dry-run` before executing, then use AskUserQuestion to confirm
- **Idempotent** — safe to run multiple times; skips already-cleaned items

**Interaction patterns**: See `references/interaction-patterns.md` for when to use `AskUserQuestion` vs free-form discussion.
