---
description: Run the orchestrator in autopilot mode to autonomously implement a planned task
argument-hint: "[plan-number or task name]"
---

# Autopilot: $ARGUMENTS

You are running the **orchestrator** skill in autopilot mode for autonomous task implementation.

Load and follow the orchestrator skill (`skills/orchestrator/SKILL.md` from the workflow plugin).

## Quick Start

1. **Locate the plan**: Find `.prove/TASK_PLAN.md` and/or `.prove/plans/` directory in the current project
2. **If $ARGUMENTS is provided**: Look for a specific plan matching the argument
3. **Follow the orchestrator skill phases in order**: Initialization -> Plan Review -> Execution Loop -> Completion

## Key Behaviors

- Create a feature branch in its own worktree: `orchestrator/<task-slug>` at `.claude/worktrees/orchestrator-<slug>`
- Namespace all run state under `.prove/runs/<task-slug>/` (supports concurrent orchestrator runs)
- Auto-validate after EVERY step (build, tests, lint)
- Commit after each successful step
- On validation failure: one retry, then HALT
- Generate reports in `.prove/runs/<task-slug>/reports/`
- Present the final report and review instructions to the user

## Do NOT

- Skip validation gates
- Continue past a failed step (after retry)
- Force-push or amend commits
- Make changes on the main branch or check out branches in the main worktree
- Proceed if requirements are ambiguous — halt and use `AskUserQuestion` to clarify (when discrete options exist) or ask free-form (when open-ended)
