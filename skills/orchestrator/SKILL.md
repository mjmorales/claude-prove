---
name: orchestrator
description: >
  Autonomous task orchestrator that auto-scales between simple mode (<=3 steps,
  sequential, no worktrees) and full mode (4+ steps, parallel worktrees with
  mandatory principal-architect review). Each run operates in its own git worktree
  with namespaced state (.prove/runs/<slug>/), enabling concurrent runs that
  consolidate at merge time. Creates feature branches, runs validation gates,
  commits after each step, and supports rollback via git. Use when a
  .prove/runs/<slug>/TASK_PLAN.md or .prove/plans/ directory exists and the user
  wants hands-off execution. Triggers on "orchestrate", "autopilot", "full auto",
  "run autonomously", "implement without me", "hands-off mode".
---

# Orchestrator Skill

**Simple mode** (<=3 steps): sequential, no worktrees, lightweight reporting.
**Full mode** (4+ steps): parallel worktrees, architect review, full progress tracking.

Requires `.prove/runs/<slug>/TASK_PLAN.md` or `.prove/plans/plan_X/`. If neither exists, suggest `/plan-task`.

---

## Phase 0: Initialization

All `.prove/...` paths are rooted at the **main worktree** (`$MAIN_ROOT`), not the orchestrator worktree. Scripts resolve this via `git worktree list`.

1. **Derive slug** from user input (kebab-case, max 40 chars). The slug determines the run directory path -- do not derive from parsing the plan.

2. **Create run directory**: `mkdir -p .prove/runs/<slug>/reports/`

3. **Validate inputs** -- read `.prove/runs/<slug>/TASK_PLAN.md` or `.prove/plans/plan_X/` to extract task name and ordered steps.

4. **Auto-scale** -- <=3 steps: simple mode. 4+ steps: full mode. Log the decision.

5. **Create feature branch + worktree**
   - Existing branch: AskUserQuestion header "Branch", options: "Resume" / "Start Fresh"
   - New branch:
     ```bash
     git worktree add .claude/worktrees/orchestrator-<slug> -b orchestrator/<slug>
     ```
   - All work happens in this worktree. Main worktree stays on its current branch.

6. **Create run log** at `.prove/runs/<slug>/reports/run-log.md`:
   ```markdown
   # Orchestrator Run Log: <Task Name>
   **Branch**: orchestrator/<slug>
   **Worktree**: .claude/worktrees/orchestrator-<slug>
   **Mode**: Simple | Full
   **Started**: <ISO timestamp>
   **Status**: In Progress
   **Validators**: <from .claude/.prove.json or auto-detected>
   **Steps**: <total count>

   ## Step Log
   | # | Step | Status | Commit | Notes |
   |---|------|--------|--------|-------|
   ```

7. **Load validators** from `.claude/.prove.json` or auto-detect per `references/validation-config.md`.

8. **Load reporters** from `.claude/.prove.json` `reporters` array. Log to run-log: `Reporters: <names>` or `Reporters: none`.

Reporter dispatch is automatic via Claude Code hooks -- the orchestrator never invokes reporters manually. See `references/reporter-protocol.md`.

---

## Phase 1: Plan Review

1. Extract ordered steps from `.prove/runs/<slug>/TASK_PLAN.md` > "Implementation Steps" or `.prove/plans/plan_X/05_implementation_plan.md`
2. Resolve dependencies (topological sort if needed)
3. Map validation criteria per step from `06_test_strategy.md` and step-level verification items
4. Log execution plan to run-log

---

## Phase 2: Execution Loop

### Simple Mode (<=3 steps)

For each step N:

1. Update run-log: `in_progress`
2. Output: `"[Step N/<total>] Starting: <description>"`
3. Implement directly (no subagent delegation)
4. Run validation gate (see below)
5. Pass: git snapshot and continue
6. Fail: one retry, then halt

### Full Mode (4+ steps)

Group steps into waves by dependency (independent steps = same wave). Max 4 agents per wave -- split larger waves into sub-waves.

For each wave:

#### 2a. Launch Worktree Agents (parallel)

For each task in the wave:

1. Create worktree:
   ```bash
   WT_PATH=$(bash scripts/manage-worktree.sh create <slug> <task-id>)
   ```
2. Generate prompt:
   ```bash
   PROMPT=$(bash scripts/generate-task-prompt.sh \
     .prove/runs/<slug>/TASK_PLAN.md <task-id> .prove/runs/<slug>/PRD.md <project-root> "$WT_PATH")
   ```
3. Launch agent (worktree already exists, no `isolation: "worktree"`):
   ```
   Agent(
     subagent_type: "general-purpose",
     run_in_background: true,
     prompt: $PROMPT
   )
   ```

Create ALL worktrees first, then launch ALL agents as parallel calls in a single message.

Update progress per task:
```bash
bash scripts/update-progress.sh .prove/runs/<slug>/PROGRESS.md task-start <task-id>
```

