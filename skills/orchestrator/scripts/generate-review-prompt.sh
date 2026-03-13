#!/usr/bin/env bash
# generate-review-prompt.sh — Generates a review prompt for the principal-architect agent.
#
# Usage: generate-review-prompt.sh <worktree-path> <task-id> <task-plan-path> <prd-path> <base-branch>
#
# Produces a self-contained review prompt that includes the diff, task spec,
# and a structured checklist the reviewer must evaluate against.

set -euo pipefail

WORKTREE_PATH="$1"
TASK_ID="$2"
TASK_PLAN="$3"
PRD="$4"
BASE_BRANCH="$5"

# Get the diff of changes in the worktree branch vs base
DIFF=$(cd "$WORKTREE_PATH" && git diff "$BASE_BRANCH"...HEAD -- . 2>/dev/null || git diff HEAD~1 -- . 2>/dev/null || echo "ERROR: Could not generate diff")

# Extract task detail from plan
TASK_DETAIL=$(awk -v id="$TASK_ID" '
  /^### Task / {
    if (found) exit
    if ($0 ~ "### Task " id ":") found=1
  }
  /^## / { if (found) exit }
  found { print }
' "$TASK_PLAN")

# Extract acceptance criteria from PRD
ACCEPTANCE=$(awk '/^## Acceptance Criteria/,/^## [^A]/' "$PRD" | head -30)

# List files changed
FILES_CHANGED=$(cd "$WORKTREE_PATH" && git diff --name-only "$BASE_BRANCH"...HEAD 2>/dev/null || git diff --name-only HEAD~1 2>/dev/null || echo "unknown")

cat <<PROMPT
# Architectural Review: Task $TASK_ID

You are reviewing code produced by an implementation agent. Your job is to ensure
the code meets quality standards BEFORE it can be merged.

## Review Protocol

You MUST evaluate every item below. For each item, mark PASS or FAIL with a brief reason.
The task CANNOT be approved if ANY item is FAIL.

### Checklist

1. **Scope Compliance** — Does the diff ONLY touch files specified in the task?
   Files specified: see task details below
   Files actually changed: $FILES_CHANGED

2. **Correctness** — Does the implementation match the task description and acceptance criteria?

3. **Code Quality**
   - No unused imports, variables, or dead code
   - No hardcoded values that should be constants/config
   - Follows existing naming conventions in the codebase
   - No unnecessary abstractions or over-engineering
   - DRY — reuses existing utilities where appropriate

4. **Error Handling** — Appropriate error handling for edge cases (but no over-defensive code)

5. **Tests**
   - Tests exist as specified in the task
   - Tests cover happy path AND at least one error/edge case
   - Tests are deterministic (no flaky timing, no test-order dependencies)

6. **Consistency** — Matches patterns and conventions used elsewhere in the codebase

7. **No Regressions** — Changes don't break existing functionality (check imports, exports, interfaces)

## Task Specification
$TASK_DETAIL

## Acceptance Criteria
$ACCEPTANCE

## Diff to Review
\`\`\`diff
$DIFF
\`\`\`

## Output Format

You MUST output your review in this exact format:

\`\`\`markdown
## Review: Task $TASK_ID

**Verdict**: APPROVED | CHANGES_REQUIRED

### Checklist
| # | Item | Status | Notes |
|---|------|--------|-------|
| 1 | Scope Compliance | PASS/FAIL | ... |
| 2 | Correctness | PASS/FAIL | ... |
| 3 | Code Quality | PASS/FAIL | ... |
| 4 | Error Handling | PASS/FAIL | ... |
| 5 | Tests | PASS/FAIL | ... |
| 6 | Consistency | PASS/FAIL | ... |
| 7 | No Regressions | PASS/FAIL | ... |

### Required Changes (if CHANGES_REQUIRED)
1. [file:line] — What to fix and why
2. ...

### Notes (optional)
- Any observations or suggestions (non-blocking)
\`\`\`

IMPORTANT:
- Be strict. If something is wrong, mark it FAIL.
- Be specific. "Code quality is bad" is not useful. "Function foo() on line 42 has an unused parameter 'bar'" is.
- Do NOT approve code that has ANY failing checklist items.
- Do NOT suggest nice-to-haves as required changes — only flag real issues.
PROMPT
