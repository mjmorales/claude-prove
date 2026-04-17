#!/usr/bin/env bash
# session-stop.sh — Claude Code Stop hook.
#
# Fires when Claude finishes responding. If an orchestrator run is active
# (state.json present, run_status != completed), dispatches an
# execution-complete event with the current progress.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DISPATCH="${SCRIPT_DIR}/../dispatch-event.sh"
WORK_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
MAIN_ROOT=$(git -C "$WORK_DIR" worktree list --porcelain 2>/dev/null | awk '/^worktree /{print substr($0,10); exit}')
MAIN_ROOT="${MAIN_ROOT:-$WORK_DIR}"

BRANCH=$(cd "$WORK_DIR" && git branch --show-current 2>/dev/null || echo "")
if [[ "$BRANCH" != orchestrator/* ]]; then
  exit 0
fi
SLUG="${BRANCH#orchestrator/}"

# Find state.json under any branch namespace
STATE_FILE=""
RUN_BRANCH=""
for candidate in "${MAIN_ROOT}/.prove/runs"/*/"${SLUG}"/state.json; do
  if [[ -f "$candidate" ]]; then
    STATE_FILE="$candidate"
    RUN_BRANCH="$(basename "$(dirname "$(dirname "$candidate")")")"
    break
  fi
done

if [[ -z "$STATE_FILE" ]]; then
  exit 0
fi

# Derive counts + status via Python (single JSON read)
_COUNTS=$(python3 - "$STATE_FILE" <<'PY'
import json, sys
s = json.load(open(sys.argv[1]))
steps = [st for t in s.get("tasks", []) for st in t.get("steps", [])]
done = sum(1 for st in steps if st["status"] == "completed")
total = len(steps)
print(f"{s.get('run_status', 'unknown')}\t{done}\t{total}")
PY
)
IFS=$'\t' read -r RUN_STATUS DONE TOTAL <<<"$_COUNTS"

if [[ "$RUN_STATUS" == "completed" ]]; then
  DETAIL="Completed all $TOTAL steps"
  STATUS="completed"
elif [[ "$RUN_STATUS" == "halted" ]]; then
  DETAIL="Halted — $DONE/$TOTAL steps done"
  STATUS="halted"
else
  DETAIL="Session ended — $DONE/$TOTAL steps done"
  STATUS="paused"
fi

PROVE_TASK="$SLUG" \
PROVE_RUN_SLUG="$SLUG" \
PROVE_RUN_BRANCH="$RUN_BRANCH" \
PROVE_STATUS="$STATUS" \
PROVE_BRANCH="$BRANCH" \
PROVE_DETAIL="$DETAIL" \
bash "$DISPATCH" "execution-complete"

exit 0
