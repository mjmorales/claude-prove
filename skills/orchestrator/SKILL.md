---
name: orchestrator
description: >
  Autonomous task orchestrator that auto-scales between simple mode (<=3 steps,
  sequential, no worktrees) and full mode (4+ steps, parallel worktrees with
  mandatory principal-architect review). Each orchestrator run operates in its own
  git worktree with namespaced state (.prove/runs/<slug>/), enabling multiple
  concurrent orchestrator runs that consolidate at merge time. Creates feature
  branches, runs validation gates (build, test, lint), commits after each successful
  step, generates progress reports, and supports rollback via git. Use when a
  .prove/runs/<slug>/TASK_PLAN.md or .prove/plans/ directory exists and the user
  wants hands-off execution. Triggers on "orchestrate", "autopilot", "full auto", "run autonomously",
  "implement without me", "hands-off mode".
---

# Orchestrator Skill

Auto-scales between:
- **Simple mode** (<=3 steps): Sequential execution, no worktrees, lightweight reporting
- **Full mode** (4+ steps): Parallel worktrees, mandatory architect review, full progress tracking

## Prerequisites

Requires one of:
- `.prove/runs/<slug>/TASK_PLAN.md` — implementation steps (from full-auto or task-planner)
- `.prove/plans/plan_X/` — planning docs (from `/plan-step`)

If neither exists, suggest `/plan-task`.

---

## Phase 0: Initialization

> **Path convention**: All `.prove/...` paths are rooted at the **main worktree** (`$MAIN_ROOT`), not the orchestrator worktree. Scripts resolve this via `git worktree list`.

1. **Derive slug** — Slugify from user input (lowercase, hyphens, no special chars, max 40 chars). The slug determines where to find/create the run directory — do not derive it from parsing the plan.

2. **Initialize run directory** (namespaced per slug — supports concurrent runs)
   ```bash
   mkdir -p .prove/runs/<slug>/reports/
   ```

3. **Validate inputs** — look for `.prove/runs/<slug>/TASK_PLAN.md` or `.prove/plans/plan_X/` directories.
   - Read all available planning documents to understand full scope
   - Extract task name and ordered implementation steps

4. **Auto-scale decision**
   - Count implementation steps
   - **<=3 steps**: Simple mode (sequential, no worktrees)
   - **4+ steps**: Full mode (parallel worktrees + architect review)
   - Log which mode was selected

5. **Create feature branch in a worktree**
   - If branch already exists, use AskUserQuestion with header "Branch" and options: "Resume" (continue from last commit) / "Start Fresh" (delete and recreate)
   - Create the branch and worktree:
     ```bash
     git worktree add .claude/worktrees/orchestrator-<slug> -b orchestrator/<slug>
     ```
   - All subsequent work happens inside this worktree. Main worktree stays on its current branch.

6. **Create run log**
   Create `.prove/runs/<slug>/reports/run-log.md`:
   ```markdown
   # Orchestrator Run Log: <Task Name>
   **Branch**: orchestrator/<slug>
   **Worktree**: .claude/worktrees/orchestrator-<slug>
   **Mode**: Simple | Full
   **Started**: <ISO timestamp>
   **Status**: In Progress
   **Validators**: <loaded from .prove.json or auto-detected>
   **Steps**: <total count>

   ## Step Log
   | # | Step | Status | Commit | Notes |
   |---|------|--------|--------|-------|
   ```

7. **Load validators** from `.prove.json` or auto-detect per `references/validation-config.md`

8. **Load reporters** from `.prove.json`
   - Read the `reporters` array (may be empty or absent)
   - Log loaded reporters to run-log: `Reporters: <name1>, <name2>` (or `Reporters: none`)

---

## Reporter Dispatch (Automatic via Hooks)

Reporter dispatch is handled by Claude Code hooks — the orchestrator never invokes reporters manually. Hooks in `.claude/settings.json`:
- **PostToolUse(Bash)** — dispatches `step-complete`, `step-halted`, `wave-complete` on git commits/merges
- **SubagentStop(principal-architect|validation-agent)** — dispatches `review-approved`, `review-rejected`, `validation-pass`, `validation-fail`
- **Stop** — dispatches `execution-complete` when session ends with an active run

