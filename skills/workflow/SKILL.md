---
name: workflow
description: >
  Execute a whole scrum milestone or a plan.json task tree as one parallel
  fan-out run. Triggers on "run the milestone", "execute milestone", "workflow",
  "fan out the milestone", "parallel milestone", "run the whole task tree",
  "milestone autopilot". Compiles the dependency graph to a plan, runs its tasks
  in parallel waves through the orchestrator's full-mode machinery (worktrees,
  validators, principal-architect review, sequential merge), and mirrors task
  status back to the scrum store. Raises per-wave fan-out above the orchestrator
  default.
---

# Workflow Skill

Runs an **entire milestone or task tree** as one fan-out execution. The dependency
graph is the plan; tasks fan out in parallel waves; the orchestrator's existing
full-mode machinery does the per-task work; status flows back to the scrum store.

**Source of truth stays in `prove.db`.** The compiled `plan.json` is an *ephemeral
execution view* — disposable, regenerated from the milestone. This skill adds only
three things over the orchestrator: the scrum→plan compile, the status mirror-back,
and a raised fan-out cap. Everything else is reused.

**prove never spawns Claude — you do.** Every "dispatch" below is *you* launching a
*Claude Code* subagent (the `Agent` tool, or Claude Code's dynamic-workflows fan-out),
not an external process or a prove-rendered script. prove only emits artifacts (the plan,
the wave schedule, per-task prompts) and the CLI commands those subagents run.

---

## Input Resolution

Parse `$ARGUMENTS`. The first non-flag token is the **target**:

| Target | Meaning | Path |
|--------|---------|------|
| Milestone id (e.g. `auth-v1-mp8…`) | Compile its tasks + dep-graph to a plan. | Phase 1 (compile), then 2-4 |
| Path to a `plan.json` | Already executable — skip compile. | Phase 3 (execute) directly |
| *(none)* | If exactly one open milestone exists, offer it; else `AskUserQuestion` listing open milestones from `scrum status`. | — |

A **milestone** mirrors status back to scrum (Phase 4). A raw **plan.json** does not —
it has no scrum tasks to update.

---

## Phase 1: Compile milestone → plan.json

Goal: produce a standard `plan.json` (the schema the orchestrator already runs) from
the milestone's tasks and `blocked_by` edges. One command does it:

```bash
claude-prove scrum compile-plan --milestone <id> --out .prove/runs/<branch>/<slug>/plan.json
```

This writes the `plan.json` **and** a `scrum-map.json` sidecar (`{ "<plan-task-id>":
"<scrum-task-id>" }`) that Phase 4 uses to resolve each plan task back to its scrum task.
Compile rules (handled by the CLI): actionable tasks only (skips `done`/`cancelled`);
`deps[]` = in-scope `blocked_by` predecessors; `wave` = longest-path depth + 1; `mode`
= `full` at >= 4 tasks; one step per task. Dependency cycles error out.

The plan is **regenerable** — to change it, re-run compile rather than hand-editing.
For richer per-task step trees, pass `--decompose` to follow up with `/prove:plan` per
task (else one step/task). `<slug>` is the milestone slug.

---

## Phase 2: Backend selection

Default `--backend auto`:

| Backend | When | How |
|---------|------|-----|
| `dynamic` | Claude Code's dynamic-workflows preview is available (Opus 4.8, Max/Team). | Instruct Claude Code to launch a dynamic workflow that executes the `wave-plan` schedule — fanning the per-batch task subagents out in the background, each running the same `claude-prove` commands. Claude Code writes and runs the orchestration itself; prove emits no script. Session stays responsive; plan state lives in `prove.db`, not the context window. |
| `native` | No dynamic-workflows preview. | Run the Phase 3 loop in-session: dispatch each batch's task subagents with the `Agent` tool (`run_in_background: true`), as orchestrator full mode already does. |
| `auto` | Default. | Detect and pick `dynamic`, else `native`. |

Both backends drive the **same** `claude-prove` commands and the same `wave-plan`
schedule — only the fan-out mechanism differs (Claude Code's dynamic workflow vs. the
`Agent` tool). That shared vocabulary is what makes the skill substrate-agnostic; don't
add an abstraction layer over it.

---

## Phase 3: Execute (delegate to orchestrator full-mode)

Run the compiled plan through the orchestrator's full mode — **do not reimplement**
worktrees, dispatch, validation, review, or merge.

```bash
claude-prove run-state init --branch <branch> --slug <slug> \
  --plan .prove/runs/<branch>/<slug>/plan.json
```

Compute the dispatch schedule once, up front:

```bash
claude-prove orchestrator wave-plan --run-dir .prove/runs/<branch>/<slug> --max-agents <n>
```

It returns the waves split into batches capped at `--max-agents`, plus
`dispatch_rounds` and `peak_concurrency`. Dispatch each batch in order; fan out in
parallel within a batch. This is the scheduler both backends share — no ad-hoc ordering.

Then drive the standard full-mode loop (`skills/orchestrator/SKILL.md`, "Full Mode")
over those batches: create a worktree per task → launch one `general-purpose` Claude Code
subagent per task (the `Agent` tool, or the dynamic workflow's parallel fan-out), each
prompted via `claude-prove orchestrator task-prompt --run-dir <dir> --task-id <id>` →
run validators → `principal-architect` review loop → sequential merge-back. The
orchestrator already enforces **driver-owns-writes** (subagents never call
`step-complete`).

One delta this skill applies beyond the schedule:

- **`--verify <tag>`**: tasks carrying `<tag>` always run the adversarial
  `principal-architect` review (refute-until-approved), even if global review is off.

---

## Phase 4: Mirror status back to scrum (milestone target only)

The driver owns every scrum write. Resolve `<scrum-id>` from `scrum-map.json` (Phase 1).
After each task reaches a terminal state:

| Task outcome | Scrum write |
|--------------|-------------|
| Approved + merged | `claude-prove scrum task status <scrum-id> done`, then link the run: `claude-prove scrum link-run <scrum-id> .prove/runs/<branch>/<slug> --branch <branch> --slug <slug>` |
| Halted / failed after retry | `claude-prove scrum task status <scrum-id> blocked` — do **not** mark done. Its dependents stay blocked. |

(`link-run` takes the task id and run path as positionals — both required.)

When no ready tasks remain, emit a milestone summary: completed / blocked / skipped
counts and the blocked subtree, if any.

---

## Flags

| Flag | Default | Effect |
|------|---------|--------|
| `--backend auto\|dynamic\|native` | `auto` | Execution substrate (Phase 2). |
| `--max-agents <n>` | 16 dynamic / 4 native | Per-batch fan-out ceiling; `wave-plan` splits oversized waves into sequential batches at this cap. |
| `--verify <tag>` | off | Force adversarial review on tagged tasks. |
| `--decompose` | off | Run `/prove:plan` per task for multi-step trees (else one step/task). |
| `--dry-run` | off | Compile + print the DAG, wave plan, and agent-count/cost estimate. Write nothing, dispatch nothing. |

---

## Guards & failure handling

- **`--dry-run` before any large run.** A milestone can spawn up to the dynamic-workflows
  ceiling (1000 agents/run) — print the projected wave plan first and dispatch nothing:
  `claude-prove orchestrator wave-plan --run-dir <dir> --max-agents <n> --format md`.
- **Halt-and-drain.** A failed task halts its branch only: independent branches keep
  running, dependents stay blocked, and the run reports partial completion. It does not
  wedge the whole milestone.
- **Merge conflict.** Treat it like a failed task (halt-and-drain): abort that merge,
  mark the task `blocked`, keep merging independent branches. Auto-rebound — re-queueing
  the task rebased onto the updated branch — is a v2 enhancement.
- **Plan-only target.** Skip Phases 1 and 4 entirely; just init + execute.

---

## Notes

- Decision record: `.prove/decisions/2026-05-30-milestone-workflow-skill.md`.
- Research backing the dynamic-workflows model: `.prove/cache/prompting/opus-4-8-dynamic-workflows.md`.
- Phase 1 compile = `scrum compile-plan`; Phase 3 scheduling = `orchestrator wave-plan`.
- Fan-out is Claude Code's (`Agent` tool / dynamic-workflows) — see the principle above.
- Open follow-up (decision record): v2 merge-conflict auto-rebound (v1 halt-and-drains).
