---
name: orchestrator
description: >
  Autonomous task orchestrator that auto-scales between simple mode (<=3 steps,
  sequential, no worktrees) and full mode (4+ steps, parallel worktrees with
  mandatory principal-architect review). Creates feature branches, runs validation
  gates (build, test, lint), commits after each successful step, generates progress
  reports, and supports rollback via git. Use when a .prove/TASK_PLAN.md or .prove/plans/ directory
  exists and the user wants hands-off execution. Triggers on "orchestrate", "autopilot",
  "full auto", "run autonomously", "implement without me", "hands-off mode".
---

# Orchestrator Skill

Autonomous orchestration skill that executes planned tasks end-to-end. Auto-scales between:

- **Simple mode** (<=3 steps): Sequential execution, no worktrees, lightweight reporting
- **Full mode** (4+ steps): Parallel worktrees, mandatory architect review, full progress tracking

## Prerequisites

Before invoking, one of the following must exist:
- A `.prove/TASK_PLAN.md` with implementation steps (created via `/plan-task`)
- A `.prove/plans/plan_X/` directory with planning docs (created via `/plan-step`)
- Both (ideal)

If neither exists, inform the user and suggest running `/plan-task` first.

---

## Phase 0: Initialization

1. **Validate inputs**
   - Check for `.prove/TASK_PLAN.md` and/or `.prove/plans/` directory
   - Read all available planning documents to understand full scope
   - Extract task name and ordered implementation steps

2. **Auto-scale decision**
   - Count implementation steps
   - **<=3 steps**: Simple mode (sequential, no worktrees)
   - **4+ steps**: Full mode (parallel worktrees + architect review)
   - Log which mode was selected

3. **Create feature branch**
   ```bash
   git checkout -b orchestrator/<task-slug>
   ```
   - Slugify the task name (lowercase, hyphens, no special chars, max 50 chars)
   - If branch already exists, ask user: resume from last commit or start fresh

4. **Initialize report directory**
   ```bash
   mkdir -p .prove/reports/<task-slug>/
   ```
   Create `.prove/reports/<task-slug>/run-log.md`:
   ```markdown
   # Orchestrator Run Log: <Task Name>
   **Branch**: orchestrator/<task-slug>
   **Mode**: Simple | Full
   **Started**: <ISO timestamp>
   **Status**: In Progress

   ## Configuration
   - Mode: <Simple|Full>
   - Validators: <loaded from .prove.json or auto-detected>
   - Steps: <total count>

   ## Step Log
   | # | Step | Status | Commit | Notes |
   |---|------|--------|--------|-------|
   ```

5. **Load validators** from `.prove.json` or auto-detect per `references/validation-config.md`

---

## Phase 1: Plan Review

1. **Extract ordered steps** from:
   - `.prove/TASK_PLAN.md` > "Implementation Steps" section, OR
   - `.prove/plans/plan_X/05_implementation_plan.md`
2. **Resolve dependencies** — topological sort if needed
3. **Map validation criteria** per step from `06_test_strategy.md` and step-level verification items
4. **Log the execution plan** to run-log.md

---

## Phase 2: Execution Loop

### Simple Mode (<=3 steps)

For each step N:

1. Update run-log: mark step `in_progress`
2. Output: `"[Step N/<total>] Starting: <description>"`
3. Implement the step directly (no subagent delegation)
4. Run validation gates
5. On pass: commit and continue
6. On fail: one retry, then halt

### Full Mode (4+ steps)

Group steps into waves based on dependencies (independent steps = same wave).

For each wave:

#### 2a. Launch Worktree Agents (parallel within wave)

For each task in the wave, generate a prompt and launch:

```bash
# Generate the task prompt
PROMPT=$(bash scripts/generate-task-prompt.sh \
  <task-plan-path> <task-id> <prd-path> <project-root>)
```

Then launch with the Agent tool:
```
Agent(
  subagent_type: "general-purpose",
  isolation: "worktree",
  run_in_background: true,
  prompt: $PROMPT
)
```

- Launch ALL tasks in a wave as parallel Agent calls in a single message.
- Update progress for each task start:
  ```bash
  bash scripts/update-progress.sh <progress-path> task-start <task-id>
  ```

#### 2b. Wait for Completion

Wait for all background agents in the wave to complete. Update progress as each finishes:
```bash
bash scripts/update-progress.sh <progress-path> task-complete <task-id>
```

#### 2c. Mandatory Architect Review (per task)

**CRITICAL: No task may be merged without passing review. Zero exceptions.**

For each completed worktree agent, run the review-fix loop:

