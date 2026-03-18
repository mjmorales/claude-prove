---
name: steward
description: Deep codebase quality audit with automated fixes. Runs the code-steward agent for line-by-line source code review, produces a findings document, then orchestrates parallel subagents to implement all fixes. Tests are reviewed separately after source changes land.
argument-hint: "[directory or module to scope the audit]"
---

# Code Steward: Deep Codebase Audit & Fix

You are orchestrating a comprehensive, quality-first codebase audit. This is NOT a quick review — go deep, take your time, be thorough. Every source file gets read. Every abstraction gets questioned. The goal is a codebase that is **delightful for humans** to read, extend, and maintain.

**Backwards compatibility is NOT required.** Make clean breaks. Rename things properly. Restructure modules. Delete dead code. If something should be different, make it different.

**Tests are NOT in scope for the audit.** Source code changes first — tests adapt second. Reviewing tests alongside source wastes audit cycles on code that will need rewriting anyway.

## Phase 0: Prerequisites

1. Read the project's `CLAUDE.md` for conventions and validation commands.
2. Check for `.prove.json` — if it exists, read it to learn:
   - Configured validators (use these for test/lint instead of guessing)
   - Project scopes and structure
3. Check for `.prove/TASK_PLAN.md` or `.prove/plans/` for task context.
4. Determine audit scope:
   - If `$ARGUMENTS` is provided, scope the audit to that directory/module
   - Otherwise, audit the full codebase

## Phase 1: Deep Audit via Code Steward

Launch the `code-steward` agent to perform a source-code-only audit. Give it this directive:

> Perform a complete, line-by-line audit of [scope]. Every source file. Every function. Every abstraction boundary. Do not rush.
>
> **SKIP all test files** — `test_*`, `*_test.*`, `tests/`, `__tests__/`, `*.spec.*`, `*.test.*`, test fixtures, and test utilities. Tests will be handled separately after source changes.
>
> Focus areas:
> 1. **Abstraction quality** — Are helpers, utilities, and shared modules properly extracted? Are abstractions at the right level?
> 2. **Design patterns** — Are patterns applied correctly and consistently? Are there anti-patterns from parallel agent work?
> 3. **Naming & readability** — Does every name communicate intent? Can a new developer understand this code without tribal knowledge?
> 4. **Code hygiene** — Dead code, stale comments, unused imports, TODO/FIXME, inconsistent formatting?
> 5. **Error handling** — Consistent strategy? Actionable messages? No swallowed errors?
> 6. **Performance** — N+1 queries, unnecessary allocations, missing batching, wrong data structures?
> 7. **Module boundaries** — Do files have single responsibilities? Are dependency relationships clean?
> 8. **Agent-generated anti-patterns** — Copy-paste drift, over-engineering, naming collisions, stale scaffolding, orphaned helpers, dependency bloat?
>
> Produce a comprehensive findings document. Do NOT fix anything yet — just document everything.

## Phase 2: Create Findings Document

After the audit completes, create structured findings at `.prove/steward/findings.md`:

```markdown
# Code Steward Audit Findings
**Date**: [today's date]
**Scope**: [full codebase or specific module]
**Files reviewed**: [count]
**Files skipped (tests)**: [count]

## Critical Issues
Issues that actively cause bugs, security problems, or severe maintainability debt.
[numbered list with file:line references]

## Structural Refactors
Module reorganization, abstraction extraction, dependency cleanup.
[numbered list with before/after descriptions]

## Naming & Readability
Renames, clarifications, comment improvements.
[numbered list]

## Code Hygiene
Dead code removal, import cleanup, formatting fixes.
[numbered list]

## Performance
Optimization opportunities.
[numbered list]

## Recommendations
Highest-leverage systemic improvements (linting rules, shared utilities, architectural guidelines).
[numbered list]
```

Also create `.prove/steward/fix-plan.md` that groups findings into **independent, parallelizable work packages** — each one a coherent set of changes that can be made by a single subagent without conflicting with other agents' work. Each work package should specify:
- A descriptive name
- The files it touches (source files only — no test files)
- The specific findings it addresses (by number from findings.md)
- Clear instructions for what to change

## Phase 3: Review with User

Present the findings summary and fix plan. Show:
- Total issues by category
- The proposed work packages
- Which packages can run in parallel vs. which have dependencies

Use `AskUserQuestion` with options:
- **"Approve all"** — proceed with all work packages
- **"Cherry-pick"** — let user select which packages to run
- **"Abort"** — stop here, keep findings for reference

## Phase 4: Orchestrate Parallel Fixes

After user approval, launch subagents in parallel to implement the fix plan. For each work package:

1. **Spawn an Agent** (subagent_type: `code-steward`) with a focused prompt that includes:
   - The specific findings to address
   - The files to modify (source only — no test files)
   - The instruction: "Backwards compatibility is NOT needed. Make clean breaks. Rename freely. Restructure as needed."
   - The instruction: "Do NOT modify test files. Tests will be updated separately."
   - The instruction: "If you discover additional issues while fixing, note them but stay focused on your assigned work package."

2. **Maximize parallelism** — launch all independent work packages simultaneously. Only serialize packages that touch overlapping files.

3. **Track progress** — update `.prove/steward/fix-plan.md` as each agent completes, noting what was done.

## Phase 5: Verification & Test Remediation

After all fix agents complete:

1. Run validators from `.prove.json` (lint phase first, then test phase).
2. Do a final scan for any conflicts between parallel agents' changes.
3. **If tests fail** (expected after source refactors), create a **test remediation section** in `.prove/steward/findings.md`:

```markdown
## Test Remediation Required
Tests that broke due to source refactors. These need updating to match the new source structure.

| Test file | Failure reason | Source change that caused it |
|---|---|---|
| `test_foo.py` | `ImportError: cannot import 'old_name'` | Renamed `old_name` → `new_name` in `module.py` |
| ... | ... | ... |
```

4. Generate a report at `.prove/reports/steward/report.md` with:
   - Summary of all changes made
   - Test remediation table (if any tests broke)
   - Remaining recommendations

5. Present the summary to the user. If tests broke, note them as a follow-up work package — do NOT attempt to fix tests during this workflow.

## Important Rules

- **Quality over speed.** This workflow can take as long as it needs.
- **Read every source file.** No sampling. No skipping. This is a comprehensive audit.
- **Skip all test files.** Source first, tests adapt second.
- **Clean breaks over backwards compatibility.** If a rename or restructure is the right call, do it. Update all source references.
- **Preserve behavior unless fixing a bug.** Refactors should not change what the code does, only how it's organized.
- **Use `.prove.json` validators.** Never guess test/lint commands.
- **Document everything.** The findings doc is a living artifact that tracks what was found and what was done about it.
- **Steward artifacts live in `.prove/steward/`** and reports in `.prove/reports/steward/`. Do not create top-level directories.
