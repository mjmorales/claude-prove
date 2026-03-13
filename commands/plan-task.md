# Plan Task

Start a comprehensive task discovery and planning session for a specific task in this codebase.

## Instructions

You are initiating a **task-planner** workflow for iterative discovery and planning. The user wants to plan:

**Task Description**: $ARGUMENTS

## Follow the Task Planner Skill Workflow

Load and follow the task-planner skill (`skills/task-planner/SKILL.md` from the workflow plugin).

### Phase 1: Initial Understanding
Gather context by asking about:
- What exactly needs to be done?
- What's the current behavior vs. desired behavior?
- What triggered this need?
- Success criteria and constraints

### Phase 2: Code Discovery
Systematically explore the codebase:
- Locate relevant files and functions
- Map current architecture
- Understand data flow
- Check existing tests

### Phase 3: Research & Investigation
- Explore technical approaches
- Check git history for context
- Analyze dependencies

### Phase 4: Edge Case Discovery
Use the edge cases checklist from the task-planner skill references.

### Phase 5: Requirements Refinement
- Clarify ambiguities through discussion
- Uncover hidden requirements
- Define clear boundaries

### Phase 6: Solution Design
- High-level approach
- Implementation strategy
- Risk mitigation

## Output
After discovery, create a `TASK_PLAN.md` using the template from the task-planner skill assets.

Each step should be:
- Independently testable
- Clearly verifiable
- Small enough for a single work session
- Ready for use with the `/plan-step` command