```
REVIEW LOOP (max 3 iterations per task):

1. Generate review prompt:
   REVIEW_PROMPT=$(bash scripts/generate-review-prompt.sh \
     <worktree-path> <task-id> <task-plan-path> <prd-path> <base-branch>)

2. Launch principal-architect review:
   Agent(
     subagent_type: "principal-architect",
     prompt: $REVIEW_PROMPT
   )

3. Parse the verdict from the review output:
   - If APPROVED -> exit loop, proceed to merge
   - If CHANGES_REQUIRED -> continue to step 4

4. Update progress:
   bash scripts/update-progress.sh <progress-path> task-review <task-id> "CHANGES_REQUIRED"

5. Launch a fix agent in the SAME worktree to address review findings:
   Agent(
     subagent_type: "general-purpose",
     prompt: """
       You are fixing review findings for Task <task-id>.

       ## Review Findings
       <paste the CHANGES_REQUIRED items from the review>

       ## Rules
       - Fix ONLY the items flagged by the reviewer
       - Do not refactor or improve code beyond what was flagged
       - Run tests after fixes
       - Commit with message: "fix(<scope>): address review feedback (round N)"
     """
   )

6. Go to step 1 (re-review)

If 3 iterations pass without APPROVED:
  - Log failure in .prove/PROGRESS.md
  - Ask user: force-approve, fix manually, or abort
```

#### 2d. Sequential Merge-Back

After ALL tasks in the wave are reviewed and approved:

1. For each approved task (in task order):
   ```bash
   git merge <worktree-branch> --no-ff -m "merge: task <id> - <name>"
   ```
   Update progress:
   ```bash
   bash scripts/update-progress.sh <progress-path> merge <task-id> "clean"
   ```

2. If merge conflict:
   - Log: `update-progress.sh <path> merge <task-id> "conflict"`
   - Attempt auto-resolution for trivial conflicts
   - For non-trivial: ask user

3. Run the full test suite after merging the wave

#### 2e. Advance to Next Wave

Repeat 2a-2d for each subsequent wave.

### Validation Gate (both modes)

Validators loaded per `references/validation-config.md` — from `.prove.json` if present, otherwise auto-detected.

Run ALL applicable validators in phase order (build → lint → test → custom → llm):

1. **Build/Parse check** — does the project still compile?
2. **Lint check** — no new warnings/errors introduced?
3. **Test suite** — do ALL existing + new tests pass?
4. **Custom checks** — any user-defined validators
5. **LLM checks** — prompt-based validation using the `validation-agent` (haiku model)
6. **Step verification** — are expected files created/modified?

#### LLM Validator Execution

For each prompt validator configured in `.prove.json`:

1. Read the prompt file specified in the validator's `prompt` field
2. Generate the diff for the current step: `git diff HEAD~1`
3. Launch the `validation-agent` (haiku model, read-only tools):
   ```
   Agent(
     subagent_type: "validation-agent",
     model: "haiku",
     prompt: """
       ## Validation Prompt
       {contents of the prompt markdown file}

       ## Changes to Validate
       ```diff
       {git diff output}
       ```

       ## Instructions
       Evaluate the changes against the validation prompt criteria.
       Return your verdict in the required format (PASS/FAIL with findings).
     """
   )
   ```
4. Parse the verdict from the agent output
5. PASS: log result and continue
6. FAIL: same retry cycle as command validators (one auto-fix, then halt)

LLM validators follow the same output format logged to the run-log:

```markdown
### <Validator Name>
**Status**: PASS | FAIL
**Duration**: Xs
**Output** (on failure):
```
(findings from the validation-agent)
```
```

Record all results (pass/fail + output) in run-log.

**ALL pass:** Proceed to git snapshot.

**ANY fail:**
1. Log failure details in run-log
2. Attempt ONE auto-fix cycle:
   - Send failure output with instruction: "Fix this validation failure. Error: <output>"
   - Re-run ALL validators
3. If STILL failing:
   - Commit WIP: `git commit -m "orchestrator: [WIP] step N - <desc> (validation failed)"`
   - Update run-log with blocker details and full error output
   - **HALT** — stop execution, proceed to Phase 3
   - Do NOT continue to the next step

### Git Snapshot (both modes)

```bash
# Stage specific files from the step (prefer specific over -A)
git add <files modified in this step>
git commit -m "$(cat <<'EOF'
orchestrator: step N - <step description>

Part of: <task name>
Validated: <comma-separated list of checks passed>

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

Record commit SHA in run-log.

---

## Phase 3: Completion

Generate `.prove/reports/<task-slug>/report.md`:

```markdown
# Orchestrator Report: <Task Name>

**Branch**: orchestrator/<task-slug>
**Mode**: Simple | Full
**Status**: Completed | Halted at Step N
**Started**: <timestamp>
**Finished**: <timestamp>
**Total Commits**: N

## Summary
<What was accomplished, what remains>

## Steps
| # | Step | Status | Commit |
|---|------|--------|--------|
| 1 | <desc> | done | <sha-short> |
| 2 | <desc> | done | <sha-short> |
| 3 | <desc> | HALTED | <sha-short> [WIP] |

## Validation Summary
- Build: PASS/FAIL
- Tests: X passed, Y failed, Z skipped
- Lint: PASS/FAIL

## Files Changed
<output of: git diff --stat main...HEAD>

## How to Review
```bash
# View all changes
git diff main...orchestrator/<task-slug>

# View step-by-step
git log --oneline main..orchestrator/<task-slug>
git show <commit-sha>  # inspect individual step
```

## Rollback Options
```bash
# Undo everything
git checkout main
git branch -D orchestrator/<task-slug>

# Revert a specific step
git revert <commit-sha>

# Rollback to a specific step
git reset --hard <commit-sha>
```

