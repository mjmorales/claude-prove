#!/usr/bin/env bash
# manage-worktree.sh — Create, query, and remove task worktrees for orchestrator full mode
#
# Usage:
#   manage-worktree.sh create <slug> <task-id>   Create worktree + branch, print path
#   manage-worktree.sh path   <slug> <task-id>   Print worktree path
#   manage-worktree.sh branch <slug> <task-id>   Print branch name
#   manage-worktree.sh remove <slug> <task-id>   Remove worktree + delete branch
#   manage-worktree.sh list   <slug>             List all task worktrees for a slug
#
# Conventions (from orchestrator SKILL.md):
#   Branch:   task/<slug>/<task-id>
#   Worktree: .claude/worktrees/<slug>-task-<task-id>
#   Base:     orchestrator/<slug> (the orchestrator's own branch)

set -eo pipefail

COMMAND="${1:?Usage: manage-worktree.sh <create|path|branch|remove|list> <slug> [task-id]}"
SLUG="${2:?Missing slug}"
TASK_ID="${3:-}"

# Resolve project root (where .git lives)
PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

branch_name() {
  echo "task/${SLUG}/${TASK_ID}"
}

worktree_path() {
  echo "${PROJECT_ROOT}/.claude/worktrees/${SLUG}-task-${TASK_ID}"
}

case "$COMMAND" in
  create)
    [[ -z "$TASK_ID" ]] && { echo "Error: task-id required for create" >&2; exit 1; }
    WT_PATH="$(worktree_path)"
    BRANCH="$(branch_name)"
    BASE_BRANCH="orchestrator/${SLUG}"

    # Verify base branch exists
    if ! git rev-parse --verify "$BASE_BRANCH" &>/dev/null; then
      echo "Error: base branch '$BASE_BRANCH' does not exist" >&2
      exit 1
    fi

    # Create worktree from the orchestrator branch
    mkdir -p "$(dirname "$WT_PATH")"
    git worktree add "$WT_PATH" -b "$BRANCH" "$BASE_BRANCH" 2>&1 >&2
    printf '%s\n' "$SLUG" > "$WT_PATH/.prove-wt-slug.txt"
    echo "$WT_PATH"
    ;;

  path)
    [[ -z "$TASK_ID" ]] && { echo "Error: task-id required for path" >&2; exit 1; }
    worktree_path
    ;;

  branch)
    [[ -z "$TASK_ID" ]] && { echo "Error: task-id required for branch" >&2; exit 1; }
    branch_name
    ;;

  remove)
    [[ -z "$TASK_ID" ]] && { echo "Error: task-id required for remove" >&2; exit 1; }
    WT_PATH="$(worktree_path)"
    BRANCH="$(branch_name)"

    # Remove worktree
    if [[ -d "$WT_PATH" ]]; then
      git worktree remove "$WT_PATH" --force 2>/dev/null
      echo "removed worktree: $WT_PATH"
    else
      echo "worktree not found: $WT_PATH" >&2
    fi

    # Delete branch
    if git rev-parse --verify "$BRANCH" &>/dev/null; then
      git branch -D "$BRANCH" 2>/dev/null
      echo "deleted branch: $BRANCH"
    fi
    ;;

  list)
    # List all task worktrees for this slug
    for d in "${PROJECT_ROOT}/.claude/worktrees/${SLUG}-task-"*/; do
      if [[ -d "$d" ]]; then
        task_id="${d##*-task-}"
        task_id="${task_id%/}"
        branch="task/${SLUG}/${task_id}"
        printf "%s\t%s\t%s\n" "$task_id" "$branch" "$d"
      fi
    done
    ;;

  *)
    echo "Unknown command: $COMMAND" >&2
    echo "Usage: manage-worktree.sh <create|path|branch|remove|list> <slug> [task-id]" >&2
    exit 1
    ;;
esac
