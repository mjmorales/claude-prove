---
name: task-planner
description: Iterative discovery and planning for specific tasks, features, or bug fixes in existing codebases. Use when you need to plan a focused change by exploring code, gathering requirements, researching approaches, and identifying edge cases BEFORE implementation. Creates incremental, testable plans that can be executed step-by-step with the plan-step skill. Perfect for brownfield development where understanding the existing system is crucial.
---

# Task Planner Skill

Iterative discovery and planning process for specific tasks in existing codebases through research, code exploration, and requirements gathering.

## Overview

This skill facilitates a discovery-driven planning process for:
- Bug fixes that need investigation
- New features in existing systems
- Complex refactoring tasks
- Performance improvements
- Technical debt resolution

The output is a focused, incremental plan where each step is individually testable and verifiable.

## The Discovery Process

### Phase 1: Initial Understanding

Start the conversation:
```
"Let's plan [task/feature/bug]. First, help me understand what we're dealing with."
```

Gather initial context:
1. **Task Description**
   - "What exactly needs to be done?"
   - "What's the current behavior vs. desired behavior?"
   - "What triggered this need?"

2. **Success Criteria**
   - "How will we know this is fixed/complete?"
   - "What specific outcomes are expected?"
   - "Are there metrics we should track?"

3. **Constraints**
   - "What can't change?"
   - "What backwards compatibility is needed?"
   - "Any performance requirements?"

### Phase 2: Code Discovery

Explore the existing codebase systematically:

```
"Let's explore the codebase to understand the current implementation."
```

1. **Locate relevant code**
   - Search for related files/functions
   - Trace execution paths
   - Identify entry points

2. **Map the territory**
   - Document current architecture
   - Identify dependencies
   - Note integration points

3. **Understand data flow**
   - How data enters the system
   - Transformations applied
   - Where data is stored/output

Example discovery commands:
```bash
# Find files related to the feature
find . -name "*.py" | xargs grep -l "feature_name"

# Understand the call hierarchy
grep -r "function_name" --include="*.py"

# Check test coverage
grep -r "test.*feature_name" tests/

# Look for configuration
find . -name "*.conf" -o -name "*.yaml" | xargs grep -l "feature"
```

### Phase 3: Research & Investigation

Investigate unknowns and options:

1. **Technical Research**
   - "What approaches could solve this?"
   - "What are the trade-offs?"
   - "Are there libraries/patterns to consider?"

2. **Code Archaeology**
   - Check git history: `git log -p -- path/to/file`
   - Find related PRs/issues
   - Look for comments explaining "why"

3. **Dependency Analysis**
   - "What depends on this code?"
   - "What will be affected by changes?"
   - Run tests to understand coverage

### Phase 4: Edge Case Discovery

Systematically identify edge cases:

1. **Input Boundaries**
   - Empty/null inputs
   - Maximum/minimum values
   - Invalid data types
   - Malformed data

2. **State Conditions**
   - Concurrent access
   - Race conditions
   - Partial failures
   - System boundaries

3. **Error Scenarios**
   - Network failures
   - Timeout conditions
   - Permission issues
   - Resource exhaustion

Use this template:
```markdown
## Edge Cases Discovered

### Input Edge Cases
- [ ] Empty input: [What happens?]
- [ ] Null values: [How handled?]
- [ ] Invalid format: [Error behavior?]

### State Edge Cases
- [ ] Concurrent modification: [Thread safety?]
- [ ] Mid-operation failure: [Recovery?]
- [ ] Resource limits: [Behavior at limits?]

### Integration Edge Cases
- [ ] External service down: [Fallback?]
- [ ] Slow response: [Timeout handling?]
- [ ] Partial success: [Rollback strategy?]
```

### Phase 5: Requirements Refinement

Through iterative discussion:

1. **Clarify ambiguities**
   - "When you say X, do you mean..."
   - "Should this also handle..."
   - "What about the case where..."

2. **Uncover hidden requirements**
   - "Will this need to scale?"
   - "Are there audit/compliance needs?"
   - "Should we log specific events?"

3. **Define boundaries**
   - "This will/won't include..."
   - "We're assuming that..."
   - "Out of scope: ..."

### Phase 6: Solution Design

Design the approach:

1. **High-level approach**
   - Overall strategy
   - Key design decisions
   - Architecture changes (if any)

2. **Implementation strategy**
   - Where to make changes
   - Order of operations
   - Testing approach

3. **Risk mitigation**
   - Rollback plan
   - Feature flags
   - Gradual rollout

## Creating the Task Plan

After discovery, create `TASK_PLAN.md`:

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