## Merge When Satisfied
```bash
git checkout main
git merge --no-ff orchestrator/<task-slug>
```
```

Present to the user:
- Completion status (all done vs halted at step N)
- Report file location
- Key review command
- Next action recommendation (review, fix blocker, or merge)

---

## Full Mode: Progress Tracking

Maintain a live `.prove/PROGRESS.md` using `scripts/update-progress.sh`:

```markdown
# Progress: <Feature Name>

**Started**: <YYYY-MM-DD HH:MM>
**Status**: In Progress | Completed | Failed | Paused
**Branch**: orchestrator/<feature-slug>

## Overview
| Wave | Tasks | Completed | Reviewed | Status |
|------|-------|-----------|----------|--------|
| 1    | 3     | 3         | 3        | Merged |
| 2    | 1     | 0         | 0        | Pending |

## Task Status

### Wave 1
- [x] Task 1.1: <name> -- APPROVED after 1 review(s) (14:32)
- [x] Task 1.2: <name> -- APPROVED after 2 review(s) (14:45)
- [x] Task 1.3: <name> -- APPROVED after 1 review(s) (14:38)

### Wave 2
- [ ] Task 2.1: <name> -- Pending

## Review Log
- 14:30 Task 1.1: APPROVED
- 14:35 Task 1.2: CHANGES_REQUIRED -- fixing...
- 14:38 Task 1.3: APPROVED
- 14:45 Task 1.2: APPROVED (round 2)

## Merge Log
- 14:46 Merged task 1.1 (clean)
- 14:46 Merged task 1.2 (clean)
- 14:47 Merged task 1.3 (clean)

## Issues
- <timestamp>: <description>

## Test Results
- Wave 1 post-merge: PASS (12 tests)
- Final: <pending>
```

Update after: task start, task complete, review verdict, review pass, merge, wave complete, issues, final tests.

---

## Full Mode: Requirements Gathering (PRD)

When triggered with "full auto" and no existing plan, run requirements gathering first:

1. **Read project context** — Scan `CLAUDE.md`, `README.md`, `docs/`, recent git history.
2. **Launch a requirements-gathering subagent** that interviews the user to clarify:
   - What the feature does (user stories, acceptance criteria)
   - What it does NOT do (explicit non-goals)
   - Technical constraints
   - How to verify it works
3. **Write the PRD** using the template in `references/prd-template.md`
4. **User approval gate** — Wait for explicit PRD approval before planning
5. **Generate `.prove/TASK_PLAN.md`** with wave-based task graph
6. **User approval gate** — Wait for explicit plan approval before executing

---

## Error Handling

| Scenario | Action |
|----------|--------|
| No .prove/TASK_PLAN.md or .prove/plans/ | Stop. Suggest `/plan-task` |
| Branch already exists | Ask: resume or fresh start |
| Build fails after step | One retry, then halt with report |
| Tests fail after step | One retry, then halt with report |
| Subagent produces no changes | Log warning, skip commit, continue |
| Git conflict | Halt immediately, report to user |
| Unclear step requirements | Halt, ask user for clarification |
| Review deadlock (3 fails) | Ask user: force-approve, fix manually, or abort |

## Rules

- **Never force-push** or rewrite history on the orchestrator branch
- **Never skip validation** — every step must pass gates before proceeding
- **Halt on ambiguity** — if requirements are unclear, stop and ask
- **Preserve main** — all work on the feature branch only
- **One retry max** — no infinite fix loops
- **Log everything** — run-log is the audit trail
- **Specific file staging** — prefer `git add <files>` over `git add -A`

## Conventions

### Branch Naming
- Simple mode: `orchestrator/<task-slug>`
- Full mode: `orchestrator/<feature-slug>`
- Worktree branches: managed by `isolation: "worktree"`

### Slug Generation
Kebab-case, max 40 chars: "Add user authentication" -> `add-user-authentication`

## Scripts

Helper scripts live in `scripts/`:

| Script | Purpose |
|--------|---------|
| `generate-task-prompt.sh` | Generates a focused, self-contained prompt for worktree implementation agents |
| `generate-review-prompt.sh` | Generates a structured review prompt for the principal-architect agent |
| `update-progress.sh` | Updates .prove/PROGRESS.md with task/wave status changes |

## References

| File | Purpose |
|------|---------|
| `references/prd-template.md` | PRD template for full-auto requirements gathering |
| `references/handoff-protocol.md` | Protocol for handing off between orchestrator phases |
| `references/reporter-protocol.md` | Protocol for generating reports |
| `references/validation-config.md` (top-level) | Canonical validation spec — schema, auto-detection, execution order |

## Committing

All commits created during orchestrated execution MUST follow the `commit` skill conventions:

1. Read `MANIFEST` from the project root to derive valid scopes
2. Use conventional commit format: `<type>(<scope>): <description>`
3. If the target project has its own MANIFEST, use its scopes for implementation commits
4. If not, derive scope from the area of the codebase being changed

The orchestrator creates commits after each successful step. Each commit must be atomic and scoped — never bundle multiple steps into one commit.
