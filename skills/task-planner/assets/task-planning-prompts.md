# Task Planning Prompt Templates

Use these prompts to start an effective task planning session with Claude.

---

## Master Prompt for Task Planning

```
I need to plan a [bug fix/new feature/refactoring] for our existing codebase. Let's go through an iterative discovery process to understand the requirements, explore the code, and create a detailed implementation plan.

## Task Overview
**What we're doing**: [Describe the task/bug/feature]
**Why it's needed**: [Business reason or problem it solves]
**Current situation**: [What's happening now that needs to change]

## Initial Context
**Affected area**: [Component/module/service]
**Codebase info**: [Language, framework, key libraries]
**Related files** (if known): [List any files you know are involved]

## What I Need From This Planning Session
1. Understand the current implementation through code exploration
2. Identify all edge cases and potential issues
3. Research possible approaches with trade-offs
4. Create an incremental implementation plan
5. Define clear verification steps for each phase

Let's start by exploring the codebase to understand what we're working with. Please guide me through:
- What code we should look at
- What questions we need to answer
- What edge cases to consider
- What approaches might work

I'll provide code snippets, test results, and answer questions as we go. Let's begin with understanding the current implementation.
```

---

## Specific Scenario Prompts

### Bug Fix Investigation

```
I need to fix a bug: [describe symptoms]

**When it happens**: [Conditions that trigger it]
**Expected behavior**: [What should happen]
**Actual behavior**: [What happens instead]
**Error messages/logs**: [Paste any relevant errors]

Let's investigate this systematically:
1. First, help me reproduce and understand the root cause
2. Explore the relevant code to understand the flow
3. Identify why it's failing
4. Plan a fix that won't break anything else
5. Consider edge cases the fix needs to handle

I can run commands, check logs, and examine code. Where should we start looking?
```

### Feature Addition in Brownfield

```
I need to add a new feature to our existing [system/module]:

**Feature description**: [What it should do]
**User story**: As a [user], I want to [action] so that [benefit]
**Integration points**: This will need to work with [existing components]
**Constraints**: 
- Must maintain backward compatibility with [what]
- Performance requirement: [if any]
- Security considerations: [if any]

Our current codebase:
- **Architecture**: [Brief description]
- **Relevant modules**: [List main components]
- **Tech stack**: [Languages, frameworks]

Let's explore:
1. How the current system works
2. Where this feature fits in
3. What needs to change
4. What edge cases we need to handle
5. How to implement this incrementally

Guide me through the discovery process. What code should we examine first?
```

### Performance Optimization

```
We have a performance issue with [component/operation]:

**Current performance**: [Takes X seconds, uses Y memory, etc.]
**Target performance**: [Needs to be X seconds, etc.]
**Scale**: [Current load and expected growth]
**Symptoms**: [Slow response, high CPU, memory issues, etc.]

Let's investigate:
1. Profile the current implementation
2. Identify bottlenecks
3. Research optimization strategies
4. Plan incremental improvements
5. Define performance benchmarks

I can run profiling tools, check metrics, and examine code. Where should we start our investigation?
```

### Technical Debt Refactoring

```
I need to refactor [component/module] to address technical debt:

**Current problems**:
- [Problem 1: e.g., tight coupling]
- [Problem 2: e.g., poor test coverage]
- [Problem 3: e.g., outdated patterns]

**Goals**:
- [Goal 1: e.g., improve maintainability]
- [Goal 2: e.g., enable testing]
- [Goal 3: e.g., modernize approach]

**Constraints**:
- Must maintain existing functionality
- Cannot break [dependent systems]
- Need to deploy incrementally

Let's explore the code and plan a safe refactoring approach. Help me:
1. Understand the current structure
2. Identify all dependencies
3. Plan incremental refactoring steps
4. Ensure we don't break anything
5. Define tests for each step
```

---

## Discovery Driver Questions

Use these during the conversation to explore deeper:

### Code Understanding
- "Show me the main entry point for this feature"
- "Let me check how data flows through this component"
- "I'll look for existing tests to understand expected behavior"
- "Let me trace through a typical request/operation"

### Edge Case Discovery
- "What about when [unusual condition]?"
- "How does this handle [error scenario]?"
- "What if [resource] is unavailable?"
- "Is there a race condition if [concurrent action]?"

### Requirements Clarification
- "Should this also [related functionality]?"
- "What's the priority: [speed vs. accuracy vs. completeness]?"
- "Are there any regulatory/compliance requirements?"
- "What's the acceptable downtime/risk?"

### Technical Research
- "Are there existing libraries for this?"
- "What patterns does our codebase use for similar problems?"
- "What are other teams/products doing for this?"
- "What does the documentation/comments say?"

---

## Information to Gather

Be ready to provide:

### Code Snippets
```python
# Here's the current implementation:
def current_function():
    # ... paste relevant code
```

### File Structure
```
src/
├── module/
│   ├── component.py
│   ├── helper.py
│   └── tests/
│       └── test_component.py
```

### Test Results
```
$ pytest tests/test_feature.py -v
# ... paste output
```

### Logs/Errors
```
2024-01-15 10:30:45 ERROR: [paste error message]
Stack trace:
  File "app.py", line 123, in function
    ...
```

### Git History
```
$ git log --oneline -10 path/to/file.py
# ... paste relevant commits
```

### Dependencies
```
# From requirements.txt or package.json
library==1.2.3
another-lib>=2.0.0
```

---

## Iterative Refinement Prompts

As planning progresses, use these to refine:

### After Initial Exploration
```
Based on our code exploration, I found:
- [Key finding 1]
- [Key finding 2]
- [Potential issue]

Let's dig deeper into [specific area]. Here's the code for [component]...
```

### After Identifying Approach
```
Given what we've learned, you suggested [approach]. Let me understand:
1. What changes go where?
2. What's the order of implementation?
3. What could break?
4. How do we test each step?
```

### After Edge Case Discussion
```
We've identified these edge cases:
- [Edge case 1]
- [Edge case 2]

For [edge case 1], here's the current behavior: [show code/test].
How should we handle this in our solution?
```

### Ready to Finalize
```
Let's create the final .prove/TASK_PLAN.md. Based on our discussion:
- Requirements: [summarize]
- Approach: [summarize]
- Edge cases to handle: [list]
- Implementation steps: [outline]

Please create a detailed plan where each step is:
- Independently testable
- Clearly scoped
- Has verification criteria
- Includes specific file changes
```

---

## Output Request

End your planning session by requesting:

```
Now please create a comprehensive .prove/TASK_PLAN.md that captures everything we've discussed:
- Include all edge cases we discovered
- Break down into incremental, testable steps
- Each step should be independently verifiable
- Include specific files and changes
- Add rollback strategy
- Include test cases for each step

This plan will be used with the plan-step skill for detailed implementation planning, so make each step clear and actionable.
```