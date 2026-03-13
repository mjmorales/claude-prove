---
description: Clean up all task artifacts (plans, reports, branches) with optional archiving
argument-hint: "[task-slug or plan-number]"
---

# Task Cleanup: $ARGUMENTS

Clean up all artifacts from a completed task lifecycle, archiving key documents before removal.

Load and follow the cleanup skill (`skills/cleanup/SKILL.md` from the workflow plugin).

## Phase 1: Identify Task

1. If `$ARGUMENTS` is provided, locate matching artifacts:
   - `.prove/reports/<argument>/`
   - `.prove/plans/plan_<argument>/`
   - Branch `orchestrator/<argument>`
2. If no argument, scan for all task artifacts
3. Present what was found, then use `AskUserQuestion` to confirm:
   - Header: "Cleanup"
   - Options: "Proceed" (archive and clean up listed artifacts) / "Cancel" (abort cleanup)

## Phase 2: Archive

Create archive at `.prove/archive/<YYYY-MM-DD>_<task-slug>/` with key documents.

## Phase 3: Remove Artifacts

After archiving, remove reports, plans, .prove/TASK_PLAN.md, and local branches.

## Safety Rules

- **Always archive before deleting**
- **Verify changes landed on main** before deleting branches
- **Confirm with user** before starting cleanup (use `AskUserQuestion`)
- **Show dry-run first**
