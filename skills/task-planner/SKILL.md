---
name: task-planner
description: Iterative discovery and planning for specific tasks, features, or bug fixes in existing codebases. Use when you need to plan a focused change by exploring code, gathering requirements, researching approaches, and identifying edge cases BEFORE implementation. Creates incremental, testable plans that can be executed step-by-step. Perfect for brownfield development where understanding the existing system is crucial.
---

# TODO: Migrate from ~/.claude/skills/task-planner-skill/SKILL.md

## Committing

When the user asks to commit planning artifacts (TASK_PLAN.md, etc.), delegate to the `commit` skill. Do not create ad-hoc commits. The commit skill reads `MANIFEST` for valid scopes and uses conventional commit format.

Example: `feat(task-planner): create task plan for api-refactor`
