#!/usr/bin/env bash
# post-tool-use.sh — Claude Code PostToolUse hook for Bash commands.
#
# Detects orchestrator git commits and merges, then dispatches reporter
# events via scripts/dispatch-event.sh. Runs async — never blocks.
#
# Run state is read from .prove/runs/<branch>/<slug>/state.json (via the
# run_state CLI). Commit messages carry a [WIP] marker for halted steps;
# step completion pulls the current step id from state.json.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DISPATCH="${SCRIPT_DIR}/../dispatch-event.sh"
PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$(pwd)}"

INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)
if [[ "$TOOL_NAME" != "Bash" ]]; then
  exit 0
fi

TOOL_INPUT=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
TOOL_OUTPUT=$(echo "$INPUT" | jq -r '.tool_output // empty' 2>/dev/null)

# Resolve the main worktree root for .prove/runs/ access
MAIN_ROOT=$(git -C "$PROJECT_ROOT" worktree list --porcelain 2>/dev/null | awk '/^worktree /{print substr($0,10); exit}')
MAIN_ROOT="${MAIN_ROOT:-$PROJECT_ROOT}"

_find_run_branch() {
  local slug="$1"
  for candidate in "${MAIN_ROOT}/.prove/runs"/*/"${slug}"/state.json; do
    if [[ -f "$candidate" ]]; then
      basename "$(dirname "$(dirname "$candidate")")"
      return 0
    fi
  done
  return 1
}

# --- Orchestrator commits ---

if echo "$TOOL_INPUT" | grep -q 'git commit'; then
  if echo "$TOOL_INPUT" | grep -qE 'orchestrator:|orchestrator/'; then
    BRANCH=$(cd "$PROJECT_ROOT" && git branch --show-current 2>/dev/null || echo "unknown")
    SLUG="${BRANCH#orchestrator/}"
    RUN_BRANCH=$(_find_run_branch "$SLUG" || echo "")

    # Pull current step id from state.json (if present)
    STEP=""
    if [[ -n "$RUN_BRANCH" ]]; then
      STEP=$(PROVE_RUN_BRANCH="$RUN_BRANCH" PROVE_RUN_SLUG="$SLUG" \
        python3 -m tools.run_state current --format json 2>/dev/null \
        | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('current_step') or '')" 2>/dev/null || echo "")
    fi

    if echo "$TOOL_INPUT" | grep -q '\[WIP\]'; then
      PROVE_TASK="$SLUG" \
      PROVE_RUN_SLUG="$SLUG" \
      PROVE_RUN_BRANCH="$RUN_BRANCH" \
      PROVE_STEP="$STEP" \
      PROVE_STATUS="halted" \
      PROVE_BRANCH="$BRANCH" \
      PROVE_DETAIL="Validation failed" \
      bash "$DISPATCH" "step-halted"
    else
      PROVE_TASK="$SLUG" \
      PROVE_RUN_SLUG="$SLUG" \
      PROVE_RUN_BRANCH="$RUN_BRANCH" \
      PROVE_STEP="$STEP" \
      PROVE_STATUS="done" \
      PROVE_BRANCH="$BRANCH" \
      PROVE_DETAIL="Commit successful" \
      bash "$DISPATCH" "step-complete"
    fi
  fi
fi

# --- Orchestrator merges (wave-complete) ---

if echo "$TOOL_INPUT" | grep -qE 'git merge.*orchestrator/|git merge.*--no-ff'; then
  if echo "$TOOL_OUTPUT" | grep -qv 'CONFLICT'; then
    BRANCH=$(cd "$PROJECT_ROOT" && git branch --show-current 2>/dev/null || echo "unknown")
    SLUG="${BRANCH#orchestrator/}"
    RUN_BRANCH=$(_find_run_branch "$SLUG" || echo "")
    PROVE_TASK="$SLUG" \
    PROVE_RUN_SLUG="$SLUG" \
    PROVE_RUN_BRANCH="$RUN_BRANCH" \
    PROVE_STATUS="merged" \
    PROVE_BRANCH="$BRANCH" \
    PROVE_DETAIL="Merge completed" \
    bash "$DISPATCH" "wave-complete"
  fi
fi

exit 0
