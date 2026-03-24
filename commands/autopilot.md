---
description: Run the orchestrator in autopilot mode to autonomously implement a planned task
argument-hint: "[plan-number or task name]"
core: true
summary: Autonomous execution with validation gates
---

# Autopilot: $ARGUMENTS

Load and follow the orchestrator skill (`skills/orchestrator/SKILL.md`). Execute all phases in order: Initialization, Plan Review, Execution Loop, Completion.

**Mode**: Autopilot — a plan already exists. Derive slug from `$ARGUMENTS`, locate the matching `.prove/runs/<slug>/TASK_PLAN.md` or `.prove/plans/` directory, and begin execution. Do NOT run requirements gathering (PRD phase).
