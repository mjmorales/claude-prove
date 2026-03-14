---
description: Complete a task by merging its branch to main and running cleanup
argument-hint: "[task-slug]"
---

# Complete Task: $ARGUMENTS

Merge a completed task branch to main and clean up all artifacts. This is the standalone equivalent of the orchestrator's Phase 4 (Merge & Cleanup), for use when the orchestrator wasn't running or you chose "Skip" at its merge gate.

## Phase 1: Identify Task

1. **Resolve the task slug**:
   - If `$ARGUMENTS` is provided, use it as the task slug
   - Otherwise, detect from current branch (if on `orchestrator/<slug>`, use `<slug>`)
   - If still unresolved, scan for orchestrator branches: `git branch --list 'orchestrator/*'`
   - If multiple candidates exist, use `AskUserQuestion` to let the user pick

2. **Verify the branch exists**: `git branch --list 'orchestrator/<task-slug>'`
   - If no branch found, check if it was already merged (look for merge commit in `git log --oneline main --grep="merge: "`)
   - If already merged, skip to Phase 3 (cleanup only)
   - If no branch and no merge, halt: "No branch found for `<task-slug>`"

3. **Show current state**:
   - Branch: `orchestrator/<task-slug>`
   - Commits ahead of main: `git log main..orchestrator/<task-slug> --oneline`
   - Artifacts found: run `PROJECT_ROOT="." bash scripts/cleanup.sh --dry-run <task-slug>`

4. **Confirm with user** via `AskUserQuestion`:
   - Header: "Complete Task: `<task-slug>`"
   - Options:
     - "Merge & Clean" — merge branch to main, archive artifacts, delete branch
     - "Merge Only" — merge branch to main, keep artifacts
     - "Clean Only" — skip merge (already merged), just archive and remove artifacts
     - "Cancel" — abort

## Phase 2: Merge to Main

If the user chose "Merge & Clean" or "Merge Only":

1. Ensure working tree is clean: `git status --porcelain`
   - If dirty, halt: "Uncommitted changes detected. Commit or stash before completing."

2. Checkout main and merge:
   ```bash
   git checkout main
   git pull --ff-only  # catch up with remote if possible
   git merge --no-ff orchestrator/<task-slug> -m "merge: <task-name>"
   ```

3. If merge conflicts occur, halt and inform the user. Do NOT force-merge or resolve automatically.

4. Record the merge commit SHA for the confirmation step.

## Phase 3: Cleanup

If the user chose "Merge & Clean" or "Clean Only":

1. Run cleanup — no additional confirmation needed (user already approved):
   ```bash
   PROJECT_ROOT="." bash scripts/cleanup.sh --auto <task-slug>
   ```

2. Generate a `SUMMARY.md` in the archive directory (`.prove/archive/<date>_<task-slug>/`):
   - Read the archived files (TASK_PLAN.md, design-decisions.md, files-changed.txt)
   - Summarize: task name, completion date, branch, what was accomplished, key decisions, files changed

3. Delete the merged branch:
   ```bash
   git branch -d orchestrator/<task-slug>
   ```
   - Only if it was merged. If `git branch -d` fails (not merged), warn but do not force-delete.

## Phase 4: Commit & Confirm

1. If cleanup produced changes (archived files, removed artifacts), delegate to the `commit` skill:
   - Example: `chore(cleanup): complete and archive <task-slug>`

2. Present results:
   - Merge status: commit SHA on main (or "skipped" / "already merged")
   - What was archived and where: `.prove/archive/<date>_<task-slug>/`
   - What was deleted
   - Any skipped items (unmerged branches, missing files)

## Safety Rules

- **Never merge to main without user confirmation**
- **Never force-merge or auto-resolve conflicts** — halt and let the user handle it
- **Always archive before deleting** — the cleanup script handles this
- **Verify branch is merged before deleting it** — use `git branch -d` (not `-D`)
- **Check for uncommitted changes** before switching branches
