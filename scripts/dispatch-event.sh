#!/usr/bin/env bash
# dispatch-event.sh — Core event dispatcher for prove orchestrator
#
# Reads .prove.json reporters, fires matching ones for the given event,
# and deduplicates via .prove/runs/<slug>/dispatch-state.json.
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

# Resolve project root.
# CLAUDE_PROJECT_DIR or cwd may be a worktree, which has .prove.json (tracked)
# but NOT .prove/ (gitignored). Use git to find the main worktree for .prove/ artifacts.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
MAIN_ROOT=$(git -C "$WORK_DIR" worktree list --porcelain 2>/dev/null | awk '/^worktree /{print substr($0,10); exit}')
MAIN_ROOT="${MAIN_ROOT:-$WORK_DIR}"
# Config (.prove.json) is tracked — read from current worktree (guaranteed up-to-date)
CONFIG_FILE="${WORK_DIR}/.prove.json"
# Reporter scripts live in .prove/ (gitignored) — always in main worktree
REPORTER_ROOT="${MAIN_ROOT}"

# Derive run slug from PROVE_TASK env var or branch name for namespaced state
RUN_SLUG="${PROVE_TASK:-}"
if [[ -z "$RUN_SLUG" ]]; then
  BRANCH=$(cd "$WORK_DIR" && git branch --show-current 2>/dev/null || echo "")
  if [[ "$BRANCH" == orchestrator/* ]]; then
    RUN_SLUG="${BRANCH#orchestrator/}"
  fi
fi

# State is namespaced per run under .prove/runs/<slug>/ (supports concurrent orchestrators)
if [[ -z "$RUN_SLUG" ]]; then
  # No orchestrator context — nothing to deduplicate against
  exit 0
fi

STATE_DIR="${MAIN_ROOT}/.prove/runs/${RUN_SLUG}"
mkdir -p "$STATE_DIR" 2>/dev/null || true
STATE_FILE="${STATE_DIR}/dispatch-state.json"

# --- Check configuration ---

if [[ ! -f "$CONFIG_FILE" ]]; then
  # No config, no reporters — silently exit
  exit 0
fi

# --- Deduplication (with file locking for parallel worktree safety) ---

# Build a dedup key from event + step (or event + task if no step)
DEDUP_KEY="${EVENT_TYPE}:${PROVE_STEP:-${PROVE_TASK:-unknown}}"
LOCK_FILE="${STATE_FILE}.lock"

# Initialize state file if missing
if [[ ! -f "$STATE_FILE" ]]; then
  echo '{"dispatched":[]}' > "$STATE_FILE"
fi

# Acquire lock (wait up to 5s, then proceed anyway — best-effort)
exec 9>"$LOCK_FILE"
flock -w 5 9 2>/dev/null || true

# Check if already dispatched
if command -v jq &>/dev/null; then
  ALREADY=$(jq -r --arg key "$DEDUP_KEY" \
    '.dispatched[] | select(.key == $key) | .key' "$STATE_FILE" 2>/dev/null)
  if [[ -n "$ALREADY" ]]; then
    exec 9>&-  # release lock
    exit 0
  fi
else
  echo "  ⚠ jq not found — deduplication disabled, all reporters will fire" >&2
fi

# --- Parse and fire reporters ---

export PROVE_EVENT="$EVENT_TYPE"
export PROVE_TASK="${PROVE_TASK:-unknown}"
export PROVE_STEP="${PROVE_STEP:-}"
export PROVE_STATUS="${PROVE_STATUS:-unknown}"
export PROVE_BRANCH="${PROVE_BRANCH:-unknown}"
export PROVE_DETAIL="${PROVE_DETAIL:-}"

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
  # Run reporter from main worktree root (where .prove/ scripts live)
  (cd "$REPORTER_ROOT" && bash -c "$command") 2>&1 | sed 's/^/  ['"$name"'] /' >&2 || true
done

# --- Record dispatch ---

if command -v jq &>/dev/null; then
  TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  jq --arg key "$DEDUP_KEY" --arg ts "$TIMESTAMP" --arg evt "$EVENT_TYPE" \
    '.dispatched += [{"key": $key, "event": $evt, "timestamp": $ts}]' \
    "$STATE_FILE" > "${STATE_FILE}.tmp" 2>/dev/null && mv "${STATE_FILE}.tmp" "$STATE_FILE"
fi

# Release lock
exec 9>&- 2>/dev/null || true

exit 0