### Step 1: [Preparation/Setup]
**Size**: XS/S/M/L/XL
**Description**: [What we're doing]
**Changes**:
- File: `path/to/file.py`
  - Action: [Add/Modify/Delete]
  - Details: [Specific changes]
**Verification**:
- [ ] [How to verify this step worked]
- [ ] [Another verification]
**Tests**:
- Unit test: [Test to write/update]
- Manual test: [Steps to verify]

### Step 2: [Core Implementation]
**Size**: XS/S/M/L/XL
**Description**: [What we're doing]
**Changes**:
- File: `path/to/another.py`
  - Action: [Specific changes]
**Dependencies**: Step 1 must be complete
**Verification**:
- [ ] [How to verify]
**Tests**:
- [Specific test cases]

### Step 3: [Edge Case Handling]
[Continue pattern...]

### Step 4: [Testing & Validation]
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

## Interactive Planning Patterns

### For Bug Fixes

```
"I need to fix [bug description]. Let's start by reproducing it and understanding the root cause."

1. Reproduce the issue
2. Trace through the code
3. Identify root cause
4. Plan the fix
5. Consider side effects
6. Plan verification
```

### For New Features

```
"I need to add [feature] to our existing [system]. Let's explore the codebase and plan the integration."

1. Understand current architecture
2. Identify integration points
3. Research implementation options
4. Plan incremental steps
5. Define test strategy
```

### For Performance Issues

```
"We have a performance problem with [component]. Let's investigate and plan optimizations."

1. Profile current performance
2. Identify bottlenecks
3. Research optimization strategies
4. Plan incremental improvements
5. Define performance tests
```

## Discovery Commands Toolbox

### Code Exploration
```bash
# Find all usages of a function/class
grep -r "ClassName\|function_name" --include="*.py"

# Understand file structure
tree -I '__pycache__|*.pyc|node_modules'

# Find recent changes
git log --since="2 weeks ago" --oneline -- path/

# See who last modified code
git blame path/to/file.py

# Find TODO/FIXME comments
grep -r "TODO\|FIXME\|XXX\|HACK" --include="*.py"
```

### Dependency Analysis
```bash
# Python imports
grep -h "^import\|^from.*import" *.py | sort | uniq

# Find circular dependencies
python -m pydeps --cluster

# Check what depends on a module
grep -r "import.*module_name" --include="*.py"
```

### Test Discovery
```bash
# Find related tests
find tests -name "*test*.py" -exec grep -l "feature_name" {} \;

# Check test coverage
pytest --cov=module_name --cov-report=term-missing

# Run specific test
pytest -xvs tests/test_feature.py::TestClass::test_method
```

## Conversation Starters

Use these to drive the discovery:

**Understanding Context**
- "What's the history behind this code?"
- "Are there any known issues or technical debt?"
- "Who are the stakeholders for this change?"

**Exploring Options**
- "I see three approaches: [A], [B], [C]. Let's discuss trade-offs."
- "We could fix this narrowly or address the broader issue. Thoughts?"
- "Should we refactor while we're here?"

**Finding Edge Cases**
- "What's the weirdest input this might receive?"
- "What happens if two users do this simultaneously?"
- "How does this behave under load?"

**Validating Understanding**
- "Let me summarize what I've learned..."
- "So the current flow is: [A] -> [B] -> [C], correct?"
- "The main risk seems to be [X]. Am I missing anything?"

## Output Integration

The `TASK_PLAN.md` output integrates with the plan-step skill:
1. Each step becomes a planning item
2. Steps are numbered for reference
3. Verification criteria enable testing
4. Dependencies are explicit

To use with plan-step:
```
"Let's work on Step 2 from the TASK_PLAN.md we created"
```

## Quality Checklist

Before finalizing the plan:

- [ ] Root cause understood (for bugs)
- [ ] All integration points identified
- [ ] Edge cases documented
- [ ] Each step independently verifiable
- [ ] Dependencies clearly stated
- [ ] Rollback strategy defined
- [ ] Tests planned for each step
- [ ] Performance impact considered
- [ ] Security implications reviewed
- [ ] Monitoring/logging planned

## Anti-Patterns to Avoid

- Planning without exploring the code
- Assuming without verifying
- Ignoring existing tests
- Not checking git history
- Skipping edge case analysis
- Making steps too large to verify
- Not planning for rollback
- Forgetting about dependencies

Remember: **Discovery drives planning**. The more we understand about the existing system, the better our plan will be.

## Bundled Resources

### Scripts
- `scripts/code_explorer.py` - Python utility for systematic code exploration during discovery phase. Provides commands for finding related files, analyzing imports, finding usages, exploring structure, and identifying TODOs.

### Assets
- `assets/task-planning-prompts.md` - Comprehensive prompt templates to start effective planning sessions, including scenario-specific prompts for bug fixes, features, performance, and refactoring
- `assets/templates/TASK_PLAN_template.md` - Standard template for the output task plan that integrates with the plan-step skill

### References
- `references/edge-cases-checklist.md` - Systematic checklist for discovering edge cases across different domains (web, database, files, distributed systems, etc.) with discovery techniques and priority matrix

## Using the Code Explorer

During discovery, use the code explorer script:

```bash
# Find files related to a feature
python scripts/code_explorer.py find "user_auth"

# Analyze imports in a file
python scripts/code_explorer.py imports src/auth.py

# Find all usages of a function
python scripts/code_explorer.py usages "validate_user"

# Get directory structure
python scripts/code_explorer.py structure --depth 3

# Find related tests
python scripts/code_explorer.py tests "authentication"

# Check git history
python scripts/code_explorer.py history src/auth.py

# Find TODOs and technical debt
python scripts/code_explorer.py todos

# Analyze file complexity
python scripts/code_explorer.py analyze src/auth.py
```

## Committing

When the user asks to commit planning artifacts (TASK_PLAN.md, etc.), delegate to the `commit` skill. Do not create ad-hoc commits. The commit skill reads `MANIFEST` for valid scopes and uses conventional commit format.

Example: `feat(task-planner): create task plan for api-refactor`
