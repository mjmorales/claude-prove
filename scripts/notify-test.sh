#!/usr/bin/env bash
# notify-test.sh — Test the notification pipeline configured in .claude/.prove.json
#
# Usage:
#   notify-test.sh [event-type]
#
# Sends a test event through all configured reporters using dispatch-event.sh.
# If an event type is provided, only reporters subscribed to that event are tested.
# Defaults to "step-complete" when no event type is given.
#
# Exit codes:
#   0 — all tested reporters succeeded
#   1 — one or more reporters failed (or configuration missing)
#   2 — no reporters matched the event (nothing was tested)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DISPATCH="${SCRIPT_DIR}/dispatch-event.sh"
EVENT_TYPE="${1:-step-complete}"
CONFIG_FILE=".claude/.prove.json"

# --- Check configuration ---

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "ERROR: $CONFIG_FILE not found in the current directory."
  echo "Run /prove:notify-setup to configure reporters."
  exit 1
fi

# --- Check for reporters ---

REPORTER_COUNT=$(python3 -c "
import json, sys

with open(sys.argv[1]) as f:
    config = json.load(f)

reporters = config.get('reporters', [])
event = sys.argv[2]

matched = [r for r in reporters if event in r.get('events', [])]
print(len(matched))
" "$CONFIG_FILE" "$EVENT_TYPE" 2>&1) || {
  echo "ERROR: Failed to parse $CONFIG_FILE."
  exit 1
}

if [[ "$REPORTER_COUNT" -eq 0 ]]; then
  # Check if there are any reporters at all
  TOTAL=$(python3 -c "
import json, sys
with open(sys.argv[1]) as f:
    print(len(json.load(f).get('reporters', [])))
" "$CONFIG_FILE" 2>/dev/null)

  if [[ "${TOTAL:-0}" -eq 0 ]]; then
    echo "No reporters configured in $CONFIG_FILE."
    echo "Run /prove:notify-setup to add reporters."
    exit 1
  else
    echo "No reporters matched event '$EVENT_TYPE' — nothing to test."
    exit 2
  fi
fi

# --- Clear dedup state for test ---
# Derive slug from PROVE_TASK or branch, matching dispatch-event.sh logic
_TEST_SLUG="${PROVE_TASK:-}"
if [[ -z "$_TEST_SLUG" ]]; then
  _TEST_BRANCH=$(git branch --show-current 2>/dev/null || echo "")
  if [[ "$_TEST_BRANCH" == orchestrator/* ]]; then
    _TEST_SLUG="${_TEST_BRANCH#orchestrator/}"
  fi
fi

if [[ -z "$_TEST_SLUG" ]]; then
  echo "No orchestrator context — set PROVE_TASK or be on an orchestrator/* branch" >&2
  exit 1
fi

STATE_FILE=".prove/runs/${_TEST_SLUG}/dispatch-state.json"

if [[ -f "$STATE_FILE" ]]; then
  # Back up actual state so it can be restored after the test
  cp "$STATE_FILE" "${STATE_FILE}.bak"
  # Clear state so dispatch fires without dedup blocking
  echo '{"dispatched":[]}' > "$STATE_FILE"
fi

# --- Set test environment variables and dispatch ---

echo "=== Notify Test ==="
echo "Event: $EVENT_TYPE"
echo "Reporters matching: $REPORTER_COUNT"
echo ""

export PROVE_TASK="test-notification"
export PROVE_STEP="0"
export PROVE_STATUS="test"
export PROVE_BRANCH="test/notify-test"
export PROVE_DETAIL="Test notification from notify-test.sh"

bash "$DISPATCH" "$EVENT_TYPE" 2>&1
EXIT_CODE=$?

# --- Restore dedup state ---

if [[ -f "${STATE_FILE}.bak" ]]; then
  mv "${STATE_FILE}.bak" "$STATE_FILE"
fi

echo ""
echo "=== Results ==="
echo "Dispatched event '$EVENT_TYPE' to $REPORTER_COUNT reporter(s)"

if [[ $EXIT_CODE -ne 0 ]]; then
  echo "WARNING: Dispatch exited with code $EXIT_CODE (reporters are best-effort)"
fi

exit 0
