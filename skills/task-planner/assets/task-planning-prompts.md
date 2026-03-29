# Task Planning Prompt Templates

## Master Prompt

```
I need to plan a [bug fix/new feature/refactoring] for our existing codebase.

## Task Overview
**What**: [Describe the task/bug/feature]
**Why**: [Business reason or problem it solves]
**Current state**: [What's happening now]

## Context
**Affected area**: [Component/module/service]
**Tech stack**: [Language, framework, key libraries]
**Related files** (if known): [List files]

## Planning Goals
1. Understand the current implementation through code exploration
2. Identify edge cases and potential issues
3. Research approaches with trade-offs
4. Create an incremental implementation plan with verification steps
```

---

## Scenario Prompts

### Bug Fix

```
Bug: [describe symptoms]

**Trigger**: [Conditions]
**Expected**: [Correct behavior]
**Actual**: [Current behavior]
**Errors/logs**: [Paste relevant output]

Investigate: reproduce, find root cause, plan a fix that handles edge cases.
```

### Feature Addition (Brownfield)

```
New feature for [system/module]:

**Feature**: [What it should do]
**User story**: As a [user], I want to [action] so that [benefit]
**Integration points**: [Existing components]
**Constraints**: backward compatibility with [what], performance: [req], security: [req]

**Architecture**: [Brief description]
**Relevant modules**: [List]
**Tech stack**: [Languages, frameworks]

Explore current system, find where this fits, plan incremental implementation.
```

### Performance Optimization

```
Performance issue with [component/operation]:

**Current**: [Takes X seconds, uses Y memory]
**Target**: [Needs to be X seconds]
**Scale**: [Current load and growth]
**Symptoms**: [Slow response, high CPU, memory issues]

Profile, identify bottlenecks, plan incremental improvements with benchmarks.
```

### Technical Debt Refactoring

```
Refactor [component/module]:

**Problems**: [tight coupling, poor test coverage, outdated patterns]
**Goals**: [improve maintainability, enable testing, modernize]
**Constraints**: maintain existing functionality, cannot break [dependents], deploy incrementally

Explore structure, map dependencies, plan safe incremental refactoring with tests per step.
```

---

## Iterative Refinement Prompts

### After Exploration
```
Based on code exploration:
- [Key finding 1]
- [Key finding 2]
- [Potential issue]

Let's dig deeper into [specific area]. Here's the code for [component]...
```

### After Identifying Approach
```
Given [approach], clarify:
1. What changes go where?
2. Implementation order?
3. What could break?
4. How to test each step?
```

### After Edge Case Discussion
```
Edge cases identified:
- [Edge case 1]
- [Edge case 2]

For [edge case 1], current behavior: [show code/test].
How should we handle this?
```

### Finalize Plan
```
Create .prove/TASK_PLAN.md from our discussion:
- Requirements: [summarize]
- Approach: [summarize]
- Edge cases: [list]
- Steps: [outline]

Each step must be independently testable, clearly scoped, with verification criteria and specific file changes.
```
