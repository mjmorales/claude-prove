#!/usr/bin/env bash
# generate-review-prompt.sh — Generate a structured review prompt for the principal-architect agent
#
# Usage:
#   generate-review-prompt.sh <WT_PATH> <TASK_ID> <TASK_PLAN> <PRD> <BASE_BRANCH>
#
# Args:
#   WT_PATH      Path to the task's worktree
#   TASK_ID      Task identifier (e.g., "1.1", "2.3")
#   TASK_PLAN    Path to TASK_PLAN.md
#   PRD          Path to PRD.md (may not exist)
#   BASE_BRANCH  Branch to diff against (e.g., "orchestrator/prompt-audit")
#
# Output: Structured review prompt to stdout

set -eo pipefail

WT_PATH="${1:?Usage: generate-review-prompt.sh <WT_PATH> <TASK_ID> <TASK_PLAN> <PRD> <BASE_BRANCH>}"
TASK_ID="${2:?Missing TASK_ID}"
TASK_PLAN="${3:?Missing TASK_PLAN}"
PRD="${4:?Missing PRD path}"
BASE_BRANCH="${5:?Missing BASE_BRANCH}"

# --- Extract the task section ---

extract_task_section() {
  local plan="$1"
  local task_id="$2"
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

# --- Generate diff and file stats from the worktree ---

DIFF_STAT="$(cd "$WT_PATH" && git diff --stat "$BASE_BRANCH"...HEAD 2>/dev/null || echo "(no diff available)")"
DIFF_CONTENT="$(cd "$WT_PATH" && git diff "$BASE_BRANCH"...HEAD 2>/dev/null || echo "(no diff available)")"
COMMIT_LOG="$(cd "$WT_PATH" && git log --oneline "$BASE_BRANCH"..HEAD 2>/dev/null || echo "(no commits)")"

# --- Extract PRD context if available ---

PRD_CONTEXT=""
if [[ -f "$PRD" ]]; then
  PRD_CONTEXT="$(cat "$PRD")"
fi

# --- Generate the review prompt ---

cat <<PROMPT
You are reviewing Task $TASK_ID as the principal architect.

## Task Requirements

$TASK_SECTION

## Commits

\`\`\`
$COMMIT_LOG
\`\`\`

## Files Changed

\`\`\`
$DIFF_STAT
\`\`\`

## Full Diff

\`\`\`diff
$DIFF_CONTENT
\`\`\`
PROMPT

if [[ -n "$PRD_CONTEXT" ]]; then
  cat <<PROMPT

## Requirements (PRD)

$PRD_CONTEXT
PROMPT
fi

cat <<PROMPT

## Review Criteria

1. **Completeness**: Does the implementation cover all items in the task?
2. **Correctness**: Are there bugs, logic errors, or edge cases missed?
3. **Consistency**: Does the code follow project conventions?
4. **Scope**: Did the implementation stay within task boundaries (no scope creep)?
5. **Quality**: Is the code clean, well-structured, and maintainable?

## Verdict

After reviewing, provide your verdict:
- **APPROVED** — implementation meets all criteria
- **CHANGES_REQUIRED** — list specific items that must be fixed

For CHANGES_REQUIRED, list each finding with:
- File and line reference
- What is wrong
- What should change
PROMPT
