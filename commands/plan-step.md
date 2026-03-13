# Plan Step

Create detailed planning workspace for a specific step from TASK_PLAN.md.

## Instructions

You are initiating a **plan-step** workflow for detailed planning of a specific task step BEFORE implementation.

**Step Reference**: $ARGUMENTS

## Follow the Plan Step Skill Workflow

Load and follow the plan-step skill (`skills/plan-step/SKILL.md` from the workflow plugin).

### 1. Parse the Step Reference
Extract the step number (e.g., "1", "2.1", "Step 3") from the arguments and locate it in `TASK_PLAN.md`.

### 2. Create Planning Workspace
Create a directory: `plans/plan_[step_number]/`

Initialize all planning documents (task overview, requirements, design decisions, open questions, potential issues, implementation plan, test strategy, progress tracker).

### 3. Interactive Planning Process

After creating the workspace:
1. Present the task overview from TASK_PLAN.md
2. Ask clarifying questions about requirements
3. Discuss design approaches with tradeoffs
4. Identify risks proactively
5. Document decisions as you go
6. Track progress in progress.md

## Ready for Implementation Checklist

Before transitioning to implementation, verify:
- [ ] All open questions resolved
- [ ] Implementation plan is clear
- [ ] Test strategy covers key scenarios
- [ ] Design decisions documented
- [ ] User confirms understanding

Ask: "Planning complete for step [X]. Ready to implement, or review anything?"
