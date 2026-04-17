#!/usr/bin/env bash
# generate-task-prompt.sh — Build a worktree implementation agent prompt from JSON artifacts.
#
# Usage: generate-task-prompt.sh <run-dir> <task-id> <project-root> [worktree-path]
#
# Reads plan.json + prd.json from <run-dir>, extracts the task detail and PRD
# fields, then emits a self-contained prompt for a worktree agent.

set -euo pipefail

RUN_DIR="$1"
TASK_ID="$2"
PROJECT_ROOT="$3"
WORKTREE_PATH="${4:-}"

PLAN="${RUN_DIR}/plan.json"
PRD="${RUN_DIR}/prd.json"

if [[ ! -f "$PLAN" ]]; then
  echo "ERROR: plan.json not found at $PLAN" >&2
  exit 1
fi
if [[ ! -f "$PRD" ]]; then
  echo "ERROR: prd.json not found at $PRD" >&2
  exit 1
fi

# Extract task detail + PRD fields + validators in one Python call.
_ALL=$(python3 - "$PLAN" "$PRD" "$TASK_ID" "$PROJECT_ROOT" <<'PY'
import json, sys, os

plan_path, prd_path, task_id, project_root = sys.argv[1:5]
plan = json.load(open(plan_path))
prd = json.load(open(prd_path))

task = next((t for t in plan.get("tasks", []) if t["id"] == task_id), None)
if task is None:
    sys.stderr.write(f"ERROR: task {task_id} not found in {plan_path}\n")
    sys.exit(1)

def block(label, value):
    print(f"<<<{label}>>>")
    print(value if value is not None else "")
    print(f"<<</{label}>>>")

block("TASK_NAME", task.get("title", ""))
block("TASK_DESC", task.get("description", ""))
ac = task.get("acceptance_criteria") or []
block("TASK_AC", "\n".join(f"- {c}" for c in ac))

steps = task.get("steps") or []
if steps:
    block("TASK_STEPS", "\n".join(f"- `{s['id']}` {s.get('title','')}" for s in steps))
else:
    block("TASK_STEPS", "")

block("PRD_AC", "\n".join(f"- {c}" for c in prd.get("acceptance_criteria", [])))
block("PRD_TEST_STRATEGY", prd.get("test_strategy", ""))

# Validators
cfg_path = os.path.join(project_root, ".claude", ".prove.json")
build = lint = test = custom = ""
llm_lines = []
if os.path.isfile(cfg_path):
    cfg = json.load(open(cfg_path))
    vs = cfg.get("validators", [])
    build = "; ".join(v["command"] for v in vs if v.get("phase") == "build" and v.get("command"))
    lint = "; ".join(v["command"] for v in vs if v.get("phase") == "lint" and v.get("command"))
    test = "; ".join(v["command"] for v in vs if v.get("phase") == "test" and v.get("command"))
    custom = "; ".join(v["command"] for v in vs if v.get("phase") == "custom" and v.get("command"))
    for v in vs:
        if v.get("prompt"):
            llm_lines.append(f"   - **{v['name']}**: `{v['prompt']}`")
block("BUILD_CMD", build)
block("LINT_CMD", lint)
block("TEST_CMD", test)
block("CUSTOM_CMD", custom)
block("LLM_VALIDATORS", "\n".join(llm_lines))
PY
)

_get() {
  # Extract content between <<<LABEL>>> and <<</LABEL>>>
  awk -v lbl="$1" '
    $0 == "<<<" lbl ">>>" { capture=1; next }
    $0 == "<<</" lbl ">>>" { capture=0 }
    capture { print }
  ' <<<"$_ALL"
}

