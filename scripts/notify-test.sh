#!/usr/bin/env bash
# notify-test.sh — Test the notification pipeline configured in .prove.json
#
# Usage:
#   notify-test.sh [event-type]
#
# Sends a test event through all configured reporters. If an event type is
# provided, only reporters subscribed to that event are tested. Defaults to
# "step-complete" when no event type is given.
#
# Exit codes:
#   0 — all tested reporters succeeded
#   1 — one or more reporters failed (or configuration missing)
#   2 — no reporters matched the event (nothing was tested)

set -uo pipefail

EVENT_TYPE="${1:-step-complete}"
CONFIG_FILE=".prove.json"
FAILED=0
TESTED=0

# --- Check configuration ---

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "ERROR: $CONFIG_FILE not found in the current directory."
  echo "Run /prove:notify-setup to configure reporters."
  exit 1
fi

# --- Parse reporters from .prove.json using python3 ---

REPORTERS_JSON=$(python3 -c "
import json, sys

with open(sys.argv[1]) as f:
    config = json.load(f)

reporters = config.get('reporters', [])
if not reporters:
    print('__NONE__')
    sys.exit(0)

for r in reporters:
    name = r.get('name', 'unnamed')
    command = r.get('command', '')
    events = ','.join(r.get('events', []))
    print(f'{name}\t{command}\t{events}')
" "$CONFIG_FILE" 2>&1) || {
  echo "ERROR: Failed to parse $CONFIG_FILE."
  echo "Ensure it contains valid JSON with a 'reporters' array."
  exit 1
}

if [[ "$REPORTERS_JSON" == "__NONE__" ]]; then
  echo "No reporters configured in $CONFIG_FILE."
  echo "Run /prove:notify-setup to add reporters."
  exit 1
fi

# --- Set test environment variables ---

export PROVE_EVENT="$EVENT_TYPE"
export PROVE_TASK="test-notification"
export PROVE_STEP="0"
export PROVE_STATUS="test"
export PROVE_BRANCH="test/notify-test"

echo "=== Notify Test ==="
echo "Event: $EVENT_TYPE"
echo ""

# --- Test each reporter ---

while IFS=$'\t' read -r name command events; do
  # Skip empty lines
  [[ -z "$name" ]] && continue

  # Check if reporter is subscribed to this event
  if [[ -n "$events" ]]; then
    if ! echo ",$events," | grep -q ",$EVENT_TYPE,"; then
      echo "  SKIP: $name (not subscribed to '$EVENT_TYPE')"
      continue
    fi
  fi

  # Execute the reporter command (failures are caught below)
  echo "  TEST: $name → $command"
  bash -c "$command" 2>&1 | sed 's/^/       /'
  exit_code=${PIPESTATUS[0]}
  if [ "$exit_code" -eq 0 ]; then
    echo "  PASS: $name"
  else
    echo "  FAIL: $name (exit code: $exit_code)"
    ((FAILED++)) || true
  fi
  ((TESTED++)) || true

done <<< "$REPORTERS_JSON"

# --- Summary ---

echo ""
echo "=== Results ==="
echo "Tested: $TESTED | Passed: $((TESTED - FAILED)) | Failed: $FAILED"

if [[ $FAILED -gt 0 ]]; then
  exit 1
fi

if [[ $TESTED -eq 0 ]]; then
  echo "No reporters matched event '$EVENT_TYPE' — nothing was actually tested."
  exit 2
fi

exit 0
