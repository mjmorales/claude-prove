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

Substitute the target step id and task title, then run this block from the repo root to scaffold `.prove/plans/plan_<step_id>/` with the 8 template files (overview, requirements, design decisions, open questions, potential issues, implementation plan, test strategy, progress tracker):

```bash
STEP_ID="<step-id>"
TITLE="<Task Title>"
TS="$(date +%Y-%m-%d\ %H:%M)"
WORKSPACE=".prove/plans/plan_${STEP_ID}"
mkdir -p "${WORKSPACE}"

cat > "${WORKSPACE}/00_task_overview.md" <<EOF
# Task ${STEP_ID}: ${TITLE}

**Phase**: [Phase name from PLAN.md]
**Size Estimate**: [XS/S/M/L/XL/XXL]
**Status**: Planning
**Dependencies**: [List task dependencies]

## Original Task Description
[Full description from PLAN.md]

## Verification Criteria
[From tcg_implementation_plan.md if available]

## Related Tasks
- [List related/dependent tasks with numbers]
EOF

cat > "${WORKSPACE}/01_requirements.md" <<EOF
# Requirements for Task ${STEP_ID}

## Functional Requirements
- [ ] [Specific, measurable requirement]
- [ ] [Another requirement]

## Non-Functional Requirements
- [ ] Performance: [specific expectations]
- [ ] Error handling: [approach]
- [ ] Logging: [requirements]
- [ ] Security: [considerations]

## Acceptance Criteria
- [ ] [Testable criterion]
- [ ] [Another criterion]

## Out of Scope
- [Explicitly excluded items]
EOF

cat > "${WORKSPACE}/02_design_decisions.md" <<EOF
# Design Decisions for Task ${STEP_ID}

## Approach Options

### Option 1: [Name]
**Pros:**
- [Advantage]

**Cons:**
- [Disadvantage]

### Option 2: [Name]
**Pros:**
- [Advantage]

**Cons:**
- [Disadvantage]

## Selected Approach
[Which option and why]

## Technical Choices
- **Technology/Library**: [Choice] because [reason]
- **Pattern**: [Choice] because [reason]

## API/Interface Design
[Define contracts and interfaces]
EOF

cat > "${WORKSPACE}/03_open_questions.md" <<EOF
# Open Questions for Task ${STEP_ID}

## Technical Questions
1. **Q:** [Question about implementation?]
   **A:** [Answer when resolved]

2. **Q:** [Question about technology choice?]
   **A:** [Pending]

## Design Questions
1. **Q:** [Architecture question?]
   **A:** [Answer]

## Requirements Questions
1. **Q:** [Unclear requirement?]
   **A:** [Clarification]

---
*Mark questions as resolved by adding answers*
EOF

cat > "${WORKSPACE}/04_potential_issues.md" <<EOF
# Potential Issues for Task ${STEP_ID}

## Technical Risks
- **Risk**: [Description]
  **Mitigation**: [Strategy]

## Edge Cases
- [Edge case scenario]
  - How to handle: [approach]

## Performance Concerns
- [Potential bottleneck]
  - Solution: [approach]

## Integration Points
- [System/component to integrate with]
  - Consideration: [what to watch for]
EOF

cat > "${WORKSPACE}/05_implementation_plan.md" <<EOF
# Implementation Plan for Task ${STEP_ID}

## Prerequisites
- [ ] [What must be in place first]
- [ ] [Dependencies resolved]

## Implementation Steps
1. **[Step name]**
   - Action: [What to do]
   - Files: [Files to create/modify]
   - Validation: [How to verify]

2. **[Next step]**
   - Action: [What to do]
   - Files: [Files affected]
   - Validation: [How to verify]

## Code Structure
\`\`\`
[Show file/folder structure]
\`\`\`

## Key Implementation Notes
- [Important consideration]
- [Technical detail to remember]
EOF

cat > "${WORKSPACE}/06_test_strategy.md" <<EOF
# Test Strategy for Task ${STEP_ID}

## Unit Tests
- **Test**: [What to test]
  **Expected**: [Expected behavior]

## Integration Tests
- **Scenario**: [Description]
  **Setup**: [Required setup]
  **Expected**: [Expected outcome]

## Edge Case Tests
- **Case**: [Edge case]
  **Expected**: [How it should handle]

## Manual Testing Steps
1. [Step to verify functionality]
2. [Another verification step]

## Test Coverage Goals
- [Coverage target and rationale]
EOF

cat > "${WORKSPACE}/progress.md" <<EOF
# Planning Progress for Task ${STEP_ID}

**Started**: ${TS}
**Current Phase**: Requirements Gathering

## Planning Checklist
- [ ] Task overview completed
- [ ] Requirements documented
- [ ] Design decisions made
- [ ] Open questions resolved
- [ ] Potential issues identified
- [ ] Implementation plan drafted
- [ ] Test strategy defined
- [ ] Ready for implementation

## Discussion Log
### ${TS}
- Planning workspace initialized
EOF
```

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
