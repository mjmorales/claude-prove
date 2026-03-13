---
description: Clean up all task artifacts (plans, reports, branches) with optional archiving
argument-hint: "[task-slug or plan-number]"
---

# Task Cleanup: $ARGUMENTS

Manual counterpart to the orchestrator's Phase 4 (Merge & Cleanup). Use this when you merged manually or chose "Skip" at the orchestrator's merge gate.

Load and follow the cleanup skill (`skills/cleanup/SKILL.md` from the workflow plugin).

## Phase 1: Identify Task

1. If `$ARGUMENTS` is provided, locate matching artifacts:
   - `.prove/reports/<argument>/`
   - `.prove/plans/plan_<argument>/`
   - `.prove/context/<argument>/`
   - Branch `orchestrator/<argument>`
2. If no argument, scan for all task artifacts
3. Run dry-run first: `PROJECT_ROOT="." bash scripts/cleanup.sh --dry-run $ARGUMENTS`
4. Present what was found, then use `AskUserQuestion` with:
   - Header: "Cleanup"
   - Options: "Proceed" (archive and clean up listed artifacts) / "Cancel" (abort cleanup)

## Phase 2: Archive & Remove

Run: `PROJECT_ROOT="." bash scripts/cleanup.sh $ARGUMENTS`

This archives key documents to `.prove/archive/<date>_<task-slug>/`, then removes working artifacts.

## Phase 3: Generate Summary

Create a `SUMMARY.md` in the archive directory by reading the archived files. Include:
- Task name, completion date, branch
- What was accomplished (from workflow report)
- Key decisions (from design decisions doc)
- Files changed

## Phase 4: Confirm

Report what was archived, deleted, and skipped. Dispatch `cleanup-complete` event if reporters are configured.

## Safety Rules

- **Always archive before deleting**
- **Verify changes landed on main** before deleting branches
- **Confirm with user** before starting cleanup (use `AskUserQuestion`)
- **Show dry-run first**
- **Idempotent** — safe to run multiple times
