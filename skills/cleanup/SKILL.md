---
name: cleanup
description: Clean up all task artifacts (plans, reports, branches, handoff context) with optional archiving to .prove/archive/. Use after a task lifecycle is complete to archive key documents and remove working artifacts.
argument-hint: "[task-slug or plan-number]"
---

# Task Cleanup: $ARGUMENTS

Archive and remove artifacts from a completed task lifecycle. The script handles all file operations (archive-before-delete, branch merge checks, directory cleanup). This skill handles user interaction and SUMMARY.md generation.

## Phase 1: Dry Run

```bash
bash "$PLUGIN_DIR/scripts/cleanup.sh" --dry-run [task-slug]
# Or to scan everything:
bash "$PLUGIN_DIR/scripts/cleanup.sh" --dry-run --all
```

If `$ARGUMENTS` is provided, pass it as the task-slug. Otherwise, use `--all`.

Present the dry-run output, then use AskUserQuestion with header "Cleanup" and options: "Proceed" / "Cancel".

## Phase 2: Execute

On user approval, run without `--dry-run`:

```bash
bash "$PLUGIN_DIR/scripts/cleanup.sh" [task-slug]
# Or:
bash "$PLUGIN_DIR/scripts/cleanup.sh" --all
```

Report the script output: what was archived, removed, and skipped.

## Phase 3: Generate SUMMARY.md

Read the archived files in `.prove/archive/<YYYY-MM-DD>_<task-slug>/` and write a `SUMMARY.md` there:

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

## Committing

Delegate to the `commit` skill. Do not create ad-hoc commits.

Example: `chore(cleanup): archive and remove api-refactor artifacts`

**Interaction patterns**: See `references/interaction-patterns.md` for when to use `AskUserQuestion` vs free-form discussion.
