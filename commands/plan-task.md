---
description: Plan implementation for a task
core: true
summary: Plan implementation for a task
---

# Plan Task

Start a task discovery and planning session.

**Task Description**: $ARGUMENTS

## Workflow

Load and execute the task-planner skill (`skills/task-planner/SKILL.md` from the workflow plugin). Follow all 6 discovery phases defined there.

The skill produces `prd.json` + `plan.json` under `.prove/runs/<branch>/<slug>/`, then runs `scripts/prove-run init` to create `state.json`. Each step in the plan must be independently testable, clearly verifiable, and sized for a single work session — ready for `/prove:plan-step`.