#### 2b. Wait for Completion

Wait for all wave agents. Update progress as each finishes:
```bash
bash scripts/update-progress.sh .prove/runs/<slug>/PROGRESS.md task-complete <task-id>
```

#### 2c. Validation Gate (per task)

Run before architect review. Implementation agents already run command validators during work, but the orchestrator re-verifies them as a gate. LLM validators run here only -- implementation agents cannot launch `validation-agent` subagents.

For each completed task:
1. `cd` into the task worktree
2. Run all validators per the Validation Gate section below
3. All pass: proceed to 2d. Any fail: retry/halt protocol.
4. Update progress:
   ```bash
   bash scripts/update-progress.sh .prove/runs/<slug>/PROGRESS.md task-validated <task-id>
   ```

#### 2d. Architect Review (per task)

Every task requires principal-architect approval before merge.

```
REVIEW LOOP (max 3 iterations per task):

1. Generate review prompt:
   WT_PATH=$(bash scripts/manage-worktree.sh path <slug> <task-id>)
   REVIEW_PROMPT=$(bash scripts/generate-review-prompt.sh \
     "$WT_PATH" <task-id> .prove/runs/<slug>/TASK_PLAN.md .prove/runs/<slug>/PRD.md <base-branch>)

2. Launch review:
   Agent(subagent_type: "principal-architect", prompt: $REVIEW_PROMPT)

3. Parse verdict:
   - APPROVED: exit loop, proceed to merge
   - CHANGES_REQUIRED: continue to step 4

4. Update progress:
   bash scripts/update-progress.sh .prove/runs/<slug>/PROGRESS.md task-review <task-id> "CHANGES_REQUIRED"

5. Launch fix agent in the SAME worktree:
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

If 3 iterations without APPROVED:
  - Log failure in PROGRESS.md
  - AskUserQuestion header "Resolution", options: "Force Approve" / "Fix Manually" / "Abort"
```

#### 2e. Sequential Merge-Back

After all wave tasks are approved:

1. Merge each task (in order) into the orchestrator worktree:
   ```bash
   cd .claude/worktrees/orchestrator-<slug>
   BRANCH=$(bash scripts/manage-worktree.sh branch <slug> <task-id>)
   git merge "$BRANCH" --no-ff -m "merge: task <id> - <name>"
   ```
   ```bash
   bash scripts/update-progress.sh .prove/runs/<slug>/PROGRESS.md merge <task-id> "clean"
   ```

2. Clean up task worktree + branch:
   ```bash
   bash scripts/manage-worktree.sh remove <slug> <task-id>
   ```

3. Merge conflict: log with `merge <task-id> "conflict"`, attempt auto-resolution for trivial conflicts, ask user for non-trivial.

4. Run full test suite after merging the wave.

#### 2f. Advance to Next Wave

Repeat 2a-2e for each subsequent wave.

### Validation Gate (both modes)

Run all validators in phase order: build -> lint -> test -> custom -> llm, then verify expected files exist.

Validators loaded per `references/validation-config.md` (`.claude/.prove.json` or auto-detected).

#### LLM Validator Execution

For each prompt validator in `.claude/.prove.json`:

1. Read the prompt file from the validator's `prompt` field
2. Generate diff: `git diff HEAD~1` (simple) or `git diff <base-branch>...HEAD` (full)
3. Launch validation:
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
4. PASS: log and continue. FAIL: same retry cycle as command validators.

#### Failure Protocol

1. Log failure details in run-log
2. Attempt ONE auto-fix: send failure output, re-run all validators
3. Still failing: commit WIP (`"orchestrator: [WIP] step N - <desc> (validation failed)"`), log blocker details, halt execution, proceed to Phase 3

Record all results in run-log.

### Git Snapshot (both modes)

```bash
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

Generate `.prove/runs/<slug>/reports/report.md`:

```markdown
# Orchestrator Report: <Task Name>

**Branch**: orchestrator/<slug>
**Mode**: Simple | Full
**Status**: Completed | Halted at Step N
**Started**: <timestamp>  **Finished**: <timestamp>
**Total Commits**: N

## Summary
<What was accomplished, what remains>

## Steps
| # | Step | Status | Commit |
|---|------|--------|--------|
(mark HALTED steps with [WIP])

## Validation Summary
- Build/Tests/Lint: PASS or FAIL (include counts)

## Files Changed
<output of: git diff --stat main...HEAD>

## How to Review
- `/prove:review` or `git diff main...orchestrator/<slug>`
- `git log --oneline main..orchestrator/<slug>` -- step-by-step
- `git show <commit-sha>` -- inspect individual step

## Rollback
- Undo all: `git checkout main && git branch -D orchestrator/<slug>`
- Revert one step: `git revert <commit-sha>`
- Reset to step: `git reset --hard <commit-sha>`

