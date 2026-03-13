---
name: orchestrator
description: >
  Autonomous task orchestrator that executes planned tasks end-to-end. Auto-scales between
  simple mode (≤3 steps, sequential, no worktrees) and full mode (4+ steps, parallel worktrees
  with mandatory principal-architect review). Creates feature branches, runs validation gates
  (build, test, lint), commits after each successful step, generates progress reports, and
  supports rollback via git. Use when a TASK_PLAN.md exists and the user wants hands-off
  execution. Triggers on "orchestrate", "autopilot", "full auto", "run autonomously",
  "implement without me", "hands-off mode".
---

# TODO: Merge autopilot + full-auto into single auto-scaling orchestrator
# See references/ for protocol specs

## Committing

All commits created during orchestrated execution MUST follow the `commit` skill conventions:

1. Read `MANIFEST` from the project root to derive valid scopes
2. Use conventional commit format: `<type>(<scope>): <description>`
3. If the target project has its own MANIFEST, use its scopes for implementation commits
4. If not, derive scope from the area of the codebase being changed

The orchestrator creates commits after each successful step. Each commit must be atomic and scoped — never bundle multiple steps into one commit.
