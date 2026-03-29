---
name: task-planner
description: Discovery-driven planning for tasks in existing codebases. Explores code, gathers requirements, identifies edge cases, and produces .prove/TASK_PLAN.md for the orchestrator.
---

# Task Planner Skill

Iterative discovery and planning for a task in an existing codebase. Output: `.prove/TASK_PLAN.md`.

## Discovery Phases

### Phase 1: Initial Understanding

Gather from the user:
1. **Task description** -- current vs. desired behavior, what triggered the need
2. **Success criteria** -- measurable outcomes, completion signals
3. **Constraints** -- what cannot change, compatibility, performance requirements

### Phase 2: Code Discovery

Explore the codebase using `scripts/code_explorer.py` (find, imports, usages, structure, tests, history, todos, analyze):
1. Locate relevant files, execution paths, entry points
2. Map architecture, dependencies, integration points
3. Trace data flow -- ingress, transformations, storage/output

### Phase 3: Research & Investigation

1. Technical research -- approaches, trade-offs, relevant libraries/patterns
2. Code archaeology -- git history, related PRs, explanatory comments
3. Dependency analysis -- what depends on this code, blast radius of changes

### Phase 4: Edge Case Discovery

Identify edge cases across input boundaries, state conditions, and error scenarios. Use `references/edge-cases-checklist.md` by domain.

### Phase 5: Requirements Refinement

1. **Clarify ambiguities** -- discrete interpretations: AskUserQuestion with options + "Research & proceed" (see `references/interaction-patterns.md`). Open-ended: free-form discussion.
2. **Uncover hidden requirements** -- scaling, audit/compliance, logging
3. **Define boundaries** -- explicit in/out of scope, stated assumptions

### Phase 6: Solution Design

1. High-level approach -- strategy, key design decisions, architecture changes
2. Implementation strategy -- where to change, order of operations, testing
3. Risk mitigation -- rollback plan, feature flags, gradual rollout

## Task Plan Output

After discovery, create `.prove/TASK_PLAN.md`. Full template at `assets/templates/TASK_PLAN_template.md`.

### Required Structure

```markdown
# Task Plan: [Task Name]

**Type**: Bug Fix | Feature | Refactor | Performance
**Estimated Effort**: XS | S | M | L | XL
**Risk Level**: Low | Medium | High

## Summary
[1-2 sentences: what and why]

## Current State / ## Desired State / ## Technical Approach
[Based on discovery findings]

## Implementation Steps
[Tasks using header format below]

## Edge Cases to Handle
- [Edge case]: [Handling strategy]

## Rollback Plan
## Monitoring
## Notes from Discovery
```

### Task Header Format

Headers use `### Task {wave}.{seq}: {name}` -- e.g., `### Task 1.1: Setup`, `### Task 2.1: Tests`. Wave groups parallelizable tasks; seq orders within a wave. The orchestrator parses this exact pattern.

### Task Fields

Each task includes:
- **Size**: XS/S/M/L/XL
- **Description**: what this task accomplishes
- **Changes**: file paths with Add/Modify/Delete actions and details
- **Dependencies**: (if any) which tasks must complete first
- **Verification**: checklist of how to verify success
- **Tests**: unit and manual test cases

## Validation Awareness

Check `.claude/.prove.json` for configured validators -- use those commands in verification criteria. If absent, the orchestrator auto-detects at runtime. See `references/validation-config.md`.

## Resources

- `scripts/code_explorer.py` -- structured code exploration
- `assets/task-planning-prompts.md` -- prompt templates for planning sessions
- `assets/templates/TASK_PLAN_template.md` -- detailed output template with all optional sections
- `references/edge-cases-checklist.md` -- edge case checklist by domain
- `references/interaction-patterns.md` -- AskUserQuestion vs free-form patterns

## Committing

Delegate to the `commit` skill. Do not create ad-hoc commits.
