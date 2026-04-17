# Orchestrator

The orchestrator takes a task plan and executes it autonomously — creating a feature branch, running each implementation step, validating after every change, and committing only when the build is clean. It stops and asks for help rather than guessing through ambiguity.

## Overview

You give it a plan; it does the implementation. At every step it runs your validators, commits the result, and moves on. If anything fails after one retry, it halts and tells you exactly where and why.

**Prerequisite**: A `.prove/runs/<branch>/<slug>/plan.json` or `.prove/plans/` directory must exist before running the orchestrator. If you don't have a plan yet, run `/prove:task-planner` first.

## Execution Modes

### `/prove:orchestrator`

Standard entry point. Reads `.prove/runs/<branch>/<slug>/plan.json` and/or `.prove/plans/`, counts the steps, and auto-scales to simple or full mode.

```
/prove:orchestrator
```

If a matching `orchestrator/<task-slug>` branch already exists, it asks whether to resume from the last commit or start fresh.

### `/prove:autopilot`

Identical behavior to `/prove:orchestrator` but accepts an optional argument to target a specific plan when multiple plans are present.

```
/prove:autopilot
/prove:autopilot 2
/prove:autopilot "add user authentication"
```

### `/prove:full-auto`

End-to-end mode. Starts from a plain-language feature description rather than an existing plan:

1. **Requirements gathering** — interviews you to produce a PRD (user stories, acceptance criteria, non-goals, constraints)
2. **User approval gate** — shows the PRD, waits for "Approve" or "Request Changes"
3. **Planning** — generates `.prove/runs/<branch>/<slug>/plan.json` with a wave-based task graph
4. **User approval gate** — shows the plan, waits for "Approve" or "Request Changes"
5. **Execution** — runs full mode orchestration

```
/prove:full-auto add a CSV export feature to the reports page
```

## Simple vs Full Mode

The orchestrator counts the implementation steps and picks a mode automatically.

| Condition | Mode | Behavior |
| --- | --- | --- |
| 3 steps or fewer | Simple | Sequential execution, no worktrees, no architect review |
| 4+ steps | Full | Parallel worktrees, mandatory architect review, wave-based execution |

**Simple mode** runs steps one at a time in the main worktree. Lighter and faster — suitable for small changes.

**Full mode** groups independent steps into waves and runs each wave in parallel using isolated git worktrees. Each task must pass a principal architect review before merge. Max concurrency per wave is 4 parallel agents; larger waves are split into sub-waves.

The mode is logged at initialization and visible in `.prove/runs/<slug>/reports/run-log.md`.

## Validation Gates

After every implementation step — in both modes — the orchestrator runs all configured validators in phase order:

| Phase | What it checks |
| --- | --- |
| `build` | Project still compiles |
| `lint` | No new warnings or errors |
| `test` | All existing and new tests pass |
| `custom` | User-defined shell checks |
| `llm` | Prompt-based review by a `validation-agent` (haiku model) |

Validators are loaded from `.claude/.prove.json` if it exists, otherwise auto-detected from project files (Go, Rust, Python, Node, Godot, Makefile). LLM validators are never auto-detected — they must be explicitly configured.

### Example `.claude/.prove.json`

```json
{
  "schema_version": "1",
  "validators": [
    { "name": "build", "command": "go build ./...", "phase": "build" },
    { "name": "lint",  "command": "go vet ./...",   "phase": "lint" },
    { "name": "tests", "command": "go test ./...",  "phase": "test" },
    { "name": "doc-quality", "prompt": ".prove/prompts/doc-quality.md", "phase": "llm" }
  ]
}
```

### Failure handling

1. Validator fails — orchestrator attempts one auto-fix (sends error output back with a fix instruction, re-runs all validators)
2. If validators still fail — commits a WIP snapshot, writes the error to the run log, and **halts**
3. There is no second retry. The one-retry-then-halt rule is absolute.

### LLM validators

LLM validators (`phase: "llm"`) launch the `validation-agent` (haiku model) with the prompt file contents and a `git diff` of the current step's changes. The agent returns a structured PASS or FAIL verdict with findings referencing specific files and line numbers. Same retry semantics apply.

## Parallel Execution

In full mode, the orchestrator groups steps into **waves** based on their declared dependencies. Steps with no dependency on each other run in the same wave.

For each wave:

1. All tasks launch simultaneously as background agents, each in an isolated git worktree
2. The orchestrator waits for all tasks to complete
3. Each completed task goes through the architect review loop
4. After all tasks are approved, they merge back sequentially (in task order) using `--no-ff` merges
5. The full test suite runs after the wave merge
6. The next wave begins

Worktree branches are cleaned up automatically after a successful merge. Run `bash scripts/cleanup-worktrees.sh` to remove any strays.

If a merge conflict occurs, the orchestrator halts and asks you to resolve it.

## Principal Architect Review

In full mode, every completed worktree task must pass a review by the `principal-architect` agent before it can be merged. This is not optional — no task is merged without an APPROVED verdict.

