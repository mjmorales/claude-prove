#!/usr/bin/env bash
# generate-task-prompt.sh — Generate a self-contained implementation prompt for a worktree agent
#
# Usage:
#   generate-task-prompt.sh <TASK_PLAN> <TASK_ID> <PRD> <PROJECT_ROOT> <WT_PATH>
#
# Args:
#   TASK_PLAN    Path to TASK_PLAN.md
#   TASK_ID      Task identifier (e.g., "1.1", "2.3")
#   PRD          Path to PRD.md (may not exist — that's fine)
#   PROJECT_ROOT Path to the original project root
#   WT_PATH      Path to the task's worktree
#
# Output: Self-contained prompt text to stdout

set -eo pipefail

TASK_PLAN="${1:?Usage: generate-task-prompt.sh <TASK_PLAN> <TASK_ID> <PRD> <PROJECT_ROOT> <WT_PATH>}"
TASK_ID="${2:?Missing TASK_ID}"
PRD="${3:?Missing PRD path}"
PROJECT_ROOT="${4:?Missing PROJECT_ROOT}"
WT_PATH="${5:?Missing WT_PATH}"

# --- Extract the task section from TASK_PLAN.md ---
# Tasks use headers: ### Task 1.1: Name
# Extract from the matching header to the next ### Task header (or end of file)

extract_task_section() {
  local plan="$1"
  local task_id="$2"

  # Escape dots for regex
  local escaped_id="${task_id//./\\.}"

  awk -v id="$escaped_id" '
    /^### Task / {
      if (found) exit
      if ($0 ~ "^### Task " id ":") found=1
    }
    found { print }
  ' "$plan"
}

TASK_SECTION="$(extract_task_section "$TASK_PLAN" "$TASK_ID")"

if [[ -z "$TASK_SECTION" ]]; then
  echo "Error: Could not find Task $TASK_ID in $TASK_PLAN" >&2
  exit 1
fi

# --- Extract plan summary (everything before Implementation Steps) ---

PLAN_SUMMARY="$(awk '
  /^## Implementation Steps/ { exit }
  { print }
' "$TASK_PLAN")"

# --- Extract PRD context if it exists ---

PRD_CONTEXT=""
if [[ -f "$PRD" ]]; then
  PRD_CONTEXT="$(cat "$PRD")"
fi

# --- Read CLAUDE.md if present ---

CLAUDE_MD=""
if [[ -f "$PROJECT_ROOT/CLAUDE.md" ]]; then
  CLAUDE_MD="$(cat "$PROJECT_ROOT/CLAUDE.md")"
fi

# --- Generate the prompt ---

cat <<PROMPT
You are an implementation agent working in a git worktree.

## Working Directory

All your work happens in: \`$WT_PATH\`
Always use absolute paths rooted at this worktree.
The original project root is: \`$PROJECT_ROOT\`

## Task Assignment

$TASK_SECTION

## Plan Context

$PLAN_SUMMARY
PROMPT

if [[ -n "$PRD_CONTEXT" ]]; then
  cat <<PROMPT

## Requirements (PRD)

$PRD_CONTEXT
PROMPT
fi

if [[ -n "$CLAUDE_MD" ]]; then
  cat <<PROMPT

## Project Conventions (CLAUDE.md)

$CLAUDE_MD
PROMPT
fi

cat <<PROMPT

## Rules

- Implement ONLY what is described in the task section above
- Do not refactor or improve code beyond the task scope
- Run build/lint/test validators after completing your changes
- Commit your work with: \`<type>(<scope>): <description>\`
- Stage specific files — never use \`git add -A\`
- If you encounter ambiguity, make a reasonable choice and document it in your commit message
PROMPT
