# Plan Task

Start a task discovery and planning session.

**Task Description**: $ARGUMENTS

## Workflow

Load and execute the task-planner skill (`skills/task-planner/SKILL.md` from the workflow plugin). Follow all 6 discovery phases defined there.

The skill produces `.prove/TASK_PLAN.md`. Each implementation step in the plan must be independently testable, clearly verifiable, and sized for a single work session -- ready for `/plan-step`.
