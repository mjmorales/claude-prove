#!/usr/bin/env bash
# subagent-stop.sh — Claude Code SubagentStop hook.
#
# Detects principal-architect review verdicts and validation-agent results
# from the subagent's output, then dispatches reporter events.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DISPATCH="${SCRIPT_DIR}/../dispatch-event.sh"
PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$(pwd)}"
MAIN_ROOT=$(git -C "$PROJECT_ROOT" worktree list --porcelain 2>/dev/null | awk '/^worktree /{print substr($0,10); exit}')
MAIN_ROOT="${MAIN_ROOT:-$PROJECT_ROOT}"

INPUT=$(cat)

AGENT_TYPE=$(echo "$INPUT" | jq -r '.agent_type // empty' 2>/dev/null)
AGENT_OUTPUT=$(echo "$INPUT" | jq -r '.tool_output // .output // empty' 2>/dev/null)

BRANCH=$(cd "$PROJECT_ROOT" && git branch --show-current 2>/dev/null || echo "")
if [[ "$BRANCH" != orchestrator/* ]]; then
  exit 0
fi
SLUG="${BRANCH#orchestrator/}"

# Resolve run branch namespace from the state.json location
RUN_BRANCH=""
for candidate in "${MAIN_ROOT}/.prove/runs"/*/"${SLUG}"/state.json; do
  if [[ -f "$candidate" ]]; then
    RUN_BRANCH="$(basename "$(dirname "$(dirname "$candidate")")")"
    break
  fi
done

_fire() {
  local event="$1" status="$2" detail="$3"
  PROVE_TASK="$SLUG" \
  PROVE_RUN_SLUG="$SLUG" \
  PROVE_RUN_BRANCH="$RUN_BRANCH" \
  PROVE_STATUS="$status" \
  PROVE_BRANCH="$BRANCH" \
  PROVE_DETAIL="$detail" \
  bash "$DISPATCH" "$event"
}

# --- Principal Architect review verdicts ---

if [[ "$AGENT_TYPE" == "principal-architect" || "$AGENT_TYPE" == "prove:principal-architect" ]]; then
  if echo "$AGENT_OUTPUT" | grep -qi "APPROVED"; then
    ROUNDS=$(echo "$AGENT_OUTPUT" | grep -oiE 'after [0-9]+ round' | grep -oE '[0-9]+' | head -1)
    _fire "review-approved" "approved" "APPROVED after ${ROUNDS:-1} round(s)"
  elif echo "$AGENT_OUTPUT" | grep -qi "CHANGES_REQUIRED"; then
    FINDINGS=$(echo "$AGENT_OUTPUT" | grep -oiE '[0-9]+ finding' | grep -oE '[0-9]+' | head -1)
    _fire "review-rejected" "changes-required" "${FINDINGS:-some} findings"
  fi
fi

# --- Validation agent results ---

if [[ "$AGENT_TYPE" == "validation-agent" || "$AGENT_TYPE" == "prove:validation-agent" ]]; then
  if echo "$AGENT_OUTPUT" | grep -qi "PASS"; then
    VALIDATOR=$(echo "$AGENT_OUTPUT" | grep -oiE 'validator:? ?[a-z0-9_-]+' | head -1 | sed 's/validator:* *//')
    _fire "validation-pass" "pass" "${VALIDATOR:-llm-validator}"
  elif echo "$AGENT_OUTPUT" | grep -qi "FAIL"; then
    FINDINGS=$(echo "$AGENT_OUTPUT" | grep -oiE '[0-9]+ finding' | grep -oE '[0-9]+' | head -1)
    VALIDATOR=$(echo "$AGENT_OUTPUT" | grep -oiE 'validator:? ?[a-z0-9_-]+' | head -1 | sed 's/validator:* *//')
    _fire "validation-fail" "fail" "${FINDINGS:-some} findings in ${VALIDATOR:-llm-validator}"
  fi
fi

exit 0
