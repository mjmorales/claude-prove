#!/usr/bin/env bash
# subagent-stop.sh — Claude Code SubagentStop hook
#
# Receives JSON on stdin from Claude Code with agent_type and agent output.
# Detects principal-architect review verdicts and validation-agent results,
# then dispatches the appropriate event.
#
# This runs async — it must never block the orchestrator.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DISPATCH="${SCRIPT_DIR}/../dispatch-event.sh"
PROJECT_ROOT="${SCRIPT_DIR%/scripts/hooks}"

# Read JSON from stdin
INPUT=$(cat)

AGENT_TYPE=$(echo "$INPUT" | jq -r '.agent_type // empty' 2>/dev/null)
AGENT_OUTPUT=$(echo "$INPUT" | jq -r '.tool_output // .output // empty' 2>/dev/null)

# Current branch context
BRANCH=$(cd "$PROJECT_ROOT" && git branch --show-current 2>/dev/null || echo "unknown")
TASK="${BRANCH#orchestrator/}"

# Only process if we're on an orchestrator branch
if [[ "$BRANCH" != orchestrator/* ]]; then
  exit 0
fi

# --- Principal Architect review verdicts ---

if [[ "$AGENT_TYPE" == "principal-architect" || "$AGENT_TYPE" == "prove:principal-architect" ]]; then
  if echo "$AGENT_OUTPUT" | grep -qi "APPROVED"; then
    # Extract round count if present
    ROUNDS=$(echo "$AGENT_OUTPUT" | grep -oiE 'after [0-9]+ round' | grep -oE '[0-9]+' | head -1)
    PROVE_TASK="$TASK" \
    PROVE_STATUS="approved" \
    PROVE_BRANCH="$BRANCH" \
    PROVE_DETAIL="APPROVED after ${ROUNDS:-1} round(s)" \
    bash "$DISPATCH" "review-approved"
  elif echo "$AGENT_OUTPUT" | grep -qi "CHANGES_REQUIRED"; then
    # Extract finding count if present
    FINDINGS=$(echo "$AGENT_OUTPUT" | grep -oiE '[0-9]+ finding' | grep -oE '[0-9]+' | head -1)
    PROVE_TASK="$TASK" \
    PROVE_STATUS="changes-required" \
    PROVE_BRANCH="$BRANCH" \
    PROVE_DETAIL="${FINDINGS:-some} findings" \
    bash "$DISPATCH" "review-rejected"
  fi
fi

# --- Validation agent results ---

if [[ "$AGENT_TYPE" == "validation-agent" || "$AGENT_TYPE" == "prove:validation-agent" ]]; then
  if echo "$AGENT_OUTPUT" | grep -qi "PASS"; then
    VALIDATOR=$(echo "$AGENT_OUTPUT" | grep -oiE 'validator:? ?[a-z0-9_-]+' | head -1 | sed 's/validator:* *//')
    PROVE_TASK="$TASK" \
    PROVE_STATUS="pass" \
    PROVE_BRANCH="$BRANCH" \
    PROVE_DETAIL="${VALIDATOR:-llm-validator}" \
    bash "$DISPATCH" "validation-pass"
  elif echo "$AGENT_OUTPUT" | grep -qi "FAIL"; then
    FINDINGS=$(echo "$AGENT_OUTPUT" | grep -oiE '[0-9]+ finding' | grep -oE '[0-9]+' | head -1)
    VALIDATOR=$(echo "$AGENT_OUTPUT" | grep -oiE 'validator:? ?[a-z0-9_-]+' | head -1 | sed 's/validator:* *//')
    PROVE_TASK="$TASK" \
    PROVE_STATUS="fail" \
    PROVE_BRANCH="$BRANCH" \
    PROVE_DETAIL="${FINDINGS:-some} findings in ${VALIDATOR:-llm-validator}" \
    bash "$DISPATCH" "validation-fail"
  fi
fi

exit 0