Deduplication via `.prove/runs/<slug>/dispatch-state.json`. Details: `references/reporter-protocol.md`.

---

## Phase 1: Plan Review

1. **Extract ordered steps** from (paths relative to run directory):
   - `.prove/runs/<slug>/TASK_PLAN.md` > "Implementation Steps" section, OR
   - `.prove/plans/plan_X/05_implementation_plan.md`
2. **Resolve dependencies** — topological sort if needed
3. **Map validation criteria** per step from `06_test_strategy.md` and step-level verification items
4. **Log the execution plan** to `.prove/runs/<slug>/reports/run-log.md`

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

**Max concurrency: 4 agents per wave.** If a wave has more than 4 independent tasks, split it into sub-waves of at most 4. This prevents CPU/memory exhaustion from too many parallel worktrees.

For each wave:

#### 2a. Launch Worktree Agents (parallel within wave)

For each task in the wave:

1. Create a namespaced worktree for the task:
   ```bash
   WT_PATH=$(bash scripts/manage-worktree.sh create <slug> <task-id>)
   ```

2. Generate the task prompt (use run-local copies):
   ```bash
   PROMPT=$(bash scripts/generate-task-prompt.sh \
     .prove/runs/<slug>/TASK_PLAN.md <task-id> .prove/runs/<slug>/PRD.md <project-root> "$WT_PATH")
   ```

3. Launch the agent **without** `isolation: "worktree"` — the worktree already exists:
   ```
   Agent(
     subagent_type: "general-purpose",
     run_in_background: true,
     prompt: $PROMPT
   )
   ```

- Create ALL worktrees first, then launch ALL agents as parallel Agent calls in a single message.
- Update progress for each task start:
  ```bash
  bash scripts/update-progress.sh .prove/runs/<slug>/PROGRESS.md task-start <task-id>
  ```

#### 2b. Wait for Completion

Wait for all background agents in the wave to complete. Update progress as each finishes:
```bash
bash scripts/update-progress.sh .prove/runs/<slug>/PROGRESS.md task-complete <task-id>
```

#### 2c. Mandatory Architect Review (per task)

**CRITICAL: No task may be merged without passing review. Zero exceptions.**

For each completed worktree agent, run the review-fix loop:

```
REVIEW LOOP (max 3 iterations per task):

1. Generate review prompt:
   WT_PATH=$(bash scripts/manage-worktree.sh path <slug> <task-id>)
   REVIEW_PROMPT=$(bash scripts/generate-review-prompt.sh \
     "$WT_PATH" <task-id> .prove/runs/<slug>/TASK_PLAN.md .prove/runs/<slug>/PRD.md <base-branch>)

2. Launch principal-architect review:
   Agent(
     subagent_type: "principal-architect",
     prompt: $REVIEW_PROMPT
   )

3. Parse the verdict from the review output:
   - If APPROVED:
     - Exit loop, proceed to merge
   - If CHANGES_REQUIRED:
     - Continue to step 4

4. Update progress:
   bash scripts/update-progress.sh .prove/runs/<slug>/PROGRESS.md task-review <task-id> "CHANGES_REQUIRED"

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
  - Log failure in .prove/runs/<slug>/PROGRESS.md
  - Use AskUserQuestion with header "Resolution" and options: "Force Approve" (merge as-is) / "Fix Manually" (I'll address the findings) / "Abort" (stop the run)
```

#### 2d. Sequential Merge-Back

After ALL tasks in the wave are reviewed and approved:

1. For each approved task (in task order), merge into the orchestrator worktree:
   ```bash
   cd .claude/worktrees/orchestrator-<slug>
   BRANCH=$(bash scripts/manage-worktree.sh branch <slug> <task-id>)
   git merge "$BRANCH" --no-ff -m "merge: task <id> - <name>"
   ```
   Update progress:
   ```bash
   bash scripts/update-progress.sh .prove/runs/<slug>/PROGRESS.md merge <task-id> "clean"
   ```

