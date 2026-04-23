---
description: Plan a task (discovery + prd.json/plan.json) or drill into a numbered step
argument-hint: "[--task <desc> | --step <id>]"
core: true
summary: Plan a task or a specific step from the active plan.json
---

# Plan

**Arguments**: $ARGUMENTS

Load and execute the plan skill (`skills/plan/SKILL.md`).

- `--task [description]` — discovery-driven planning; produces `prd.json` + `plan.json` under `.prove/runs/<branch>/<slug>/` and runs `scripts/prove-run init`. Each step must be independently testable and sized for a single session — ready for `--step` drill-down or `/prove:orchestrator`.
- `--step <id>` — interactive planning drill for a numbered step (e.g., `1.2.3`) from the active run's `plan.json`. Produces `.prove/plans/plan_<step_id>/` workspace with requirements, design decisions, edge cases, and test strategy.
- No args — the skill prompts for Task vs Step via `AskUserQuestion`.
