---
description: Complete a task by merging its branch to main and running cleanup
argument-hint: "[task-slug]"
---

# Complete Task: $ARGUMENTS

Merge a completed task branch to main and clean up artifacts. Standalone equivalent of the orchestrator's Phase 4 (Merge & Cleanup).

## Phase 1: Identify Task

1. **Resolve the task slug**:
   - Use `$ARGUMENTS` if provided
   - Otherwise detect from current branch (`orchestrator/<slug>`)
   - Otherwise scan: `git branch --list 'orchestrator/*'` -- if multiple, use `AskUserQuestion` to pick

2. **Verify the branch exists**: `git branch --list 'orchestrator/<task-slug>'`
   - If no branch, check for prior merge: `git log --oneline main --grep="merge: "`
   - If already merged, skip to Phase 3
   - If no branch and no merge, halt with error

3. **Show current state**:
   - Commits ahead of main: `git log main..orchestrator/<task-slug> --oneline`
   - Artifacts found: `PROJECT_ROOT="." bash scripts/cleanup.sh --dry-run <task-slug>`

4. **Confirm** via `AskUserQuestion` (header: "Complete Task: `<task-slug>`"):
   - "Merge & Clean" -- merge, archive artifacts, delete branch
   - "Merge Only" -- merge, keep artifacts
   - "Clean Only" -- skip merge, archive and remove artifacts
   - "Cancel"

## Phase 2: Merge to Main

If user chose "Merge & Clean" or "Merge Only":

1. Halt if working tree is dirty (`git status --porcelain`)
2. Merge:
   ```bash
   git checkout main
   git pull --ff-only
   git merge --no-ff orchestrator/<task-slug> -m "merge: <task-name>"
   ```
3. On merge conflicts, halt immediately. Never force-merge or auto-resolve.
4. Record merge commit SHA.

## Phase 3: Cleanup

If user chose "Merge & Clean" or "Clean Only":

1. Run: `PROJECT_ROOT="." bash scripts/cleanup.sh --auto <task-slug>`
2. Generate `SUMMARY.md` in `.prove/archive/<date>_<task-slug>/` from archived files (task name, date, branch, accomplishments, decisions, files changed)
3. Delete merged branch: `git branch -d orchestrator/<task-slug>` -- if `-d` fails (not merged), warn but do not force-delete

## Phase 4: Commit & Report

1. If cleanup produced changes, delegate to the `commit` skill (e.g., `chore(cleanup): complete and archive <task-slug>`)
2. Report: merge SHA (or "skipped"/"already merged"), archived location, deleted items, skipped items
