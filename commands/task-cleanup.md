---
description: Clean up all task artifacts (plans, reports, branches) with optional archiving
argument-hint: "[task-slug or plan-number]"
---

# Task Cleanup: $ARGUMENTS

Manual counterpart to the orchestrator's Phase 4 (Merge & Cleanup). Use when you merged manually or chose "Skip" at the orchestrator's merge gate.

## Workflow

Load and execute the cleanup skill (`skills/cleanup/SKILL.md` from the workflow plugin). Pass `$ARGUMENTS` as the task-slug if provided.

The skill handles dry-run confirmation, archive-before-delete, SUMMARY.md generation, and commit delegation.
