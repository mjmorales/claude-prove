#!/usr/bin/env bash
# post-tool-use.sh — Claude Code PostToolUse hook for Bash commands
#
# Receives JSON on stdin from Claude Code with tool_name, tool_input, tool_output.
# Detects orchestrator git commits and merges, then dispatches the appropriate event.
#
# This runs async — it must never block the orchestrator.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DISPATCH="${SCRIPT_DIR}/../dispatch-event.sh"
# Use CLAUDE_PROJECT_DIR (set by Claude Code hooks) or fall back to cwd
PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$(pwd)}"

# Read JSON from stdin
INPUT=$(cat)

# Only process Bash tool calls
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)
if [[ "$TOOL_NAME" != "Bash" ]]; then
  exit 0
fi

TOOL_INPUT=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
TOOL_OUTPUT=$(echo "$INPUT" | jq -r '.tool_output // empty' 2>/dev/null)

# --- Detect orchestrator git commits ---

if echo "$TOOL_INPUT" | grep -q 'git commit'; then
  # Check if the commit message has an orchestrator pattern
  if echo "$TOOL_INPUT" | grep -qE 'orchestrator:|orchestrator/'; then
    # Extract branch name
    BRANCH=$(cd "$PROJECT_ROOT" && git branch --show-current 2>/dev/null || echo "unknown")

    # Determine if it's a WIP (halted) or success
    if echo "$TOOL_INPUT" | grep -q '\[WIP\]'; then
      # Step halted — validation failed
      PROVE_TASK="${BRANCH#orchestrator/}" \
      PROVE_STATUS="halted" \
      PROVE_BRANCH="$BRANCH" \
      PROVE_DETAIL="Validation failed" \
      bash "$DISPATCH" "step-halted"
    else
      # Step complete — extract step number from commit message if possible
      STEP=$(echo "$TOOL_INPUT" | grep -oE 'step [0-9]+' | grep -oE '[0-9]+' | head -1)
      PROVE_TASK="${BRANCH#orchestrator/}" \
      PROVE_STEP="${STEP:-}" \
      PROVE_STATUS="done" \
      PROVE_BRANCH="$BRANCH" \
      PROVE_DETAIL="Commit successful" \
      bash "$DISPATCH" "step-complete"
    fi
  fi
fi

# --- Detect orchestrator merges (wave-complete) ---

if echo "$TOOL_INPUT" | grep -qE 'git merge.*orchestrator/|git merge.*--no-ff'; then
  if echo "$TOOL_OUTPUT" | grep -qv 'CONFLICT'; then
    BRANCH=$(cd "$PROJECT_ROOT" && git branch --show-current 2>/dev/null || echo "unknown")
    PROVE_TASK="${BRANCH#orchestrator/}" \
    PROVE_STATUS="merged" \
    PROVE_BRANCH="$BRANCH" \
    PROVE_DETAIL="Merge completed" \
    bash "$DISPATCH" "wave-complete"
  fi
fi

exit 0
