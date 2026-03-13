---
name: cleanup
description: Clean up all task artifacts (plans, reports, branches, handoff context) with optional archiving to .prove/archive/. Use after a task lifecycle is complete to archive key documents and remove working artifacts.
argument-hint: "[task-slug or plan-number]"
---

# Task Cleanup: $ARGUMENTS

Clean up all artifacts from a completed task lifecycle, archiving key documents before removal.

## Phase 1: Identify Task

1. If `$ARGUMENTS` is provided, locate matching artifacts:
   - `.prove/reports/<argument>/`
   - `.prove/plans/plan_<argument>/`
   - `.prove/context/<argument>/`
   - Branch `workflow/<argument>`
2. If no argument, scan for all task artifacts:
   - List all `.prove/reports/*/`
   - List all `.prove/plans/plan_*/`
   - List all `.prove/context/*/`
   - List all `workflow/*` branches (local)
   - List `.prove/TASK_PLAN.md` if present
3. Present what was found, then use AskUserQuestion with header "Cleanup" and options: "Proceed" (archive and delete listed artifacts) / "Cancel" (abort cleanup)

## Phase 2: Archive

Create archive at `.prove/archive/<YYYY-MM-DD>_<task-slug>/`:

```bash
mkdir -p .prove/archive/<date>_<task-slug>/
```

Archive these files (if they exist):
- `.prove/reports/<task-slug>/report.md` -> archive as `workflow-report.md`
- `.prove/plans/plan_*/02_design_decisions.md` -> archive as `design-decisions.md`
- `.prove/plans/plan_*/01_requirements.md` -> archive as `requirements.md`
- `.prove/TASK_PLAN.md` -> archive as `TASK_PLAN.md`
- `.prove/context/<task-slug>/handoff-log.md` -> archive as `handoff-log.md`

Generate `.prove/archive/<date>_<task-slug>/SUMMARY.md`:

```markdown
# Task Summary: <Task Name>

**Completed**: <date>
**Branch**: workflow/<task-slug>
**Final Status**: <from workflow report or manual>

## What Was Done
<brief summary from report or TASK_PLAN.md>

## Key Decisions
<extracted from design-decisions.md>

## Files Changed
<git diff --stat if branch still exists>
```

## Phase 3: Remove Artifacts

After archiving, remove in order:

1. **Reports**: `rm -rf .prove/reports/<task-slug>/`
   - Remove parent `.prove/reports/` if now empty
2. **Plans**: `rm -rf .prove/plans/plan_*/` (matching task)
   - Remove parent `.prove/plans/` if now empty
3. **Handoff context**: `rm -rf .prove/context/<task-slug>/`
   - Remove parent `.prove/context/` if now empty
4. **TASK_PLAN.md**: `rm .prove/TASK_PLAN.md` (if it belongs to this task)
5. **Branch**: Delete local branch
   ```bash
   # Use -D because squash-merged branches aren't seen as "fully merged" by git.
   # Safe when changes are confirmed on main (via diff check or prior squash-merge).
   git branch -D workflow/<task-slug>
   ```
   - If the branch changes were NOT squash-merged or otherwise landed on main, warn the user and skip deletion

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

- **Always archive before deleting** — never delete without archiving first
- **Verify changes landed on main** before deleting branches (squash-merged branches need `-D` since git doesn't track them as merged)
- **Confirm with user** before starting cleanup — use AskUserQuestion with "Proceed" / "Cancel" options
- **Show dry-run first** — list everything that will be archived/deleted, then use AskUserQuestion to confirm before doing it
- **Idempotent** — safe to run multiple times; skips already-cleaned items

**Interaction patterns**: See `references/interaction-patterns.md` for when to use `AskUserQuestion` vs free-form discussion.
