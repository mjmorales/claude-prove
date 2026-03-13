---
name: plan-step
description: Interactive planning and requirement gathering for specific tasks from .prove/TASK_PLAN.md. Use when the user wants to work on a numbered step from their plan (e.g., "Let's work on step 1.2.3") to create detailed requirements, make design decisions, identify edge cases, and define test strategies BEFORE implementation.
---

# Plan Step Workflow Skill

Interactive planning and requirement gathering process for specific steps from .prove/TASK_PLAN.md that happens **BEFORE implementation**.

## Workflow Overview

When the user references a specific step number from .prove/TASK_PLAN.md, follow this structured planning process to ensure thorough requirement gathering and design clarity before any code is written.

## Instructions

### 1. Parse the Step Reference

Extract the step number from the user's request (e.g., "1.2.3", "2.4.1") and locate the task in .prove/TASK_PLAN.md:
- Read .prove/TASK_PLAN.md and find the specific task details
- Extract: task description, size estimate, dependencies, and notes
- Identify the phase and verification criteria if available

### 2. Create Planning Workspace

Create a dedicated planning directory and initialize files.

**Option A: Use the helper script** (Recommended)
```bash
python3 scripts/init_planning_workspace.py 1.2.3 "Task Title Here"
```

**Option B: Manual creation**
```bash
mkdir -p .prove/plans/plan_[step_number]/  # e.g., .prove/plans/plan_1.2.3/
```

Initialize these planning documents in the directory:
- `00_task_overview.md` - Summary from .prove/TASK_PLAN.md with context
- `01_requirements.md` - Detailed requirements and acceptance criteria
- `02_design_decisions.md` - Architecture choices with tradeoff analysis
- `03_open_questions.md` - Questions needing answers before implementation
- `04_potential_issues.md` - Risks, edge cases, and technical concerns
- `05_implementation_plan.md` - Step-by-step implementation approach
- `06_test_strategy.md` - Testing approach with specific test cases
- `progress.md` - Planning progress tracker

### 3. Document Templates

#### 00_task_overview.md
```markdown
# Task [X.Y.Z]: [Task Title]

**Phase**: [Phase name from PLAN.md]
**Size Estimate**: [XS/S/M/L/XL/XXL]
**Status**: Planning
**Dependencies**: [List task dependencies]

## Original Task Description
[Full description from PLAN.md]

## Verification Criteria
[From implementation plan if available]

## Related Tasks
- [List related/dependent tasks with numbers]
```

#### 01_requirements.md
```markdown
# Requirements for Task [X.Y.Z]

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
```

#### 02_design_decisions.md
```markdown
# Design Decisions for Task [X.Y.Z]

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
```

#### 03_open_questions.md
```markdown
# Open Questions for Task [X.Y.Z]

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
```

#### 04_potential_issues.md
```markdown
# Potential Issues for Task [X.Y.Z]

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
```

#### 05_implementation_plan.md
```markdown
# Implementation Plan for Task [X.Y.Z]

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
```
[Show file/folder structure]
```

## Key Implementation Notes
- [Important consideration]
- [Technical detail to remember]
```

#### 06_test_strategy.md
```markdown
# Test Strategy for Task [X.Y.Z]

## Project Validators
<!-- Check .prove.json for configured validators. If absent, the orchestrator auto-detects. -->
<!-- See references/validation-config.md for the full spec. -->
- **Build**: [command from .prove.json or auto-detected, e.g. `go build ./...`]
- **Lint**: [command, e.g. `go vet ./...`]
- **Test**: [command, e.g. `go test ./...`]
- **Custom**: [if any]

These validators will be enforced by the orchestrator after this step is implemented.

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
```

#### progress.md
```markdown
# Planning Progress for Task [X.Y.Z]

**Started**: [Date/Time]
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
### [Date/Time]
- [Summary of discussion or decision made]
```

### 4. Interactive Planning Process

After creating the workspace:

1. **Present the task overview** - Share what you found in .prove/TASK_PLAN.md
2. **Ask clarifying questions** - Probe for missing requirements
3. **Discuss design approaches** - Present options with tradeoffs
4. **Identify risks proactively** - Think about what could go wrong
5. **Document as you go** - Update files during discussion
6. **Track progress** - Keep progress.md current

### 5. Question Templates

Use these question patterns to gather requirements:

**For unclear requirements:**
- "When you say [X], do you mean [interpretation A] or [interpretation B]?"
- "What should happen when [edge case]?"
- "Are there any constraints on [aspect]?"

**For design decisions:**
- "I see two approaches here: [Option A] which is [simpler but limited], or [Option B] which is [complex but flexible]. Which aligns better with your needs?"
- "Would you prefer to optimize for [quality A] or [quality B]?"

**For validation:**
- "How will we know this is working correctly?"
- "What does success look like for this feature?"

### 6. Handling Dependencies

When a task has dependencies:
- Note them prominently in task overview
- Discuss whether to proceed with planning
- Document interface assumptions
- Consider mock implementations for testing

### 7. Ready for Implementation Checklist

Before transitioning to implementation, verify:
- All open questions resolved or marked as acceptable unknowns
- Implementation plan is clear and actionable
- Test strategy covers key scenarios
- Design decisions are documented with rationale
- User confirms understanding and agreement

Ask: "We've completed the planning for task [X.Y.Z]. The plan includes [brief summary]. Are you ready to begin implementation, or would you like to review any aspects of the plan?"

## Important Guidelines

### DO:
- Ask questions to clarify ambiguity
- Present multiple approaches with clear tradeoffs
- Think proactively about edge cases
- Reference existing code patterns from the codebase
- Update planning docs in real-time during discussion
- Keep the user engaged in all decisions
- Be thorough to avoid rework later

### DON'T:
- Start implementing code during planning phase
- Make assumptions without user confirmation
- Gloss over potential issues
- Rush to implementation
- Skip the planning phase even if task seems simple

## File Organization Example

```
.prove/plans/
├── plan_1.2.1/
│   ├── 00_task_overview.md
│   ├── 01_requirements.md
│   ├── 02_design_decisions.md
│   ├── 03_open_questions.md
│   ├── 04_potential_issues.md
│   ├── 05_implementation_plan.md
│   ├── 06_test_strategy.md
│   └── progress.md
│   ├── plan_1.2.2/
│   │   └── [same structure]
│   └── plan_1.2.3/
    └── [same structure]
```

## Transitioning to Implementation

When planning is complete:
1. Summarize what was planned
2. Confirm user readiness
3. Update progress.md with "Implementation Started" and timestamp
4. Use the planning documents as reference during coding
5. Update documents if implementation reveals new considerations

Remember: **Thorough planning prevents rework.** Take time to understand requirements fully before writing any code.

## Bundled Resources

### Scripts
- `scripts/init_planning_workspace.py` - Quickly initialize a complete planning workspace with all required template files

### References
- `references/planning-patterns.md` - Advanced planning techniques including risk assessment matrices, requirement gathering patterns, design decision frameworks, edge case discovery techniques, and complexity estimation methods. Consult when dealing with complex planning scenarios.

## Committing

When the user asks to commit plan step artifacts (requirements, design decisions, etc.), delegate to the `commit` skill. Do not create ad-hoc commits. The commit skill reads `MANIFEST` for valid scopes and uses conventional commit format.

Example: `feat(plan-step): define requirements for step 1.2.3`
