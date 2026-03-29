---
name: cleanup
description: Clean up all task artifacts (plans, reports, branches, handoff context) with optional archiving to .prove/archive/. Use after a task lifecycle is complete to archive key documents and remove working artifacts.
argument-hint: "[task-slug or plan-number]"
---

# Task Cleanup: $ARGUMENTS

## Phase 1: Dry Run

If `$ARGUMENTS` is provided, pass it as task-slug; otherwise use `--all`:

```bash
bash "$PLUGIN_DIR/scripts/cleanup.sh" --dry-run [task-slug]
bash "$PLUGIN_DIR/scripts/cleanup.sh" --dry-run --all
```

Present the dry-run output. `AskUserQuestion`, header "Cleanup", options: "Proceed" / "Cancel".

## Phase 2: Execute

Run without `--dry-run`:

```bash
bash "$PLUGIN_DIR/scripts/cleanup.sh" [task-slug]
bash "$PLUGIN_DIR/scripts/cleanup.sh" --all
```

Report what was archived, removed, and skipped.

## Phase 3: Generate SUMMARY.md

Read archived files in `.prove/archive/<YYYY-MM-DD>_<task-slug>/` and write `SUMMARY.md` there:

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

Delegate to the `commit` skill.

Example: `chore(cleanup): archive and remove api-refactor artifacts`
