---
name: plan-step
description: Interactive planning and requirement gathering for specific tasks from .prove/TASK_PLAN.md. Use when the user wants to work on a numbered step from their plan (e.g., "Let's work on step 1.2.3") to create detailed requirements, make design decisions, identify edge cases, and define test strategies BEFORE implementation.
---

# Plan Step Workflow Skill

Interactive planning and requirement gathering for specific steps from .prove/TASK_PLAN.md. **No code is written during this phase.**

## Instructions

### 1. Parse the Step Reference

Extract the step number from the user's request (e.g., "1.2.3", "2.4.1") and locate it in .prove/TASK_PLAN.md:
- Find the specific task details
- Extract: task description, size estimate, dependencies, and notes
- Identify the phase and verification criteria if available

### 2. Create Planning Workspace

Run the helper script to initialize the workspace with all template files:
```bash
python3 scripts/init_planning_workspace.py <step_number> "Task Title Here"
```

This creates `.prove/plans/plan_<step_number>/` with 8 template files: task overview, requirements, design decisions, open questions, potential issues, implementation plan, test strategy, and progress tracker.

If the script is unavailable, create the directory manually and populate files following the same structure. Read the script source for template content.

After initialization, populate `06_test_strategy.md` with the project's configured validators from `.claude/.prove.json` (build, lint, test commands). See `references/validation-config.md` for the spec.

### 3. Interactive Planning Process

After creating the workspace:

1. **Present the task overview** -- share what you found in .prove/TASK_PLAN.md
2. **Ask clarifying questions** -- probe for missing requirements
3. **Discuss design approaches** -- present options with tradeoffs
4. **Identify risks proactively** -- surface what could go wrong
5. **Document as you go** -- update planning files during discussion
6. **Track progress** -- keep progress.md current

### 4. Question Patterns

**For unclear requirements:**
- Discrete interpretations: use AskUserQuestion with options (e.g., "When you say [X], do you mean [A] or [B]?")
- Open-ended: free-form ("What should happen when [edge case]?")

**For design decisions:**
- Use AskUserQuestion to present approaches with tradeoffs. For choices with 3 or fewer options, include a "Research & proceed" option per `references/interaction-patterns.md`.
- "Would you prefer to optimize for [quality A] or [quality B]?" -- use AskUserQuestion with the qualities as options

**For validation:**
- "How will we know this is working correctly?"
- "What does success look like for this feature?"

### 5. Handling Dependencies

When a task has dependencies:
- Note them prominently in task overview
- Discuss whether to proceed with planning despite unmet dependencies
- Document interface assumptions
- Consider mock implementations for testing

### 6. Ready for Implementation

Before transitioning, verify:
- All open questions resolved or marked as acceptable unknowns
- Implementation plan is clear and actionable
- Test strategy covers key scenarios
- Design decisions are documented with rationale

Use AskUserQuestion with header "Ready" and options: "Begin Implementation" / "Review Plan First".

When the user chooses to proceed:
1. Update progress.md with "Implementation Started" and timestamp
2. The planning documents serve as reference during coding
3. Update documents if implementation reveals new considerations

## Constraints

- Never write implementation code during the planning phase
- Never make design assumptions without user confirmation -- surface ambiguity explicitly
- Reference existing code patterns from the codebase when discussing approaches

## References

- `references/planning-patterns.md` -- risk assessment matrices, requirement gathering patterns, design decision frameworks, edge case discovery, complexity estimation. Consult for complex planning scenarios.
- `references/interaction-patterns.md` -- when to use `AskUserQuestion` vs free-form discussion

## Committing

Delegate to the `commit` skill. Do not create ad-hoc commits.

Example: `feat(plan-step): define requirements for step 1.2.3`
