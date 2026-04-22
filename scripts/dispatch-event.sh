#!/usr/bin/env bash
# dispatch-event.sh — Reporter event dispatcher.
#
# Dedupes via state.json's dispatch ledger through the run_state CLI.
# Requires a JSON-first run (state.json present under .prove/runs/<branch>/<slug>/).
#
# Usage:
#   PROVE_RUN_BRANCH="feature" PROVE_RUN_SLUG="my-task" \
#   PROVE_STEP="1.1.1" PROVE_STATUS="done" PROVE_DETAIL="build:PASS" \
#   bash scripts/dispatch-event.sh <event-type>
#
# Exit codes:
#   0 — always (dispatch is best-effort, never halts the orchestrator)

set -uo pipefail

EVENT_TYPE="${1:-}"
if [[ -z "$EVENT_TYPE" ]]; then
  echo "dispatch-event: missing event type argument" >&2
  exit 0
fi

WORK_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
MAIN_ROOT=$(git -C "$WORK_DIR" worktree list --porcelain 2>/dev/null | awk '/^worktree /{print substr($0,10); exit}')
MAIN_ROOT="${MAIN_ROOT:-$WORK_DIR}"
CONFIG_FILE="${WORK_DIR}/.claude/.prove.json"
RUNS_ROOT="${MAIN_ROOT}/.prove/runs"

RUN_SLUG="${PROVE_RUN_SLUG:-}"
RUN_BRANCH="${PROVE_RUN_BRANCH:-}"

if [[ -z "$RUN_SLUG" || -z "$RUN_BRANCH" ]]; then
  echo "dispatch-event: PROVE_RUN_SLUG and PROVE_RUN_BRANCH required" >&2
  exit 0
fi

STATE_FILE="${RUNS_ROOT}/${RUN_BRANCH}/${RUN_SLUG}/state.json"
if [[ ! -f "$STATE_FILE" ]]; then
  echo "dispatch-event: no state.json at $STATE_FILE — run `run_state init` first" >&2
  exit 0
fi

if [[ ! -f "$CONFIG_FILE" ]]; then
  exit 0
fi

# --- Dedup via run_state CLI ---

DEDUP_KEY="${EVENT_TYPE}:${PROVE_STEP:-$RUN_SLUG}"

if (cd "$MAIN_ROOT" && PROVE_RUN_BRANCH="$RUN_BRANCH" PROVE_RUN_SLUG="$RUN_SLUG" \
      scripts/prove-run dispatch-has "$DEDUP_KEY" 2>/dev/null) | grep -q '^yes$'; then
  exit 0
fi

# --- Fire reporters ---

export PROVE_EVENT="$EVENT_TYPE"
export PROVE_TASK="${PROVE_TASK:-$RUN_SLUG}"
export PROVE_STEP="${PROVE_STEP:-}"
export PROVE_STATUS="${PROVE_STATUS:-unknown}"
export PROVE_BRANCH="${PROVE_BRANCH:-$RUN_BRANCH}"
export PROVE_DETAIL="${PROVE_DETAIL:-}"
export PROVE_RUN_SLUG="$RUN_SLUG"
export PROVE_RUN_BRANCH="$RUN_BRANCH"

python3 -c "
import json, sys
with open(sys.argv[1]) as f:
    config = json.load(f)
for r in config.get('reporters', []):
    if sys.argv[2] in r.get('events', []):
        print(f\"{r.get('name', 'unnamed')}\t{r.get('command', '')}\")
" "$CONFIG_FILE" "$EVENT_TYPE" 2>/dev/null | while IFS=$'\t' read -r name command; do
  [[ -z "$command" ]] && continue
  echo "dispatch-event: firing $name for $EVENT_TYPE" >&2
  (cd "$MAIN_ROOT" && bash -c "$command") 2>&1 | sed 's/^/  ['"$name"'] /' >&2 || true
done

# --- Record dispatch ---

(cd "$MAIN_ROOT" && PROVE_RUN_BRANCH="$RUN_BRANCH" PROVE_RUN_SLUG="$RUN_SLUG" \
  scripts/prove-run dispatch-record "$DEDUP_KEY" "$EVENT_TYPE") >/dev/null 2>&1 || true

exit 0