**What the architect checks:**

1. **Scope compliance** — only listed files touched
2. **Correctness** — matches task description
3. **Code quality** — no unused code, proper naming, DRY
4. **Error handling** — edge cases covered
5. **Tests** — exist and cover happy path + error cases
6. **Consistency** — follows existing patterns
7. **No regressions** — doesn't break existing functionality

**The review loop (per task):**

1. A review prompt is generated from the worktree diff and task plan
2. The `principal-architect` agent returns `APPROVED` or `CHANGES_REQUIRED`
3. If `APPROVED`, the task proceeds to merge
4. If `CHANGES_REQUIRED`, a fix agent runs in the same worktree to address only the flagged items, then the loop repeats
5. After 3 iterations without approval, the orchestrator asks: force-approve, fix manually, or abort

Fix agents are scoped strictly: they address the reviewer's findings only and do not refactor beyond what was flagged.

## Inter-Agent Handoff

Agents pass context between steps via `.prove/context/<task-slug>/`.

The primary artifact is a chronological log (`handoff-log.md`). Every agent appends an entry before completing — summarizing what was implemented, what the next step needs to know, and which files were touched.

For complex tasks, agents can also write structured context files alongside the log:

| File | Use when |
| --- | --- |
| `api-contracts.md` | A step creates interfaces that later steps must implement against |
| `discoveries.md` | Exploration reveals something that changes the approach |
| `decisions.md` | A step makes a choice that wasn't in the original plan |
| `gotchas.md` | Something counter-intuitive that will trip up the next agent |

These files are optional — the log alone is sufficient for straightforward tasks. The context directory is cleaned up when you run `/prove:cleanup` after merging.

See `skills/orchestrator/references/handoff-protocol.md` for the full protocol.

## Progress Reporting

### state.json

During execution the orchestrator mutates `.prove/runs/<branch>/<slug>/state.json` — the single source of truth for run status, per-task/step lifecycle, validator outcomes, review verdicts, and the dispatch ledger. Mutations go exclusively through `scripts/prove-run` (a PreToolUse hook blocks direct edits). Views render JIT — no markdown status files are persisted. Each run has its own namespaced directory (`<branch>/<slug>/`), so concurrent runs stay isolated.

### `/prove:progress`

Check the current run status at any time without interrupting execution:

```
/prove:progress
```

Reports overall status, current wave, task statuses, review verdicts, and blockers. Read-only — never modifies progress files.

### Custom reporters

Reporters are dispatched automatically by Claude Code hooks on tool events, not invoked manually by the orchestrator.

Configure reporters in `.claude/.prove.json`:

```json
{
  "reporters": [
    {
      "name": "slack-notify",
      "command": "./.prove/notify-slack.sh",
      "events": ["step-complete", "step-halted", "execution-complete"]
    }
  ]
}
```

Reporter commands receive event context via environment variables: `PROVE_EVENT`, `PROVE_TASK`, `PROVE_STEP`, `PROVE_STATUS`, `PROVE_BRANCH`, `PROVE_DETAIL`.

Run `/prove:notify:notify-setup` to configure reporters interactively.

See `skills/orchestrator/references/reporter-protocol.md` for the full reporter interface.

## Permissions

Before running the orchestrator, pre-configure Claude Code permissions to avoid mid-execution approval prompts:

```
/prove:prep-permissions
```

This analyzes the active task plan and project toolchain, then writes appropriate rules to `.claude/settings.local.json`.

## Git Strategy

### Branch naming

All orchestrator work happens on a dedicated feature branch:

```
orchestrator/<task-slug>
```

The slug is derived from the task name: lowercase, hyphens, max 40 characters.

### Per-step commits

Every step that passes validation gets its own atomic commit. Steps are never bundled. If validation fails, a WIP commit is created before halting so the state is preserved.

### Rollback

```bash
# Revert a specific step
git revert <commit-sha>

# Roll back to after a specific step
git reset --hard <commit-sha>

# Discard everything
git checkout main
git branch -D orchestrator/<task-slug>
```

### Merging

After execution completes, the orchestrator offers a merge gate:

- **Merge & Clean** — merges to main, archives `.prove/` artifacts, deletes the branch
- **Merge Only** — merges to main, keeps artifacts for reference
- **Skip** — leaves merging to you

```bash
git checkout main
git merge --no-ff orchestrator/<task-slug> -m "merge: <task-slug>"
```

## Error Reference

| Situation | What happens |
| --- | --- |
| No `.prove/runs/<branch>/<slug>/plan.json` or `.prove/plans/` | Stops immediately, suggests `/prove:task-planner` |
| Branch already exists | Asks: resume from last commit or start fresh |
| Validation fails after one retry | WIP commit, halt, report shows blocker |
| Subagent produces no file changes | Logs warning, skips commit, continues |
| Git merge conflict | Halts immediately, does not auto-resolve |
| Step requirements are ambiguous | Halts, asks for clarification |
| Architect review fails 3 times | Asks: force-approve / fix manually / abort |
