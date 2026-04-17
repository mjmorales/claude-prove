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
# Task Summary: <Task Name from prd.json.title>

**Completed**: <date>
**Branch**: orchestrator/<task-slug>
**Final Status**: <state.json.run_status from archive>

## What Was Done
<summary from archived prd.json (context, goals)>

## Tasks Completed
<extracted from archived state.json — list tasks with review verdicts>

## Files Changed
<from archived files-changed.txt, if present>
```

Read the archived JSON artifacts (`prd.json`, `plan.json`, `state.json`) rather than md — they contain the same data in structured form.

## Committing

Delegate to the `commit` skill.

Example: `chore(cleanup): archive and remove api-refactor artifacts`
