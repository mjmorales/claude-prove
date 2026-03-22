---
name: steward
description: Deep codebase quality audit with automated fixes. Runs the code-steward agent for line-by-line source code review, produces a findings document, then orchestrates parallel subagents to implement all fixes. Tests are reviewed separately after source changes land.
argument-hint: "[directory or module to scope the audit]"
---

# Code Steward: Deep Codebase Audit & Fix

Orchestrate a comprehensive codebase audit across every source file. The goal: a codebase that is clear to read, easy to extend, and free of accumulated agent-workflow debt.

**Backwards compatibility is NOT required.** Make clean breaks — rename, restructure, delete.

**Test files are excluded from all phases.** Source changes first; tests adapt in a separate follow-up.

## Phase 0: Prerequisites

1. Read the project's `CLAUDE.md` for conventions and validation commands.
2. Read `.prove.json` if it exists — use its configured validators and scopes. Never guess test/lint commands.
3. Check `.prove/TASK_PLAN.md` or `.prove/plans/` for task context.
4. Determine audit scope: use `$ARGUMENTS` if provided, otherwise audit the full codebase.

## Phase 1: Deep Audit via Code Steward

Launch the `code-steward` agent with this directive:

> Audit [scope] in document-only mode — do NOT fix anything yet.
> Produce a comprehensive findings list organized by severity (Critical, Important, Improvement).
> Include file:line references for every finding.

The agent's own prompt defines the audit methodology, focus areas, and test-exclusion rules. Do NOT restate them here — pass only scope and output expectations.

## Phase 2: Create Findings Document

After the audit completes, create `.prove/steward/findings.md`:

```markdown
# Code Steward Audit Findings
**Date**: [today's date]
**Scope**: [full codebase or specific module]
**Files reviewed**: [count]

## Critical Issues
[numbered list with file:line references]

## Structural Refactors
[numbered list with before/after descriptions]

## Naming & Readability
[numbered list]

## Code Hygiene
[numbered list]

## Performance
[numbered list]

## Systemic Recommendations
[numbered list — linting rules, shared utilities, architectural guidelines]
```

Also create `.prove/steward/fix-plan.md` grouping findings into **independent, parallelizable work packages**. Each work package specifies:
- Descriptive name
- Files it touches
- Finding numbers it addresses (from findings.md)
- What to change

## Phase 3: Review with User

Present the findings summary and fix plan:
- Issue counts by category
- Work packages with parallelism/dependency annotations

Use `AskUserQuestion` with options:
- **"Approve all"** — proceed with all work packages
- **"Cherry-pick"** — user selects which packages to run
- **"Abort"** — keep findings for reference, stop here

## Phase 4: Orchestrate Parallel Fixes

For each approved work package, spawn an Agent (subagent_type: `code-steward`) with a prompt containing only what the agent cannot infer from its own definition:

- The specific finding numbers and file list for this work package
- "Document-then-fix mode: implement the fixes described in these findings."
- "If you discover additional issues while fixing, note them in your report but stay focused on your assigned findings."

The agent's own prompt already covers: test exclusion, clean-break policy, validation, and refactoring principles. Do NOT repeat those.

**Parallelism**: launch all independent work packages simultaneously. Serialize only packages with overlapping files.

**Progress tracking**: update `.prove/steward/fix-plan.md` as each agent completes.

## Phase 5: Verification & Test Remediation

After all fix agents complete:

1. Run `.prove.json` validators: lint first, then tests.
2. Scan for conflicts between parallel agents' changes (duplicate edits, import collisions).
3. If tests fail, append a remediation table to `.prove/steward/findings.md`:

| Test file | Failure | Source change that caused it |
|---|---|---|
| `test_foo.py` | `ImportError: cannot import 'old_name'` | Renamed `old_name` -> `new_name` in `module.py` |

4. Generate `.prove/reports/steward/report.md` with: changes summary, test remediation table (if any), remaining recommendations.
5. Present the summary to the user. Flag broken tests as a follow-up work package — do NOT fix tests in this workflow.

## Constraints

- **Behavior preservation.** Refactors must not change what the code does. Bug fixes are separate and explicitly called out.
- **All artifacts in `.prove/steward/`**, reports in `.prove/reports/steward/`. No top-level directories.
