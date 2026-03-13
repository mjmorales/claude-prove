---
name: plan-step
description: Interactive planning and requirement gathering for specific tasks from TASK_PLAN.md. Use when the user wants to work on a numbered step from their plan to create detailed requirements, make design decisions, identify edge cases, and define test strategies BEFORE implementation.
---

# TODO: Migrate from ~/.claude/skills/plan-step-skill/SKILL.md

## Committing

When the user asks to commit plan step artifacts (requirements, design decisions, etc.), delegate to the `commit` skill. Do not create ad-hoc commits. The commit skill reads `MANIFEST` for valid scopes and uses conventional commit format.

Example: `feat(plan-step): define requirements for step 1.2.3`
