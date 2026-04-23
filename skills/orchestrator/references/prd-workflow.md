# PRD Workflow (Full Mode)

Requirements-gathering entry point for `--full` runs without an existing plan.

## Context

- **Runs in**: orchestrator (main process), before Phase 0.
- **Preconditions**: no `plan.json` exists for the target `<branch>/<slug>`; user invoked with `--full` (optionally with a seed task description).
- **Handoff**: on completion, control returns to `SKILL.md` Phase 0 (Initialization), which `prove-run init` has already prepared.

## Steps

1. **Derive slug + branch namespace**; create `.prove/runs/<branch>/<slug>/` (empty dir is fine — `init` writes `state.json` at step 8).
2. **Read project context**: `CLAUDE.md`, `README.md`, `docs/`, recent git history.
3. **Launch requirements subagent**:
   ```
   Agent(
     subagent_type: "general-purpose",
     prompt: <seed task desc + project context + PRD field shape from references/prd-template.md>
   )
   ```
   Subagent returns user stories, acceptance criteria, non-goals, technical constraints, verification strategy.
4. **Author `prd.json`** inline from the subagent's output. Shape: field list in `references/prd-template.md` (that file is a field reference — the on-disk artifact is JSON, not markdown). JSON must validate against the PRD schema in `packages/cli/src/topics/run-state/schemas.ts`; run `prove run-state validate` to confirm.
5. **PRD gate**: `AskUserQuestion` header `PRD` — **Approve** / **Request Changes**. On "Request Changes", revise `prd.json` and re-ask.
6. **Generate `plan.json`** via the `task-planner` skill. Wave-based task graph; every task has `id`, `wave`, `deps`, `steps[]`.
7. **Plan gate**: `AskUserQuestion` header `Plan` — **Approve** / **Request Changes**. On "Request Changes", revise `plan.json` (or re-run `task-planner`) and re-ask.
8. **Initialize run state**: run `scripts/prove-run init` with the new `plan.json` and `prd.json` (exact command: see `SKILL.md` Phase 0, step 3 — canonical location).

All artifacts live under the run directory. Concurrent runs stay isolated by distinct `<branch>/<slug>` paths.
