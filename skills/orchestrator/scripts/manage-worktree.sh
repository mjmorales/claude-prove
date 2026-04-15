#!/usr/bin/env bash
# manage-worktree.sh — Create, remove, and list namespaced sub-task worktrees.
#
# Prevents branch/path collisions between concurrent orchestrator runs by
# deterministically namespacing worktree paths and branches under the
# orchestrator slug.
#
# Usage:
#   manage-worktree.sh create <slug> <task-id>
#   manage-worktree.sh remove <slug> <task-id>
#   manage-worktree.sh remove-all <slug>
#   manage-worktree.sh list <slug>
#   manage-worktree.sh path <slug> <task-id>
#   manage-worktree.sh branch <slug> <task-id>
#
# Output (create): prints the absolute worktree path on success
# Output (path):   prints the absolute worktree path (no creation)
# Output (branch): prints the branch name (no creation)
# Output (list):   prints one "<task-id> <worktree-path> <branch>" per line

set -euo pipefail

ACTION="${1:?Usage: manage-worktree.sh <create|remove|remove-all|list|path|branch> <slug> [task-id]}"
SLUG="${2:?Missing slug}"
TASK_ID="${3:-}"

# Resolve the main worktree root (works from any worktree or the main repo)
MAIN_ROOT=$(git worktree list --porcelain | head -1 | sed 's/^worktree //')

WORKTREE_DIR="$MAIN_ROOT/.claude/worktrees"

# Deterministic naming:
#   path:   .claude/worktrees/<slug>-task-<task-id>
#   branch: task/<slug>/<task-id>
#
# Sub-task branches use the "task/" prefix (not "orchestrator/") to avoid git
# ref conflicts — git cannot have both orchestrator/<slug> (file) and
# orchestrator/<slug>/task-X (directory) in its ref tree.
worktree_path() {
  echo "$WORKTREE_DIR/${SLUG}-task-${1}"
}

branch_name() {
  echo "task/${SLUG}/${1}"
}

case "$ACTION" in
  create)
    [[ -z "$TASK_ID" ]] && { echo "ERROR: task-id required for create" >&2; exit 1; }

    WT_PATH=$(worktree_path "$TASK_ID")
    BRANCH=$(branch_name "$TASK_ID")
    BASE_BRANCH="orchestrator/${SLUG}"

    # Verify the orchestrator branch exists (sub-tasks branch from it)
    if ! git rev-parse --verify "$BASE_BRANCH" >/dev/null 2>&1; then
      echo "ERROR: Base branch '$BASE_BRANCH' does not exist. Create the orchestrator worktree first." >&2
      exit 1
    fi

    # Clean up stale worktree entry if path doesn't exist
    if git worktree list --porcelain | grep -q "worktree $WT_PATH$" && [[ ! -d "$WT_PATH" ]]; then
      git worktree prune
    fi

    # If worktree already exists, print path and exit (idempotent)
    if [[ -d "$WT_PATH" ]]; then
      printf '%s\n' "$SLUG" > "$WT_PATH/.prove-wt-slug.txt"
      echo "$WT_PATH"
      exit 0
    fi

    # If branch exists but worktree doesn't, remove stale branch
    if git rev-parse --verify "$BRANCH" >/dev/null 2>&1; then
      git branch -D "$BRANCH" 2>/dev/null || true
    fi

    # Create worktree branching from the orchestrator branch
    git worktree add "$WT_PATH" -b "$BRANCH" "$BASE_BRANCH"
    printf '%s\n' "$SLUG" > "$WT_PATH/.prove-wt-slug.txt"
    echo "$WT_PATH"
    ;;

  remove)
    [[ -z "$TASK_ID" ]] && { echo "ERROR: task-id required for remove" >&2; exit 1; }

    WT_PATH=$(worktree_path "$TASK_ID")
    BRANCH=$(branch_name "$TASK_ID")

    if [[ -d "$WT_PATH" ]]; then
      git worktree remove "$WT_PATH" --force 2>/dev/null || rm -rf "$WT_PATH"
    fi
    git worktree prune 2>/dev/null || true
    git branch -D "$BRANCH" 2>/dev/null || true
    ;;

  remove-all)
    # Remove all sub-task worktrees for this slug
    for wt in "$WORKTREE_DIR/${SLUG}-task-"*; do
      [[ -d "$wt" ]] || continue
      git worktree remove "$wt" --force 2>/dev/null || rm -rf "$wt"
    done
    git worktree prune 2>/dev/null || true

    # Remove all sub-task branches for this slug
    git for-each-ref --format='%(refname:short)' "refs/heads/task/${SLUG}/" | while read -r branch; do
      git branch -D "$branch" 2>/dev/null || true
    done
    ;;

  list)
    for wt in "$WORKTREE_DIR/${SLUG}-task-"*; do
      [[ -d "$wt" ]] || continue
      tid=$(basename "$wt" | sed "s/^${SLUG}-task-//")
      branch=$(branch_name "$tid")
      echo "$tid $wt $branch"
    done
    ;;

  path)
    [[ -z "$TASK_ID" ]] && { echo "ERROR: task-id required for path" >&2; exit 1; }
    worktree_path "$TASK_ID"
    ;;

  branch)
    [[ -z "$TASK_ID" ]] && { echo "ERROR: task-id required for branch" >&2; exit 1; }
    branch_name "$TASK_ID"
    ;;

  *)
    echo "ERROR: Unknown action '$ACTION'. Use: create, remove, remove-all, list, path, branch" >&2
    exit 1
    ;;
esac
