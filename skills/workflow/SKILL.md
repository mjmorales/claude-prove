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
the milestone's tasks and `blocked_by` edges.

Assemble the plan from existing scrum reads (the `scrum compile-plan` CLI action is a planned follow-up — do **not** assume it exists; verify with `claude-prove scrum --help` before calling it, else use the steps below):

1. `claude-prove scrum task list --milestone <id>` — the task set.
2. `claude-prove scrum task show <task-id>` per task — read `blocked_by` for edges.
3. Map each scrum task → one plan task: `deps[]` = blocked-by task ids; `wave` =
   topological level (sources = wave 1, each dependent = max(dep wave)+1);
   `description` = the scrum description. v1 emits **one step per task**; pass
   `--decompose` to run `/prove:plan` per task for richer step trees.
4. Set `mode: "full"`. Write a sidecar `scrum-map.json` next to the plan
   (`{ "<plan-task-id>": "<scrum-task-id>" }`) so Phase 4 can resolve each plan task
   back to its scrum task — this survives plan regeneration; do **not** stuff the id
   into the title/description.

Write the plan under `.prove/runs/<branch>/<slug>/` where `<slug>` is the milestone
slug. This is regenerable — never hand-edit it; re-run compile instead.

---

## Phase 2: Backend selection

Default `--backend auto`:

| Backend | When | How |
|---------|------|-----|
| `dynamic` | Dynamic-workflows runtime available (Opus 4.8, Max/Team). | Render a background JS driver that runs the Phase 3 loop by calling the same `claude-prove` commands. Session stays responsive; plan state lives in the script + `prove.db`, not the context window. |
| `native` | No dynamic-workflows runtime. | Run the Phase 3 loop in-session via the orchestrator. |
| `auto` | Default. | Detect and pick `dynamic`, else `native`. |

Both backends call the **same** `claude-prove` commands — that shared vocabulary is
what makes the skill substrate-agnostic. Do not build a separate abstraction layer;
instead, route every backend through those CLI commands.

---

## Phase 3: Execute (delegate to orchestrator full-mode)

Run the compiled plan through the orchestrator's full mode — **do not reimplement**
worktrees, dispatch, validation, review, or merge.

```bash
claude-prove run-state init --branch <branch> --slug <slug> \
  --plan .prove/runs/<branch>/<slug>/plan.json
```

Then drive the standard full-mode loop (`skills/orchestrator/SKILL.md`, "Full Mode"):
per wave, create a worktree per task → dispatch `general-purpose` subagents in parallel
→ run validators → `principal-architect` review loop → sequential merge-back. The
orchestrator already enforces **driver-owns-writes** (subagents never call
`step-complete`) and **halt-on-conflict**.

Two deltas this skill applies:

- **Fan-out cap** = `--max-agents` (default **16** on `dynamic`, **4** on `native`).
  When a wave exceeds the cap, schedule by `scrum next-ready` order — its `score` /
  `rationale.unblock_depth` already ranks tasks by dependents freed. No extra ordering
  logic needed.
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
| `--max-agents <n>` | 16 dynamic / 4 native | Per-wave fan-out ceiling. |
| `--verify <tag>` | off | Force adversarial review on tagged tasks. |
| `--decompose` | off | Run `/prove:plan` per task for multi-step trees (else one step/task). |
| `--dry-run` | off | Compile + print the DAG, wave plan, and agent-count/cost estimate. Write nothing, dispatch nothing. |

---

## Guards & failure handling

- **`--dry-run` before any large run.** A milestone can spawn up to the dynamic-workflows
  ceiling (1000 agents/run) — print the projected wave plan and agent count first.
- **Halt-and-drain.** A failed task halts its branch only: independent branches keep
  running, dependents stay blocked, and the run reports partial completion. It does not
  wedge the whole milestone.
- **Merge conflict.** v1 reuses the orchestrator's halt-on-conflict. (Conflict-rebound
  into a fresh ready task is a planned v2 enhancement.)
- **Plan-only target.** Skip Phases 1 and 4 entirely; just init + execute.

---

## Notes

- Decision record: `.prove/decisions/2026-05-30-milestone-workflow-skill.md`.
- Research backing the dynamic-workflows model: `.prove/cache/prompting/opus-4-8-dynamic-workflows.md`.
- Open follow-up: a native `scrum compile-plan` CLI action (Phase 1) is preferred over
  shell assembly — see the decision record's follow-ups.
