#!/usr/bin/env bash
# generate-task-prompt.sh — Generates a focused prompt for a worktree implementation agent.
#
# Usage: generate-task-prompt.sh <task-plan-path> <task-id> <prd-path> <project-root>
#
# Reads TASK_PLAN.md and PRD, extracts the relevant task detail section,
# and outputs a complete, self-contained prompt for a worktree agent.

set -euo pipefail

TASK_PLAN="$1"
TASK_ID="$2"
PRD="$3"
PROJECT_ROOT="$4"

if [[ ! -f "$TASK_PLAN" ]]; then
  echo "ERROR: TASK_PLAN.md not found at $TASK_PLAN" >&2
  exit 1
fi

if [[ ! -f "$PRD" ]]; then
  echo "ERROR: PRD.md not found at $PRD" >&2
  exit 1
fi

# Extract the task detail section (from "### Task {id}:" to the next "### Task" or "## " heading)
TASK_DETAIL=$(awk -v id="$TASK_ID" '
  /^### Task / {
    if (found) exit
    if ($0 ~ "### Task " id ":") found=1
  }
  /^## / { if (found) exit }
  found { print }
' "$TASK_PLAN")

if [[ -z "$TASK_DETAIL" ]]; then
  echo "ERROR: Task $TASK_ID not found in $TASK_PLAN" >&2
  exit 1
fi

# Extract task name from the detail header
TASK_NAME=$(echo "$TASK_DETAIL" | head -1 | sed 's/^### Task [0-9.]*: //')

# Extract acceptance criteria from PRD
ACCEPTANCE=$(awk '/^## Acceptance Criteria/,/^## [^A]/' "$PRD" | head -30)

# Extract test strategy from PRD
TEST_STRATEGY=$(awk '/^## Test Strategy/,/^## /' "$PRD" | head -20)

# Load validator commands from .prove.json, fall back to CLAUDE.md
BUILD_CMD=""
LINT_CMD=""
TEST_CMD=""
CUSTOM_CMDS=""

if [[ -f "$PROJECT_ROOT/.prove.json" ]]; then
  PROVE_CONFIG="$PROJECT_ROOT/.prove.json"
  BUILD_CMD=$(python3 -c "
import json, sys
with open(sys.argv[1]) as f:
    cfg = json.load(f)
cmds = [v['command'] for v in cfg.get('validators', []) if v.get('phase') == 'build']
print('; '.join(cmds))
" "$PROVE_CONFIG" 2>/dev/null || true)

  LINT_CMD=$(python3 -c "
import json, sys
with open(sys.argv[1]) as f:
    cfg = json.load(f)
cmds = [v['command'] for v in cfg.get('validators', []) if v.get('phase') == 'lint']
print('; '.join(cmds))
" "$PROVE_CONFIG" 2>/dev/null || true)

  TEST_CMD=$(python3 -c "
import json, sys
with open(sys.argv[1]) as f:
    cfg = json.load(f)
cmds = [v['command'] for v in cfg.get('validators', []) if v.get('phase') == 'test']
print('; '.join(cmds))
" "$PROVE_CONFIG" 2>/dev/null || true)

  CUSTOM_CMDS=$(python3 -c "
import json, sys
with open(sys.argv[1]) as f:
    cfg = json.load(f)
cmds = [v['command'] for v in cfg.get('validators', []) if v.get('phase') == 'custom']
print('; '.join(cmds))
" "$PROVE_CONFIG" 2>/dev/null || true)
elif [[ -f "$PROJECT_ROOT/CLAUDE.md" ]]; then
  # Fall back to CLAUDE.md scraping
  TEST_CMD=$(grep -A2 -i '# .*test\|## .*test\|running tests' "$PROJECT_ROOT/CLAUDE.md" | grep -E '^\s*(godot|npm|pytest|go test|cargo test|make test)' | head -1 | xargs 2>/dev/null || true)
  LINT_CMD=$(grep -A2 -i 'lint\|format' "$PROJECT_ROOT/CLAUDE.md" | grep -E '^\s*(npm|npx|go |cargo |make )' | head -1 | xargs 2>/dev/null || true)
fi

# Output the prompt
cat <<PROMPT
You are implementing **Task $TASK_ID: $TASK_NAME**

## Task Details
$TASK_DETAIL

## Acceptance Criteria (from PRD)
$ACCEPTANCE

## Test Strategy (from PRD)
$TEST_STRATEGY

## Implementation Rules

1. **Read first** — Before modifying any file, read it to understand existing patterns and conventions.
2. **Scope discipline** — Only modify files listed in the task. If you discover you need to touch an unlisted file, document why in your commit message.
3. **Tests alongside code** — Write tests as specified in the task. Do not skip tests.
4. **Verify before committing**:
$(if [[ -n "$BUILD_CMD" ]]; then echo "   - Build: \`$BUILD_CMD\`"; fi)
$(if [[ -n "$LINT_CMD" ]]; then echo "   - Lint: \`$LINT_CMD\`"; fi)
$(if [[ -n "$TEST_CMD" ]]; then echo "   - Tests: \`$TEST_CMD\`"; else echo "   - Run the project's test suite (check CLAUDE.md or .prove.json for the command)"; fi)
$(if [[ -n "$CUSTOM_CMDS" ]]; then echo "   - Custom: \`$CUSTOM_CMDS\`"; fi)
5. **Commit format**: \`feat({scope}): {task description}\`
6. **Max 3 retry attempts** if tests fail — fix the issue, don't just retry.

## Code Quality Checklist (reviewer will check these)
- [ ] No unused imports or variables
- [ ] No hardcoded values that should be configurable
- [ ] Error handling for edge cases
- [ ] Follows existing naming conventions
- [ ] No code duplication — reuse existing utilities
- [ ] Tests cover happy path AND at least one error case

## When Done
Commit your work. The worktree branch will be reviewed by a principal-architect agent before merge.
Do NOT merge — just commit.
PROMPT
