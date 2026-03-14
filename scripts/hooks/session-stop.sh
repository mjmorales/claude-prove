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
PROJECT_ROOT="${SCRIPT_DIR%/scripts/hooks}"
PROGRESS_FILE="${PROJECT_ROOT}/.prove/PROGRESS.md"

# Only dispatch if there's an active orchestrator run
if [[ ! -f "$PROGRESS_FILE" ]]; then
  exit 0
fi

# Check if PROGRESS.md shows an in-progress status
if ! grep -qi 'Status.*In Progress' "$PROGRESS_FILE" 2>/dev/null; then
  exit 0
fi

# Check we're on an orchestrator branch
BRANCH=$(cd "$PROJECT_ROOT" && git branch --show-current 2>/dev/null || echo "unknown")
if [[ "$BRANCH" != orchestrator/* ]]; then
  exit 0
fi

TASK="${BRANCH#orchestrator/}"

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
