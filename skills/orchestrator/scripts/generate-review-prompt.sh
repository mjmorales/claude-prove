#!/usr/bin/env bash
# generate-review-prompt.sh — Build a principal-architect review prompt from JSON artifacts.
#
# Usage: generate-review-prompt.sh <worktree-path> <task-id> <run-dir> <base-branch>

set -euo pipefail

WORKTREE_PATH="$1"
TASK_ID="$2"
RUN_DIR="$3"
BASE_BRANCH="$4"

PLAN="${RUN_DIR}/plan.json"
PRD="${RUN_DIR}/prd.json"

if [[ ! -f "$PLAN" || ! -f "$PRD" ]]; then
  echo "ERROR: plan.json/prd.json missing under $RUN_DIR" >&2
  exit 1
fi

DIFF=$(cd "$WORKTREE_PATH" && git diff "$BASE_BRANCH"...HEAD -- . 2>/dev/null || git diff HEAD~1 -- . 2>/dev/null || echo "ERROR: Could not generate diff")
FILES_CHANGED=$(cd "$WORKTREE_PATH" && git diff --name-only "$BASE_BRANCH"...HEAD 2>/dev/null || git diff --name-only HEAD~1 2>/dev/null || echo "unknown")

_ALL=$(python3 - "$PLAN" "$PRD" "$TASK_ID" <<'PY'
import json, sys
plan = json.load(open(sys.argv[1]))
prd = json.load(open(sys.argv[2]))
task_id = sys.argv[3]

task = next((t for t in plan.get("tasks", []) if t["id"] == task_id), None)
if task is None:
    sys.stderr.write(f"ERROR: task {task_id} not found\n")
    sys.exit(1)

def block(label, value):
    print(f"<<<{label}>>>"); print(value or ""); print(f"<<</{label}>>>")

block("TASK_TITLE", task.get("title", ""))
block("TASK_DESC", task.get("description", ""))
block("TASK_AC", "\n".join(f"- {c}" for c in task.get("acceptance_criteria", [])))
block("PRD_AC", "\n".join(f"- {c}" for c in prd.get("acceptance_criteria", [])))
PY
)

_get() {
  awk -v lbl="$1" '
    $0 == "<<<" lbl ">>>" { capture=1; next }
    $0 == "<<</" lbl ">>>" { capture=0 }
    capture { print }
  ' <<<"$_ALL"
}

TASK_TITLE=$(_get TASK_TITLE)
TASK_DESC=$(_get TASK_DESC)
TASK_AC=$(_get TASK_AC)
PRD_AC=$(_get PRD_AC)

cat <<PROMPT
# Architectural Review: Task $TASK_ID — $TASK_TITLE

You are reviewing code produced by an implementation agent. Your job is to ensure
the code meets quality standards BEFORE it can be merged.

## Review Protocol

Evaluate every item below. For each item, mark PASS or FAIL with a brief reason.
The task CANNOT be approved if ANY item is FAIL.

### Checklist

1. **Scope Compliance** — Does the diff ONLY touch files specified in the task?
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

$TASK_DESC

$(if [[ -n "$TASK_AC" ]]; then printf "### Task Acceptance Criteria\n\n%s\n" "$TASK_AC"; fi)

## PRD Acceptance Criteria

$PRD_AC

## Diff to Review

\`\`\`diff
$DIFF
\`\`\`

## Output Format

Output your review in this exact format:

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
- Be specific. "Function foo() on line 42 has an unused parameter 'bar'" beats "code quality is bad".
- Do NOT approve code that has ANY failing checklist items.
- Do NOT suggest nice-to-haves as required changes — only flag real issues.
PROMPT