## Merge
git checkout main && git merge --no-ff orchestrator/<slug>
```

Present: status, report location, next action (review / fix blocker / merge).

---

## Phase 4: Merge & Cleanup

Runs after user review and approval. Skip if execution halted.

### 4.1 Merge Gate

AskUserQuestion header "Merge & Cleanup", options:
- "Merge & Clean" -- merge, archive, delete branch
- "Merge Only" -- merge, keep artifacts
- "Skip" -- manual merge (remind to run `/task-cleanup`)

### 4.2 Merge to Main

```bash
git merge --no-ff orchestrator/<slug> -m "merge: <task-name>"
```

If another run merged first, pull/merge main first. On conflict: halt and inform user, do not force-merge.

### 4.3 Cleanup (if "Merge & Clean")

```bash
PROJECT_ROOT="." bash scripts/cleanup.sh --auto <slug>
```

Archives to `.prove/archive/<date>_<slug>/`, removes run directory, worktree, and branch. Generates `SUMMARY.md` in archive.

### 4.4 Confirm

Present: merge SHA, archived location, skipped items. If "Skip": remind to run `/task-cleanup <slug>`.

---

## Full Mode: Progress Tracking

Maintain `.prove/runs/<slug>/PROGRESS.md` via `scripts/update-progress.sh`.

Sections: Header (name, status, branch), Overview table (wave/tasks/completed/reviewed), Task Status (per-wave checklist), Review Log, Merge Log, Issues, Test Results.

Update on: task start, task complete, review verdict, merge, wave complete, issue, final tests.

---

## Full Mode: Requirements Gathering (PRD)

When triggered with "full auto" and no existing plan:

1. Derive slug, create run directory
2. Read project context (`CLAUDE.md`, `README.md`, `docs/`, recent git history)
3. Launch requirements-gathering subagent (user stories, acceptance criteria, non-goals, constraints, verification)
4. Write PRD to `.prove/runs/<slug>/PRD.md` using `references/prd-template.md`
5. AskUserQuestion header "PRD": "Approve" / "Request Changes"
6. Generate `.prove/runs/<slug>/TASK_PLAN.md` with wave-based task graph

   Task headers use `### Task {wave}.{seq}: {name}` format (e.g., `### Task 1.1: Setup config`). Wave = parallel batch, seq = order within wave. The scripts `generate-task-prompt.sh` and `generate-review-prompt.sh` parse these with awk -- any other format causes silent extraction failure.

7. AskUserQuestion header "Plan": "Approve" / "Request Changes"

All artifacts in the run directory. Concurrent runs stay isolated.

---

## Error Handling

| Scenario | Action |
|----------|--------|
| No plan found | Stop, suggest `/plan-task` |
| Branch exists | AskUserQuestion: Resume / Start Fresh |
| Build/test fails | One retry, then halt with report |
| Subagent produces no changes | Log warning, skip commit, continue |
| Git conflict | Halt, report to user |
| Unclear requirements | Halt, ask user |
| Review deadlock (3 rounds) | AskUserQuestion: Force Approve / Fix Manually / Abort |

## Rules

- Do not force-push or rewrite history on the orchestrator branch
- Every step passes validation before proceeding
- All work on the feature branch -- main stays clean
- Run-log is the audit trail -- log everything
- Prefer `git add <files>` over `git add -A`

## Conventions

**Branches**: `orchestrator/<slug>` (worktree: `.claude/worktrees/orchestrator-<slug>`), sub-tasks: `task/<slug>/<task-id>` (worktree: `.claude/worktrees/<slug>-task-<task-id>`). Managed by `scripts/manage-worktree.sh`.

**Run directory**:
```
.prove/runs/<slug>/
├── TASK_PLAN.md         # Implementation plan
├── PRD.md               # Product requirements (if full-auto)
├── PROGRESS.md          # Live progress (full mode)
├── dispatch-state.json  # Reporter dedup state
└── reports/
    ├── run-log.md       # Audit trail
    └── report.md        # Final report
```

## Scripts

| Script | Purpose |
|--------|---------|
| `generate-task-prompt.sh` | Prompt for worktree implementation agents |
| `generate-review-prompt.sh` | Review prompt for principal-architect |
| `update-progress.sh` | Updates PROGRESS.md with task/wave status |
| `cleanup.sh` | Archives and removes run artifacts |

## References

| File | Purpose |
|------|---------|
| `references/prd-template.md` | PRD template |
| `references/handoff-protocol.md` | Phase handoff protocol |
| `references/reporter-protocol.md` | Reporter dispatch protocol |
| `references/validation-config.md` | Validation spec (schema, auto-detection, execution order) |
| `references/interaction-patterns.md` | AskUserQuestion usage |

## Committing

Follow `commit` skill conventions: `scopes` from `.claude/.prove.json` (fall back to directory-based), `<type>(<scope>): <description>` format. One atomic commit per step.
