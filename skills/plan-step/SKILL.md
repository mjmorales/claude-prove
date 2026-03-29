---
name: plan-step
description: Interactive planning and requirement gathering for specific tasks from .prove/TASK_PLAN.md. Use when the user wants to work on a numbered step from their plan (e.g., "Let's work on step 1.2.3") to create detailed requirements, make design decisions, identify edge cases, and define test strategies BEFORE implementation.
---

# Plan Step Workflow Skill

Interactive planning for a specific step from `.prove/TASK_PLAN.md`. No code is written during this phase -- planning only.

## Constraints

- Do not write implementation code during planning. Surface ambiguity instead of assuming.
- Reference existing code patterns from the codebase when discussing approaches.
- Follow `references/interaction-patterns.md` for AskUserQuestion vs free-form decisions.

## Workflow

### 1. Parse the Step Reference

Extract the step number from the user's request (e.g., "1.2.3") and locate it in `.prove/TASK_PLAN.md`. Extract: description, size estimate, dependencies, verification criteria.

### 2. Create Planning Workspace

```bash
python3 scripts/init_planning_workspace.py <step_number> "Task Title Here"
```

Creates `.prove/plans/plan_<step_number>/` with 8 template files (overview, requirements, design decisions, open questions, potential issues, implementation plan, test strategy, progress tracker).

Fallback: if the script is unavailable, create the directory manually -- read the script source for template content.

After initialization, populate `06_test_strategy.md` with validators from `.claude/.prove.json`. See `references/validation-config.md`.

### 3. Interactive Planning

1. Present the task overview from `.prove/TASK_PLAN.md`
2. Probe for missing requirements
3. Present design approaches with tradeoffs
4. Surface risks
5. Update planning files during discussion
6. Keep `progress.md` current

### 4. Question Patterns

- **Discrete interpretations**: AskUserQuestion with options. Include "Research & proceed" when 3 or fewer options (per `references/interaction-patterns.md`).
- **Open-ended**: free-form ("What should happen when [edge case]?")
- **Validation**: "How will we know this works?" / "What does success look like?"

### 5. Handling Dependencies

Note dependencies in the task overview. Discuss whether to plan despite unmet dependencies, document interface assumptions, and consider mocks for testing.

### 6. Ready for Implementation

Verify: open questions resolved, implementation plan actionable, test strategy covers key scenarios, design decisions documented with rationale.

Use AskUserQuestion with header "Ready" and options: "Begin Implementation" / "Review Plan First".

On proceed: update `progress.md` with "Implementation Started" and timestamp.

## References

- `references/planning-patterns.md` -- risk matrices, requirement patterns, design frameworks, complexity estimation
- `references/interaction-patterns.md` -- AskUserQuestion vs free-form patterns

## Committing

Delegate to the `commit` skill. Do not create ad-hoc commits.
