#!/usr/bin/env bash
# dispatch-event.sh — Core event dispatcher for prove orchestrator
#
# Reads .prove.json reporters, fires matching ones for the given event,
# and deduplicates via .prove/dispatch-state.json.
#
# Usage:
#   PROVE_TASK="my-task" PROVE_STEP="1" PROVE_STATUS="done" \
#   PROVE_BRANCH="orchestrator/my-task" PROVE_DETAIL="build:PASS test:PASS" \
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

# Resolve project root (scripts/ lives one level down)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${SCRIPT_DIR%/scripts}"
CONFIG_FILE="${PROJECT_ROOT}/.prove.json"
STATE_FILE="${PROJECT_ROOT}/.prove/dispatch-state.json"

# --- Check configuration ---

if [[ ! -f "$CONFIG_FILE" ]]; then
  # No config, no reporters — silently exit
  exit 0
fi

# --- Deduplication ---

# Build a dedup key from event + step (or event + task if no step)
DEDUP_KEY="${EVENT_TYPE}:${PROVE_STEP:-${PROVE_TASK:-unknown}}"

# Initialize state file if missing
if [[ ! -f "$STATE_FILE" ]]; then
  echo '{"dispatched":[]}' > "$STATE_FILE"
fi

# Check if already dispatched
if command -v jq &>/dev/null; then
  ALREADY=$(jq -r --arg key "$DEDUP_KEY" \
    '.dispatched[] | select(.key == $key) | .key' "$STATE_FILE" 2>/dev/null)
  if [[ -n "$ALREADY" ]]; then
    exit 0
  fi
fi

# --- Parse and fire reporters ---

export PROVE_EVENT="$EVENT_TYPE"
export PROVE_TASK="${PROVE_TASK:-unknown}"
export PROVE_STEP="${PROVE_STEP:-}"
export PROVE_STATUS="${PROVE_STATUS:-unknown}"
export PROVE_BRANCH="${PROVE_BRANCH:-unknown}"
export PROVE_DETAIL="${PROVE_DETAIL:-}"

FIRED=0

python3 -c "
import json, sys

with open(sys.argv[1]) as f:
    config = json.load(f)

reporters = config.get('reporters', [])
event = sys.argv[2]

for r in reporters:
    events = r.get('events', [])
    if event in events:
        name = r.get('name', 'unnamed')
        command = r.get('command', '')
        print(f'{name}\t{command}')
" "$CONFIG_FILE" "$EVENT_TYPE" 2>/dev/null | while IFS=$'\t' read -r name command; do
  [[ -z "$command" ]] && continue
  echo "dispatch-event: firing $name for $EVENT_TYPE" >&2
  # Run reporter from project root, capture exit code but never fail
  (cd "$PROJECT_ROOT" && bash -c "$command") 2>&1 | sed 's/^/  ['"$name"'] /' >&2 || true
  ((FIRED++)) || true
done

# --- Record dispatch ---

if command -v jq &>/dev/null; then
  TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  jq --arg key "$DEDUP_KEY" --arg ts "$TIMESTAMP" --arg evt "$EVENT_TYPE" \
    '.dispatched += [{"key": $key, "event": $evt, "timestamp": $ts}]' \
    "$STATE_FILE" > "${STATE_FILE}.tmp" 2>/dev/null && mv "${STATE_FILE}.tmp" "$STATE_FILE"
fi

exit 0