TASK_NAME=$(_get TASK_NAME)
TASK_DESC=$(_get TASK_DESC)
TASK_AC=$(_get TASK_AC)
TASK_STEPS=$(_get TASK_STEPS)
PRD_AC=$(_get PRD_AC)
PRD_TEST_STRATEGY=$(_get PRD_TEST_STRATEGY)
BUILD_CMD=$(_get BUILD_CMD)
LINT_CMD=$(_get LINT_CMD)
TEST_CMD=$(_get TEST_CMD)
CUSTOM_CMD=$(_get CUSTOM_CMD)
LLM_VALIDATORS=$(_get LLM_VALIDATORS)

cat <<PROMPT
$(if [[ -n "$WORKTREE_PATH" ]]; then
cat <<WORKTREE_BLOCK
## Worktree

You are working in a pre-created worktree. Before doing anything else, change into it:

\`\`\`bash
cd $WORKTREE_PATH
\`\`\`

All file reads, edits, and git commands must happen inside this directory.
WORKTREE_BLOCK
fi)

You are implementing **Task $TASK_ID: $TASK_NAME**

## Task Details

$TASK_DESC

$(if [[ -n "$TASK_AC" ]]; then printf "## Task Acceptance Criteria\n\n%s\n" "$TASK_AC"; fi)

$(if [[ -n "$TASK_STEPS" ]]; then printf "## Steps\n\n%s\n" "$TASK_STEPS"; fi)

## Acceptance Criteria (from PRD)

$PRD_AC

$(if [[ -n "$PRD_TEST_STRATEGY" ]]; then printf "## Test Strategy (from PRD)\n\n%s\n" "$PRD_TEST_STRATEGY"; fi)

## Implementation Rules

1. **Read first** — Before modifying any file, read it to understand existing patterns and conventions.
2. **Scope discipline** — Only modify files listed in the task. If you discover you need to touch an unlisted file, document why in your commit message.
3. **Tests alongside code** — Write tests as specified in the task. Do not skip tests.
4. **Verify before committing**:
$(if [[ -n "$BUILD_CMD" ]]; then echo "   - Build: \`$BUILD_CMD\`"; fi)
$(if [[ -n "$LINT_CMD" ]]; then echo "   - Lint: \`$LINT_CMD\`"; fi)
$(if [[ -n "$TEST_CMD" ]]; then echo "   - Tests: \`$TEST_CMD\`"; else echo "   - Run the project's test suite (check .claude/.prove.json for the command)"; fi)
$(if [[ -n "$CUSTOM_CMD" ]]; then echo "   - Custom: \`$CUSTOM_CMD\`"; fi)
$(if [[ -n "$LLM_VALIDATORS" ]]; then
  echo "   - LLM validators (your code will be evaluated against these prompt criteria):"
  echo "$LLM_VALIDATORS"
fi)
5. **Commit format**: \`feat({scope}): {task description}\`
6. **Max 3 retry attempts** if tests fail — fix the issue, don't just retry.

## Code Quality Checklist (reviewer will check these)

- [ ] No unused imports or variables
- [ ] No hardcoded values that should be configurable
- [ ] Error handling for edge cases
- [ ] Follows existing naming conventions
- [ ] No code duplication — reuse existing utilities
- [ ] Tests cover happy path AND at least one error case

## Resource Constraints

- **DO NOT** spawn agents with \`isolation: "worktree"\`. You are already in a worktree — nested worktrees cause exponential resource growth.
- **DO NOT** use the Agent tool with \`run_in_background: true\` for heavy workloads. You are a leaf worker, not an orchestrator.

## When Done

Commit your work and exit. The worktree branch will be reviewed by a principal-architect agent before merge.

**Step-state accounting is the orchestrator's job, not yours.** Do NOT call \`scripts/prove-run step-complete\` or any other run_state mutator. Your contract is:

1. Produce at least one commit on this worktree branch containing the intended change.
2. Exit.

The SubagentStop hook reads the latest commit on this worktree and auto-completes the step from it. If you exit without committing, the hook halts the step with a diagnostic so the orchestrator knows to retry. Do NOT merge.
PROMPT
