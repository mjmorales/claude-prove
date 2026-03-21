#!/usr/bin/env bash
# session-stop.sh — Claude Code Stop hook
#
# Fires when Claude finishes responding. Checks if an orchestrator run
# was active and dispatches execution-complete if so.
#
# This runs async — it must never block.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DISPATCH="${SCRIPT_DIR}/../dispatch-event.sh"
# Use CLAUDE_PROJECT_DIR or cwd for git context (may be a worktree)
WORK_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
# .prove/ is gitignored — always lives in the main worktree
MAIN_ROOT=$(git -C "$WORK_DIR" worktree list --porcelain 2>/dev/null | awk '/^worktree /{print substr($0,10); exit}')
MAIN_ROOT="${MAIN_ROOT:-$WORK_DIR}"

# Check we're on an orchestrator branch
BRANCH=$(cd "$WORK_DIR" && git branch --show-current 2>/dev/null || echo "unknown")
if [[ "$BRANCH" != orchestrator/* ]]; then
  exit 0
fi

TASK="${BRANCH#orchestrator/}"

# Progress is namespaced per run under .prove/runs/<slug>/
PROGRESS_FILE="${MAIN_ROOT}/.prove/runs/${TASK}/PROGRESS.md"

# Only dispatch if there's an active orchestrator run
if [[ ! -f "$PROGRESS_FILE" ]]; then
  exit 0
fi

# Check if PROGRESS.md shows an in-progress status
if ! grep -qi 'Status.*In Progress' "$PROGRESS_FILE" 2>/dev/null; then
  exit 0
fi

# Count completed steps from PROGRESS.md
COMPLETED=$(grep -c '\[x\]' "$PROGRESS_FILE" 2>/dev/null || echo "0")
TOTAL=$(grep -cE '\[[ x]\]' "$PROGRESS_FILE" 2>/dev/null || echo "0")

if [[ "$COMPLETED" -eq "$TOTAL" && "$TOTAL" -gt 0 ]]; then
  DETAIL="Completed all $TOTAL steps"
  STATUS="completed"
else
  DETAIL="Session ended — $COMPLETED/$TOTAL steps done"
  STATUS="paused"
fi

PROVE_TASK="$TASK" \
PROVE_STATUS="$STATUS" \
PROVE_BRANCH="$BRANCH" \
PROVE_DETAIL="$DETAIL" \
bash "$DISPATCH" "execution-complete"

exit 0