2. After merging, clean up the task worktree and its branch:
   ```bash
   bash scripts/manage-worktree.sh remove <slug> <task-id>
   ```

3. If merge conflict:
   - Log: `update-progress.sh .prove/runs/<slug>/PROGRESS.md merge <task-id> "conflict"`
   - Attempt auto-resolution for trivial conflicts
   - For non-trivial: ask user

4. Run the full test suite after merging the wave

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

Generate `.prove/runs/<slug>/reports/report.md` with these sections:

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
(one row per step — mark HALTED steps with [WIP])

## Validation Summary
- Build/Tests/Lint: PASS or FAIL (include counts for tests)

## Files Changed
<output of: git diff --stat main...HEAD>

## How to Review
Run `/prove:review` to generate an ACB, or use git commands:
- `git diff main...orchestrator/<slug>` — all changes
- `git log --oneline main..orchestrator/<slug>` — step-by-step
- `git show <commit-sha>` — inspect individual step

## Rollback Options
- Undo all: `git checkout main && git branch -D orchestrator/<slug>`
- Revert one step: `git revert <commit-sha>`
- Reset to step: `git reset --hard <commit-sha>`

## Merge When Satisfied
git checkout main && git merge --no-ff orchestrator/<slug>
```

Present to user: completion status, report location, next action (review / fix blocker / merge).

---

## Phase 4: Merge & Cleanup

**This phase runs after the user has reviewed and approved the changes.** It is triggered when:
- All steps completed successfully (status: Completed)
- The user confirms they want to merge

If execution halted, skip this phase — the user needs to fix blockers first.

### Step 1: Merge Gate

Use `AskUserQuestion` with:
- Header: "Merge & Cleanup"
- Options:
  - "Merge & Clean" (merge to main, archive artifacts, delete branch)
  - "Merge Only" (merge to main, keep artifacts for reference)
  - "Skip" (I'll handle merge manually — remind me to run `/task-cleanup` later)

### Step 2: Merge to Main

If the user chose "Merge & Clean" or "Merge Only":

```bash
# Merge from the main worktree (not from inside the orchestrator worktree)
git merge --no-ff orchestrator/<slug> -m "merge: <task-name>"
```

If another orchestrator merged to main first, you may need to pull/merge main first.
Standard git conflict resolution applies — this is the consolidation point for concurrent runs.

If merge conflicts occur, halt and inform the user. Do NOT force-merge.

### Step 3: Cleanup (if "Merge & Clean")

Run cleanup automatically — no confirmation needed since the user already approved:

```bash
PROJECT_ROOT="." bash scripts/cleanup.sh --auto <slug>
```

This will:
1. Archive key documents to `.prove/archive/<date>_<slug>/`
2. Remove `.prove/runs/<slug>/` (reports, progress, plan copies)
3. Remove the orchestrator worktree: `git worktree remove .claude/worktrees/orchestrator-<slug> --force`
4. Delete the merged `orchestrator/<slug>` branch

Generate a `SUMMARY.md` in the archive directory (same as cleanup skill Phase 3).

### Step 4: Confirm

Present to the user:
- Merge status (commit SHA on main)
- What was archived and where
- Any skipped items (unmerged branches, missing files)
- Reminder: archived docs available at `.prove/archive/<date>_<slug>/`

If the user chose "Skip", remind them:
> Run `/task-cleanup <slug>` after you merge to clean up artifacts.

---

## Full Mode: Progress Tracking

Maintain a live `.prove/runs/<slug>/PROGRESS.md` using `scripts/update-progress.sh`.

Sections (script manages content — orchestrator triggers updates):
- **Header**: Feature name, status (In Progress | Completed | Failed | Paused), branch
- **Overview table**: Wave / Tasks / Completed / Reviewed / Status
- **Task Status**: Per-wave checklist — `- [x] Task 1.1: <name> -- APPROVED after N review(s) (HH:MM)`
- **Review Log**: Chronological review verdicts
- **Merge Log**: Chronological merge results (clean/conflict)
- **Issues**: Timestamped problems
- **Test Results**: Per-wave and final test outcomes

Update triggers: task start, task complete, review verdict, merge, wave complete, issue, final tests.

---

## Full Mode: Requirements Gathering (PRD)

When triggered with "full auto" and no existing plan, run requirements gathering first:

1. **Derive slug and create run directory**: `mkdir -p .prove/runs/<slug>/reports/`
2. **Read project context** — `CLAUDE.md`, `README.md`, `docs/`, recent git history
3. **Launch requirements-gathering subagent** — interview user for: user stories, acceptance criteria, non-goals, technical constraints, verification approach
4. **Write PRD** to `.prove/runs/<slug>/PRD.md` using `references/prd-template.md`
5. **User approval gate** — AskUserQuestion header "PRD", options: "Approve" / "Request Changes"
6. **Generate `.prove/runs/<slug>/TASK_PLAN.md`** with wave-based task graph.
   **CRITICAL FORMAT**: Tasks MUST use `### Task {wave}.{seq}: {name}` headers (e.g., `### Task 1.1: Setup config`, `### Task 2.1: Integration`). Wave number = parallel batch; seq = order within wave. Scripts `generate-task-prompt.sh` and `generate-review-prompt.sh` parse these headers with awk — any other format (e.g., `### Step N:`) causes silent extraction failure.
