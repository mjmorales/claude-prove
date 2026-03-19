#!/usr/bin/env bash
# cleanup-worktrees.sh — Remove stale Claude Code worktrees
#
# Usage:
#   cleanup-worktrees.sh              List and remove all worktrees under .claude/worktrees/
#   cleanup-worktrees.sh --dry-run    Show what would be removed without changing anything
#
# For each worktree:
#   1. Runs `git worktree remove` to cleanly detach it
#   2. Falls back to `git worktree remove --force` if the clean remove fails
#   3. Removes the directory if git doesn't know about it (orphaned)

set -eo pipefail

WORKTREE_DIR="${CLAUDE_WORKTREE_DIR:-.claude/worktrees}"
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    -h|--help)
      sed -n '2,/^$/s/^# //p' "$0"
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [[ ! -d "$WORKTREE_DIR" ]]; then
  echo "No worktree directory found at $WORKTREE_DIR"
  exit 0
fi

entries=("$WORKTREE_DIR"/*)
if [[ ${#entries[@]} -eq 0 ]]; then
  echo "No worktrees to clean up."
  exit 0
fi

removed=0

for wt in "${entries[@]}"; do
  [[ -d "$wt" ]] || continue
  name=$(basename "$wt")
  abs_path=$(cd "$wt" && pwd)

  if $DRY_RUN; then
    echo "  would remove: $name ($abs_path)"
    removed=$((removed + 1))
    continue
  fi

  # Try clean remove first, then force
  if git worktree remove "$abs_path" 2>/dev/null; then
    echo "  removed: $name"
    removed=$((removed + 1))
  elif git worktree remove --force "$abs_path" 2>/dev/null; then
    echo "  removed (forced): $name"
    removed=$((removed + 1))
  else
    # Orphaned directory — git doesn't track it
    rm -rf "$abs_path"
    echo "  removed (orphaned): $name"
    removed=$((removed + 1))
  fi
done

# Prune any stale worktree bookkeeping
if ! $DRY_RUN; then
  git worktree prune 2>/dev/null || true
fi

if $DRY_RUN; then
  echo ""
  echo "Dry run: $removed worktree(s) would be removed."
else
  echo ""
  echo "Done: $removed worktree(s) removed."
fi
