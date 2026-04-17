---
name: plan-step
description: Interactive planning and requirement gathering for a specific task/step from the active run's plan.json. Use when the user wants to dig into a numbered step (e.g., "Let's work on step 1.2.3") to create detailed requirements, make design decisions, identify edge cases, and define test strategies BEFORE implementation.
---

# Plan Step Workflow Skill

Interactive planning for a specific step from the active run's `plan.json`. No code is written during this phase — planning only.

## Constraints

- Do not write implementation code during planning. Surface ambiguity instead of assuming.
- Reference existing code patterns from the codebase when discussing approaches.
- Follow `references/interaction-patterns.md` for AskUserQuestion vs free-form decisions.

## Workflow

### 1. Parse the Step Reference

Extract the step id from the user's request (e.g., `1.2.3`). Resolve the active run via the worktree marker, then read the step with:

```bash
scripts/prove-run step-info <step-id>
```

Returns JSON: `{task, step, task_state, step_state}`. Use it to extract description, acceptance criteria, dependencies.

### 2. Create Planning Workspace

```bash
python3 scripts/init_planning_workspace.py <step_id> "Task Title Here"
```

Creates `.prove/plans/plan_<step_id>/` with 8 template files (overview, requirements, design decisions, open questions, potential issues, implementation plan, test strategy, progress tracker).

Populate `06_test_strategy.md` with validators from `.claude/.prove.json`. See `references/validation-config.md`.

### 3. Interactive Planning

1. Present the task + step overview (rendered from plan.json)
2. Probe for missing requirements
3. Present design approaches with tradeoffs
4. Surface risks
5. Update planning files during discussion
6. Keep `progress.md` current (plan-step scratchpad, not state.json)

### 4. Question Patterns

- **Discrete interpretations**: AskUserQuestion with options. Include "Research & proceed" when 3 or fewer options (per `references/interaction-patterns.md`).
- **Open-ended**: free-form ("What should happen when [edge case]?")
- **Validation**: "How will we know this works?" / "What does success look like?"

### 5. Handling Dependencies

Check `plan.json` `tasks[].deps` for prerequisites. If deps unmet, discuss whether to plan despite them, document interface assumptions, and consider mocks for testing.

### 6. Ready for Implementation

Verify: open questions resolved, implementation plan actionable, test strategy covers key scenarios, design decisions documented with rationale.

Use AskUserQuestion with header "Ready" and options: "Begin Implementation" / "Review Plan First".

On proceed: the orchestrator will drive step execution — `plan-step` does not mutate `state.json`. Leave that to the orchestrator and its `run_state step start` / `step complete` calls.

## References

- `references/planning-patterns.md` — risk matrices, requirement patterns, design frameworks, complexity estimation
- `references/interaction-patterns.md` — AskUserQuestion vs free-form patterns

## Committing

Delegate to the `commit` skill. Do not create ad-hoc commits.