7. **User approval gate** — AskUserQuestion header "Plan", options: "Approve" / "Request Changes"

All artifacts go in the run directory — no global `.prove/` singletons. Concurrent runs stay isolated.

---

## Error Handling

| Scenario | Action |
|----------|--------|
| No `.prove/runs/<slug>/TASK_PLAN.md` and no `.prove/plans/` | Stop. Suggest `/plan-task` |
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
- **Preserve main** — all work on the feature branch only
- **Log everything** — run-log is the audit trail
- **Specific file staging** — prefer `git add <files>` over `git add -A`

## Conventions

### Branch Naming
- Orchestrator branch: `orchestrator/<slug>` (lives in its own worktree at `.claude/worktrees/orchestrator-<slug>`)
- Sub-task branches: `task/<slug>/<task-id>` (worktree at `.claude/worktrees/<slug>-task-<task-id>`)
- Managed by `scripts/manage-worktree.sh` — deterministic naming prevents collisions between concurrent runs

### Slug Generation
Kebab-case, max 40 chars: "Add user authentication" -> `add-user-authentication`

### Run Directory Layout
```
.prove/runs/<slug>/
├── TASK_PLAN.md         # Implementation plan
├── PRD.md               # Product requirements (if full-auto)
├── PROGRESS.md          # Live progress tracking (full mode)
├── dispatch-state.json  # Reporter deduplication state
└── reports/
    ├── run-log.md       # Audit trail
    └── report.md        # Final report
```

## Scripts

Helper scripts live in `scripts/`:

| Script | Purpose |
|--------|---------|
| `generate-task-prompt.sh` | Generates a focused, self-contained prompt for worktree implementation agents |
| `generate-review-prompt.sh` | Generates a structured review prompt for the principal-architect agent |
| `update-progress.sh` | Updates `.prove/runs/<slug>/PROGRESS.md` with task/wave status changes |
| `cleanup.sh` | Archives and removes `.prove/runs/<slug>/` artifacts (used by Phase 4 and `/task-cleanup`) |

## References

| File | Purpose |
|------|---------|
| `references/prd-template.md` | PRD template for full-auto requirements gathering |
| `references/handoff-protocol.md` | Protocol for handing off between orchestrator phases |
| `references/reporter-protocol.md` | Protocol for generating reports |
| `references/validation-config.md` (top-level) | Canonical validation spec — schema, auto-detection, execution order |
| `references/interaction-patterns.md` | When to use `AskUserQuestion` vs free-form discussion |

## Committing

Follow the `commit` skill conventions: read `scopes` from `.prove.json` (fall back to directory-based), use `<type>(<scope>): <description>` format. Each step gets one atomic commit — never bundle steps.
