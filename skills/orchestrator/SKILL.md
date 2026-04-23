---
name: orchestrator
description: >
  Autonomous task orchestrator that auto-scales between simple mode (<=3 steps,
  sequential, no worktrees) and full mode (4+ steps, parallel worktrees with
  mandatory principal-architect review). Each run stores state as JSON under
  .prove/runs/<branch>/<slug>/ (prd.json, plan.json, state.json, reports/*.json)
  and is mutated only through the run_state CLI. Creates feature branches, runs
  validation gates, commits per step, and supports rollback via git. Use when a
  .prove/runs/<branch>/<slug>/plan.json exists and the user wants hands-off
  execution. Triggers on "orchestrate", "autopilot", "full auto", "run
  autonomously", "implement without me", "hands-off mode".
---

# Orchestrator Skill

**Simple mode** (<=3 steps): sequential, no worktrees, lightweight reporting.
**Full mode** (4+ steps): parallel worktrees, architect review, full tracking.

Requires `.prove/runs/<branch>/<slug>/plan.json`. If missing, suggest `/prove:plan-task` first.

All run artifacts are JSON and live under `.prove/runs/<branch>/<slug>/`:

- `prd.json`, `plan.json` — write-once inputs
- `state.json` — hot path, mutated **only** via `scripts/prove-run ...` (thin wrapper over `prove run-state ...`)
- `reports/<step_id>.json` — write-once per step

Direct edits to `state.json` are blocked by a PreToolUse hook. Render human views JIT (`run_state show`).

---

## Phase 0: Initialization

All `.prove/...` paths resolve from the **main worktree** (`$MAIN_ROOT`), not the orchestrator worktree. Scripts find this via `git worktree list`.

1. **Derive slug + branch namespace** from user input:
   - slug: kebab-case, max 40 chars
   - branch: `feature`, `fix`, `chore` (default `feature`) — matches the task's intent, not the git branch

2. **Verify plan exists**: `.prove/runs/<branch>/<slug>/plan.json`. If missing → stop, suggest `/prove:plan-task`.

3. **Initialize run state** (if not already done):
   ```bash
   scripts/prove-run init \
     --branch <branch> --slug <slug> \
     --plan .prove/runs/<branch>/<slug>/plan.json \
     --prd .prove/runs/<branch>/<slug>/prd.json
   ```
   `init` is the ONLY subcommand that requires explicit `--branch`/`--slug` (no state.json exists yet). After init, the orchestrator worktree's `.prove-wt-slug.txt` carries the slug and every subsequent invocation resolves it automatically.

4. **Auto-scale** — total step count <=3: simple mode; 4+: full mode. Record mode in the plan at creation time; orchestrator does not override.

5. **Create feature branch + worktree**:
   - Existing branch: AskUserQuestion header "Branch" — "Resume" / "Start Fresh"
   - New branch:
     ```bash
     git worktree add .claude/worktrees/orchestrator-<slug> -b orchestrator/<slug>
     printf '%s\n' "<slug>" > .claude/worktrees/orchestrator-<slug>/.prove-wt-slug.txt
     ```

6. **Load validators** from `.claude/.prove.json` or auto-detect per `references/validation-config.md`.

7. **Load reporters** from `.claude/.prove.json` `reporters` array. Reporter dispatch is automatic via Claude Code hooks (see `references/reporter-protocol.md`).

---

## Phase 1: Plan Review

1. Read `plan.json`; walk `tasks[]` in order. Each task carries its own `steps[]`, `deps[]`, `wave`, optional `worktree` block.
2. Resolve dependencies (topological sort if needed — the planner typically emits wave-ready ordering).
3. Map validators per step from `.claude/.prove.json` and any step-level `acceptance_criteria`.
4. Render for the user: `scripts/prove-run show plan`

---

## Phase 2: Execution Loop

Every state mutation uses `scripts/prove-run` — the agent-facing wrapper. Never inline python/jq/sed. Slug is auto-resolved from `.prove-wt-slug.txt`; if missing, `prove-run` hard-errors (exit 2).

### Simple Mode (<=3 steps)

For each step N:

1. Start: `scripts/prove-run step-start <step_id>`
2. Announce: `[Step <id>] Starting: <title>`
3. Implement directly (no subagent delegation)
4. Run validation gate
5. Record validator outcomes:
   ```bash
   scripts/prove-run validator <step_id> build pass
   scripts/prove-run validator <step_id> lint pass
   scripts/prove-run validator <step_id> test pass
   ```
6. Commit (see Git Snapshot). Capture SHA.
7. Complete: `scripts/prove-run step-complete <step_id> --commit <SHA>`
8. Write report: `scripts/prove-run report <step_id> --status completed --commit <SHA>`
9. On validation failure → one retry. Still failing:
   - `scripts/prove-run step-halt <step_id> --reason "<short>"`
   - Commit WIP (`orchestrator: [WIP] ...`)

### Full Mode (4+ steps)

Group steps into waves by dependency. Max 4 agents per wave; split larger waves.

#### 2a. Launch Worktree Agents (parallel)

For each task in the wave:

1. Create worktree (also writes `.prove-wt-slug.txt` with the run slug):
   ```bash
   WT_PATH=$(bash skills/orchestrator/scripts/manage-worktree.sh create <slug> <task-id>)
   ```
2. Generate the agent prompt from JSON:
   ```bash
   RUN_DIR=".prove/runs/<branch>/<slug>"
   PROMPT=$(bun run "$PLUGIN_DIR/packages/cli/bin/run.ts" orchestrator task-prompt \
     --run-dir "$RUN_DIR" --task-id <task-id> --project-root <project-root> --worktree "$WT_PATH")
   ```
3. Launch agent (worktree already exists — do NOT pass `isolation: "worktree"`):
   ```
   Agent(subagent_type: "general-purpose", run_in_background: true, prompt: $PROMPT)
   ```
4. Mark first step started:
   ```bash
   scripts/prove-run step-start <task-id>.<first-step-seq>
   ```

Create ALL worktrees first, then launch ALL agents as parallel calls in a single message.

#### 2b. Wait for Completion

The SubagentStop hook auto-completes the step with the subagent's latest commit SHA (or halts with a diagnostic if no commits landed). You only need to intervene when:

- The hook reports `halted` → inspect `halt_reason`, decide retry or abort
- A per-step report is required (validators summary, notes, artifacts):
  ```bash
  scripts/prove-run report <step_id> --status completed --commit <SHA>
  ```

Sub-agents themselves must NOT call `scripts/prove-run step-complete` — the orchestrator owns step transitions and the hook is the safety net. Their contract is: commit, exit.

#### 2c. Validation Gate (per task)

Before review, re-run validators. Implementation agents run command validators during work; the orchestrator verifies and runs LLM validators (agents cannot spawn `validation-agent`).

For each completed task:

1. `cd` into the task worktree (slug auto-resolves from the worktree marker)
2. Run validators per phase order
3. Record each outcome via `scripts/prove-run validator <step_id> <phase> <status>`
4. All pass: proceed to 2d. Any fail: retry/halt protocol.

#### 2d. Architect Review (per task)

Every task requires principal-architect approval before merge.

```
REVIEW LOOP (max 3 iterations per task):

1. Build review prompt:
   WT_PATH=$(bash skills/orchestrator/scripts/manage-worktree.sh path <slug> <task-id>)
   RUN_DIR=".prove/runs/<branch>/<slug>"
   REVIEW_PROMPT=$(bun run "$PLUGIN_DIR/packages/cli/bin/run.ts" orchestrator review-prompt \
     --worktree "$WT_PATH" --task-id <task-id> --run-dir "$RUN_DIR" --base-branch <base-branch>)

2. Launch review:
   Agent(subagent_type: "principal-architect", prompt: $REVIEW_PROMPT)

3. Parse verdict:
   - APPROVED → exit loop, proceed to merge
   - CHANGES_REQUIRED → continue

4. Record review:
   scripts/prove-run review <task-id> rejected --notes "<summary>" --reviewer principal-architect

5. Launch fix agent in the SAME worktree (slug resolves automatically):
   Agent(
     subagent_type: "general-purpose",
     prompt: """
       Fix review findings for Task <task-id>.

       ## Findings
       <paste CHANGES_REQUIRED items>

       ## Rules
       - Fix ONLY flagged items
       - Do not refactor beyond the flags
       - Run tests after fixes
       - Commit: fix(<scope>): address review feedback (round N)
     """
   )

6. Go to step 1 (re-review)

If 3 iterations without APPROVED:
  - AskUserQuestion header "Resolution" — "Force Approve" / "Fix Manually" / "Abort"
```

On APPROVED:
```bash
scripts/prove-run review <task-id> approved --reviewer principal-architect
```

#### 2e. Sequential Merge-Back

After all wave tasks are approved:

1. Merge each task (in order) into the orchestrator worktree:
   ```bash
   cd .claude/worktrees/orchestrator-<slug>
   BRANCH=$(bash skills/orchestrator/scripts/manage-worktree.sh branch <slug> <task-id>)
   git merge "$BRANCH" --no-ff -m "merge: task <id> - <name>"
   ```

2. Clean up task worktree + branch:
   ```bash
   bash skills/orchestrator/scripts/manage-worktree.sh remove <slug> <task-id>
   ```

3. Merge conflict: halt, ask user. No force-merge.

4. Run full test suite after the wave merges.

#### 2f. Advance to Next Wave

Repeat 2a-2e for subsequent waves.

### Validation Gate (both modes)

Run validators in phase order: build → lint → test → custom → llm.

Validators load per `references/validation-config.md`.

#### LLM Validator Execution

For each prompt validator in `.claude/.prove.json`:

1. Read the prompt file
2. Generate diff (`git diff HEAD~1` simple, `git diff <base>...HEAD` full)
3. Launch:
   ```
   Agent(
     subagent_type: "validation-agent", model: "haiku",
     prompt: """
       ## Validation Prompt
       {prompt markdown content}

       ## Changes to Validate
       ```diff
       {diff}
       ```

       ## Instructions
       Evaluate against the prompt criteria. Return PASS/FAIL with findings.
     """
   )
   ```
4. PASS → log and continue. FAIL → same retry cycle as command validators.

#### Failure Protocol

1. `scripts/prove-run validator <step_id> <phase> fail`
2. Auto-fix attempt (one): send failure output, re-run validators
3. Still failing:
   - `scripts/prove-run step-halt <step_id> --reason "<phase> validation failed"`
   - Commit WIP (`orchestrator: [WIP] <step> (validation failed)`)
   - Halt execution; proceed to Phase 3

### Git Snapshot (both modes)

```bash
git add <files modified in this step>
git commit -m "$(cat <<'EOF'
orchestrator: step <step_id> - <step title>

Part of: <task title>
Validated: <phases that passed>

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

Capture the SHA and pass it to `scripts/prove-run step-complete --commit <SHA>` and `scripts/prove-run report --status completed --commit <SHA>`.

---

## Phase 3: Completion

Render the final status:

```bash
scripts/prove-run show state
```

`state.json` is the single source of truth. Do NOT write a report markdown file — the CLI renders it JIT. For the user-facing summary, combine:

- `scripts/prove-run show state` output
- `git diff --stat main...orchestrator/<slug>` for file changes
- Rollback recipes (linked below)

Present: status, JSON artifact paths, next action (review / fix blocker / merge). Never persist a markdown summary — it would drift from state.json.

---

## Phase 4: Merge & Cleanup

Runs after user review and approval. Skip if execution halted.

### 4.1 Merge Gate

AskUserQuestion header "Merge & Cleanup":
- "Merge & Clean" — merge, archive, delete branch
- "Merge Only" — merge, keep artifacts
- "Skip" — manual merge (remind user to run `/prove:task-cleanup`)

### 4.2 Merge to Main

```bash
git merge --no-ff orchestrator/<slug> -m "merge: <task-name>"
```

If another run merged first, pull/merge main first. On conflict: halt and inform the user — no force-merge.

### 4.3 Cleanup (if "Merge & Clean")

```bash
PROJECT_ROOT="." bash scripts/cleanup.sh --auto <slug>
```

Archives to `.prove/archive/<date>_<slug>/`, removes run directory, worktree, branch. Generates `SUMMARY.md` from JSON in archive.

### 4.4 Confirm

Present: merge SHA, archived location, skipped items. If "Skip": remind to run `/prove:task-cleanup <slug>`.

---

## Full Mode: Requirements Gathering (PRD)

When triggered with "full auto" and no existing plan:

1. Derive slug + branch namespace; create `.prove/runs/<branch>/<slug>/`
2. Read project context (`CLAUDE.md`, `README.md`, `docs/`, recent git history)
3. Launch requirements-gathering subagent (user stories, acceptance criteria, non-goals, constraints, verification)
4. Write `prd.json` via the task-planner skill (which emits valid JSON matching `packages/cli/src/topics/run-state/schemas.ts`)
5. AskUserQuestion header "PRD" — "Approve" / "Request Changes"
6. Generate `plan.json` (wave-based task graph, every task has `id`, `wave`, `deps`, `steps[]`)
7. AskUserQuestion header "Plan" — "Approve" / "Request Changes"
8. Run `scripts/prove-run init --branch <b> --slug <s> --plan ... --prd ...` to generate `state.json`

All artifacts live in the run directory. Concurrent runs stay isolated under different `<branch>/<slug>` paths.

---

## Error Handling

| Scenario | Action |
|----------|--------|
| No plan found | Stop, suggest `/prove:plan-task` |
| Branch exists | AskUserQuestion: Resume / Start Fresh |
| Build/test fails | One retry, then `step halt`, commit WIP, halt |
| Subagent produces no changes | Log in report, skip commit, continue |
| Git conflict | Halt, report to user |
| Unclear requirements | Halt, ask user |
| Review deadlock (3 rounds) | AskUserQuestion: Force Approve / Fix Manually / Abort |
| state.json write rejected by hook | Use `scripts/prove-run`; never `Write`/`Edit` state.json directly |
| No slug resolved | Ensure you are inside a worktree with `.prove-wt-slug.txt` (created by `scripts/manage-worktree.sh create`) |

## Rules

- All state mutations through `scripts/prove-run` — never direct-edit `state.json`, never inline `python3 -c`, `jq`, or `sed` for run state
- Never write markdown status files (`PROGRESS.md`, `run-log.md`, `report.md`) — views render JIT from JSON via the CLI
- Slug is resolved from `.prove-wt-slug.txt`; agents must not invent or pass slugs ad-hoc. If no slug, hard-error and surface the fix (create marker or run `scripts/manage-worktree.sh create`)
- Do not force-push or rewrite history on the orchestrator branch
- Every step passes validation before proceeding
- All work on the feature branch — main stays clean
- Prefer `git add <files>` over `git add -A`

## Conventions

**Branches**: `orchestrator/<slug>` (worktree: `.claude/worktrees/orchestrator-<slug>`). Sub-tasks: `task/<slug>/<task-id>` (worktree: `.claude/worktrees/<slug>-task-<task-id>`). Managed by `skills/orchestrator/scripts/manage-worktree.sh`.

**Run directory**:
```
.prove/runs/<branch>/<slug>/
├── prd.json          # Requirements
├── plan.json         # Task graph
├── state.json        # Live run state (mutated only via CLI)
├── state.json.lock
└── reports/
    └── <step_id>.json  # Per-step report (write-once)
```

## Scripts

| Script | Purpose |
|--------|---------|
| `scripts/prove-run` | Agent wrapper around the run_state CLI — all JSON mutations and renders go through this |
| `prove orchestrator task-prompt` | Prompt for worktree implementation agents (CLI subcommand) |
| `prove orchestrator review-prompt` | Review prompt for principal-architect (CLI subcommand) |
| `skills/orchestrator/scripts/manage-worktree.sh` | Create/remove/list sub-task worktrees (writes `.prove-wt-slug.txt`) |
| `scripts/cleanup.sh` | Archive and remove run artifacts |

## References

| File | Purpose |
|------|---------|
| `references/prd-template.md` | PRD field reference |
| `references/handoff-protocol.md` | Phase handoff |
| `references/reporter-protocol.md` | Reporter dispatch |
| `references/validation-config.md` | Validators (schema, auto-detect, execution order) |
| `references/interaction-patterns.md` | AskUserQuestion usage |

## Committing

Follow the `commit` skill: `scopes` from `.claude/.prove.json`, `<type>(<scope>): <description>`. One atomic commit per step.
