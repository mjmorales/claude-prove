---
description: Show orchestrator execution status — current wave, task statuses, review verdicts, and blockers
---

# Progress Report

Read-only status check across active orchestrator runs. Never modify files.

## Steps

1. List active runs:
   ```bash
   scripts/prove-run ls
   ```
   If empty: "No active orchestrator run. Start one with `/prove:orchestrator` or `/prove:full-auto`."

2. For each run, render the full state view (joined with the plan for titles):
   ```bash
   cd <worktree for slug>  # or rely on PROVE_RUN_SLUG / marker
   scripts/prove-run show state
   ```
   `state.json` is the source of truth. Markdown is rendered JIT — never persisted.

3. If multiple runs, precede with a summary table:

   | Branch/Slug | Status | Current Step | Tasks done/total |
   |-------------|--------|--------------|------------------|

4. For completed runs, follow the rendered state with:
   - Total duration (`started_at` → `ended_at` from state.json)
   - Review verdicts summary
   - Merge readiness (clean vs halted)

## Rules

- Read-only — never invoke step/task/validator mutators
- `state.json` is the single source of truth; `scripts/prove-run show` renders views on demand
- Agents must not parse JSON directly — use `scripts/prove-run summary` for one-line and `show` for full
- State ambiguity explicitly rather than guessing
- Keep output concise
