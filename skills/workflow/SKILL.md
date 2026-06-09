---
name: workflow
description: >
  Execute a whole scrum milestone or a plan.json task tree as one parallel
  fan-out run. Triggers on "run the milestone", "execute milestone", "workflow",
  "fan out the milestone", "parallel milestone", "run the whole task tree",
  "milestone autopilot". Compiles the dependency graph to a plan, runs its tasks
  in parallel waves through the orchestrator's full-mode machinery (worktrees,
  validators, principal-architect review, sequential merge), mirrors task status
  back to the scrum store, and auto-rebounds on merge conflicts. Raises per-wave
  fan-out above the orchestrator default.
---

# Workflow Skill

You are the **driver**: you compile a milestone (or a ready `plan.json`) into a run,
schedule its tasks into dependency waves, and fan them out as one parallel execution.
The orchestrator's full-mode machinery does the per-task work (worktrees, validators,
review, merge); you wrap it with a scrum→plan compile, wave scheduling, status
mirror-back, and merge-conflict auto-rebound.

**Source of truth stays in `prove.db`.** The compiled `plan.json` is an *ephemeral
execution view* — disposable, regenerated from the milestone.

**prove never spawns Claude — you do.** Every "dispatch" below is you launching a
*Claude Code* subagent (the `Agent` tool, or Claude Code's dynamic-workflows fan-out),
never an external process or a prove-rendered script. prove only emits artifacts (the
plan, the wave schedule, per-task prompts) and the CLI commands those subagents run.

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
| `dynamic` | Dynamic-workflows preview available (Opus 4.8, Max/Team). | Launch a Claude Code dynamic workflow that executes the `wave-plan` schedule, fanning per-batch task subagents out in the background. The session stays responsive; plan state lives in `prove.db`, not the context window. |
| `native` | No dynamic-workflows preview. | Run the Phase 3 loop in-session: dispatch each batch's task subagents with the `Agent` tool (`run_in_background: true`), as orchestrator full mode already does. |
| `auto` | Default. | Detect and pick `dynamic`, else `native`. |

Both backends drive the **same** `claude-prove` commands and the same `wave-plan`
schedule — only the fan-out mechanism differs (dynamic workflow vs. `Agent` tool). Don't
add an abstraction layer over that shared vocabulary.

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
over those batches: create a worktree per task → launch one `general-purpose` subagent
per task, each prompted via `claude-prove orchestrator task-prompt --run-dir <dir>
--task-id <id>` → run validators → `principal-architect` review loop → sequential
merge-back. As in orchestrator full mode, subagents record typed findings, commit, and
exit; you own every step and scrum write — including the findings backstop: when a
worker's handoff message reports findings missing from the reasoning log, transcribe
them as typed `hack`/`risk`/`decision`/`assumption` entries before writing `synthesis`,
so milestone-close curation can sweep them.

One delta this skill applies beyond the schedule:

- **`--verify <tag>`**: tasks carrying `<tag>` always run the adversarial
  `principal-architect` review (refute-until-approved), even if global review is off.

---

## Durable execution directives (`execution` block)

A plan task carries an optional `execution` block of declarative directives the driver
honors and the run record persists. The engine **records** them; the driver **executes**
them — they are control flow, not judgment.

| Directive | Shape | Driver behavior |
|-----------|-------|-----------------|
| `retry` | `{ max: N }` | On a task's terminal failure, re-dispatch it up to `N` times before halt-and-drain. Rebuild on the current integration HEAD (the same reset path a merge-conflict rebound uses). |
| `loop` | `{ max_iterations: N }` | Repeat the task body until its own exit condition or `N` iterations — `N` is the runaway floor, NOT a target; the body decides early exit. |
| `fanout` | `{ batch_size: N }` | Fan the task's sub-work out `N`-wide; split larger sets into sequential batches at the cap (the same batching `wave-plan` applies per wave). |
| `on_fail` | `<task-id>` | On terminal failure, branch to the named task instead of halting the branch. Absent = halt-and-drain (the default). |
| `concurrency` | `parallel \| singleton` | `singleton` = at most one in-flight instance of this task across the run; a second dispatch waits for the first to reach a terminal state. `parallel` = no limit. (A story-close task runs `singleton`.) |

Absent block = run-once, no retry, no loop, fan-out 1, halt-on-fail, parallel — the
pre-directive behavior. The directives compose: a retried task that still fails takes its
`on_fail` branch; a `singleton` task's retries never overlap. Because they live in the
durable run record, a re-dispatch after a session break reads the same directives — the run's
retry/loop/fanout/branch policy survives the handoff rather than resetting.

---

## Cross-team step: `kind:<team-slug>`

A plan step whose `kind` names a **team slug** (rather than a normal implementation
step) is a request to *another team* — it delegates the work to that team and waits for
the team's published output. This is **sugar** over the cross-team ask protocol: it
files an ask, lets the responding team triage it, and collects the team's exposed
outputs once the delegated work is done. You compose three CLI primitives — you do not
reimplement the ask flow.

When you hit a `kind:<team-slug>` step, drive this loop. The judgment (the triage
verdict) belongs to the responding team's driver; the polling is mechanical.

1. **File the ask.** The blocking artifact is the step's own task — it stays blocked
   until the other team delivers.

   ```bash
   claude-prove scrum ask file \
     --from-team <this-team> --to-team <team-slug> \
     --ask-type <type> --blocking-artifact <this-step-task-id>
   ```

   The final stdout line is the new ask id. Capture it.

2. **Let the responding team triage.** The to-team's driver decides accept / reject /
   counter and applies the verdict with `claude-prove scrum ask respond <ask-id>
   --verdict accept|reject|counter [--comment …]`. On `accept` the store creates one
   child task under the to-team and wires the dependency automatically.

3. **Poll for resolution.** Re-run the mechanical primitive until it reports a
   **terminal** phase (`terminal: true` in its JSON). It spawns no model and never
   mutates — it just derives the current phase:

   ```bash
   claude-prove scrum ask await <ask-id>
   ```

   | `phase` | Meaning | `terminal` | What the step does |
   |---------|---------|-----------|--------------------|
   | `pending` | Filed, not yet triaged. | false | Poll again later. |
   | `waiting` | Accepted; the delegated child task is not `done` yet. | false | Poll again later. |
   | `ready` | Accepted and the child reached `done`. | true | Read `outputs` (the to-team's published outputs) and continue the plan. |
   | `rejected` | The team declined; `reason` carries why. | true | **Surface and stop** — do not loop. |
   | `countered` | The team proposed an alternative; `reason` carries it. | true | **Surface and stop** — re-plan or re-file against the counter. |

4. **Collect the outputs.** On `ready`, the report's `outputs` array is the responding
   team's published outputs (its active exposed interface) — that is the value the step
   returns to the rest of the plan.

**Reject and counter never hang.** They are terminal phases the poll surfaces explicitly,
so a `kind:<team-slug>` step that the other team declines or counters resolves the step
with a visible result the calling plan can act on — it never spins waiting for a delivery
that will not come. Treat a `rejected`/`countered` step like a halted task: surface the
`reason`, stop polling, and re-plan (drop the step, narrow scope, or re-file against the
counter) rather than blocking the wave.

---

## Phase 4: Mirror status back to scrum (milestone target only)

Resolve `<scrum-id>` from `scrum-map.json` (Phase 1). After each task reaches a terminal
state, write its outcome:

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
| `--max-rebounds <n>` | 2 | Merge-conflict rebound attempts per task before halt-and-drain (Guards). |
| `--dry-run` | off | Compile + print the DAG, wave plan, and agent-count/cost estimate. Write nothing, dispatch nothing. |

---

## Guards & failure handling

- **`--dry-run` before any large run.** A milestone can spawn up to the dynamic-workflows
  ceiling (1000 agents/run) — print the projected wave plan first and dispatch nothing:
  `claude-prove orchestrator wave-plan --run-dir <dir> --max-agents <n> --format md`.
- **Halt-and-drain.** A failed task halts its branch only: independent branches keep
  running, dependents stay blocked, and the run reports partial completion. It does not
  wedge the whole milestone.
- **Merge conflict → bounded rebound.** Rebuild the task on the updated integration HEAD
  and retry, instead of wedging the run. `git merge --abort`, then, up to `--max-rebounds`
  (default 2):
  1. `claude-prove worktree reset <slug> <task-id>` — resets
     the task worktree to integration HEAD, discarding its commits and picking up
     already-merged work.
  2. Re-dispatch the task (task-prompt subagent → validators → review), then retry the
     merge. Rebuilt on the merged base, the retry fast-forwards instead of re-conflicting.

  When the rebound budget is spent, fall back to **halt-and-drain**: keep merging
  independent branches, and for a milestone target mark the task blocked via Phase 4. The
  rebound count is tracked per task, reset each run.
- **Plan-only target.** Skip Phases 1 and 4 entirely; just init + execute.
- **Stopping a wave → the Layer-1 interrupt floor.** To abort in-flight tasks, do not
  wait on cooperation: `scrum task cancel <id> --cascade` → `run-state init --overwrite`
  → re-dispatch, with the `/workflows` token budget + subagent timeout as the hard stop.
  See `skills/orchestrator/SKILL.md` → "Interrupting a run — the Layer-1 floor".
- **Stopping a wave gracefully → the Layer-2 cooperative checkpoint-interrupt.** When you
  want in-flight work preserved rather than discarded, raise a cancel-flag instead of a
  hard abort: write a `CANCEL` file under the run dir
  (`.prove/runs/<branch>/<slug>/CANCEL`, resolved from the main worktree). Task subagents
  poll it at natural checkpoints — when set, each writes a `synthesis` graceful-handoff
  entry (`claude-prove acb log append`), commits work-in-progress, and self-exits, so a
  re-dispatch RESUMES from the handoff. Clear the flag (`rm -f .../CANCEL`) before
  re-dispatching. This is best-effort and layers ON TOP of the Layer-1 floor — it never
  replaces it: a non-polling or stuck task only stops at the token budget / subagent
  timeout, so Layer 1 stays the backstop. The worker-side protocol ships in the prompt
  emitted by `claude-prove orchestrator task-prompt`.

---

## Notes

- Phase 1 compile = `scrum compile-plan`; Phase 3 scheduling = `orchestrator wave-plan`;
  rebound reset = `claude-prove worktree reset`.
- Cross-team `kind:<team-slug>` step = `scrum ask file` → (responder `scrum ask respond`)
  → poll `scrum ask await` until terminal. `await` is the mechanical primitive; the
  triage verdict is the responding team's judgment.
- For large milestones, run the session at high effort (`xhigh`/`ultracode`) — the research
 recommends it for extended async fan-out.
