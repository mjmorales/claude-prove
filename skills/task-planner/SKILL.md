---
name: task-planner
description: Discovery-driven planning for tasks in existing codebases. Explores code, gathers requirements, identifies edge cases, and produces .prove/TASK_PLAN.md for the orchestrator.
---

# Task Planner Skill

Guide the user through iterative discovery and planning for a specific task in an existing codebase. Output: `.prove/TASK_PLAN.md`.

## Discovery Phases

### Phase 1: Initial Understanding

Gather from the user:
1. **Task description** -- current vs. desired behavior, what triggered the need
2. **Success criteria** -- measurable outcomes, completion signals
3. **Constraints** -- what cannot change, compatibility, performance requirements

### Phase 2: Code Discovery

Explore the codebase systematically:
1. **Locate relevant code** -- related files, execution paths, entry points
2. **Map the territory** -- architecture, dependencies, integration points
3. **Understand data flow** -- ingress, transformations, storage/output

Use `scripts/code_explorer.py` for structured exploration (find, imports, usages, structure, tests, history, todos, analyze).

### Phase 3: Research & Investigation

1. **Technical research** -- possible approaches, trade-offs, relevant libraries/patterns
2. **Code archaeology** -- git history, related PRs, explanatory comments
3. **Dependency analysis** -- what depends on this code, blast radius of changes

### Phase 4: Edge Case Discovery

Systematically identify edge cases across input boundaries, state conditions, and error scenarios. Use `references/edge-cases-checklist.md` for a comprehensive checklist by domain.

### Phase 5: Requirements Refinement

Through iterative discussion:
1. **Clarify ambiguities** -- when 2-3 discrete interpretations exist, use AskUserQuestion with those options plus a "Research & proceed" option (see `references/interaction-patterns.md`). When open-ended, use free-form discussion.
2. **Uncover hidden requirements** -- scaling, audit/compliance, logging needs
3. **Define boundaries** -- explicit in/out of scope, stated assumptions

### Phase 6: Solution Design

1. **High-level approach** -- strategy, key design decisions, architecture changes
2. **Implementation strategy** -- where to change, order of operations, testing approach
3. **Risk mitigation** -- rollback plan, feature flags, gradual rollout

## Creating the Task Plan

After discovery, create `.prove/TASK_PLAN.md`:

```markdown
# Task Plan: [Task Name]

**Type**: Bug Fix | Feature | Refactor | Performance
**Estimated Effort**: XS | S | M | L | XL
**Risk Level**: Low | Medium | High

## Summary
[1-2 sentences describing what we're doing and why]

## Current State
[What the code/system does now, based on our discovery]

## Desired State
[What it should do after our changes]

## Technical Approach
[High-level strategy based on our research]

## Implementation Steps

> **Header format (mandatory)**: Use `### Task {wave}.{seq}: {name}` -- e.g., `### Task 1.1:`, `### Task 2.1:`. The wave number groups parallelizable tasks; the seq number orders within a wave. The orchestrator's shell scripts parse these headers by exact pattern -- any other format will break execution.

### Task 1.1: [Preparation/Setup]
**Size**: XS/S/M/L/XL
**Description**: [What we're doing]
**Changes**:
- File: `path/to/file.py`
  - Action: [Add/Modify/Delete]
  - Details: [Specific changes]
**Verification**:
- [ ] [How to verify this task worked]
- [ ] [Another verification]
**Tests**:
- Unit test: [Test to write/update]
- Manual test: [Steps to verify]

### Task 1.2: [Core Implementation]
**Size**: XS/S/M/L/XL
**Description**: [What we're doing]
**Changes**:
- File: `path/to/another.py`
  - Action: [Specific changes]
**Dependencies**: Task 1.1 must be complete
**Verification**:
- [ ] [How to verify]
**Tests**:
- [Specific test cases]

### Task 1.3: [Edge Case Handling]
[Continue pattern...]

### Task 2.1: [Testing & Validation]
[Continue pattern...]

## Edge Cases to Handle
Based on our discovery:
- [Edge case 1]: [How we'll handle it]
- [Edge case 2]: [How we'll handle it]

## Rollback Plan
If issues arise:
1. [Rollback step 1]
2. [Rollback step 2]

## Monitoring
After deployment, monitor:
- [Metric/log to watch]
- [Alert to set up]

## Notes from Discovery
- [Important finding from code exploration]
- [Assumption we're making]
- [Technical debt noted for future]
```

A more detailed template with additional sections is available at `assets/templates/TASK_PLAN_template.md`.

## Validation Awareness

When building verification criteria, check for `.prove.json` in the project root. If present, use its validators for concrete verification commands. If absent, note that the orchestrator will auto-detect validators at runtime. See `references/validation-config.md` for the full spec.

## Output Integration

The `.prove/TASK_PLAN.md` feeds into the orchestrator skill. Each task becomes a planning item with numbered references, explicit dependencies, and verification criteria.

## Bundled Resources

### Scripts
- `scripts/code_explorer.py` -- systematic code exploration (find, imports, usages, structure, tests, history, todos, analyze)

### Assets
- `assets/task-planning-prompts.md` -- prompt templates for planning sessions (bug fixes, features, performance, refactoring)
- `assets/templates/TASK_PLAN_template.md` -- detailed output template with all optional sections

### References
- `references/edge-cases-checklist.md` -- edge case discovery checklist by domain (web, database, files, distributed systems)
- `references/interaction-patterns.md` -- when to use AskUserQuestion vs free-form discussion

## Committing

When the user asks to commit planning artifacts, delegate to the `commit` skill. Do not create ad-hoc commits. The commit skill reads `.prove.json` scopes for valid commit scopes and uses conventional commit format.
