---
name: auto-steward
description: Iterative code quality audit that loops until clean. Runs the code-steward agent in a bounded fix-audit cycle — first pass gets human approval, subsequent passes auto-fix until the audit returns clean or the iteration cap is hit.
argument-hint: "[--full] [--max-passes N] [directory or module]"
---

# Auto Steward: Iterative Audit-Fix Loop

Orchestrate an iterative code quality audit. Run the `code-steward` agent in a loop — audit, fix, re-audit modified files, repeat until clean or capped.

## Constraints (apply to ALL phases)

- **Clean breaks only.** Backwards compatibility is NOT required. Rename, restructure, delete freely.
- **Skip all test files.** `test_*`, `*_test.*`, `tests/`, `__tests__/`, `*.spec.*`, `*.test.*`, test fixtures. Source first — tests adapt second.
- **Use `.prove.json` validators.** Never guess test/lint commands.
- **Artifacts in `.prove/steward/`**, reports in `.prove/reports/steward/`.
- **Loop on audit findings, NOT validator failures.** Test/lint failures are noted but never trigger additional passes.
- **Never exceed max-passes.** If issues persist at cap, report them and stop.

## Phase 0: Prerequisites & Configuration

1. Read the project's `CLAUDE.md` for conventions and validation commands.
2. Read `.prove.json` for validators and project structure.
3. Check `.prove/TASK_PLAN.md` or `.prove/plans/` for task context.

4. **Parse arguments** from `$ARGUMENTS`:
   - `--full` -- Audit full codebase on pass 1 (default: changed files only via `git diff main...HEAD --name-only`)
   - `--max-passes N` -- Set iteration cap (default: 3)
   - Remaining text -- scope to that directory/module
   - No flags and no directory argument -- default to changed-files-only

5. **Initialize tracking** -- create `.prove/steward/auto-report.md`:

```markdown
# Auto Steward Report
**Date**: [today's date]
**Scope**: [full codebase | changed files | specific directory]
**Max passes**: [N]

## Pass Log
```

## Phase 1: Initial Audit (Human-Approved)

### 1a. Determine Audit Scope

- **`--full` or directory specified**: Use that scope
- **Changed-files-only (default)**:
  - Run `git diff main...HEAD --name-only`, filter out test files
  - If no source files remain, inform the user and stop

### 1b. Launch Code Steward Agent

Launch `code-steward` in document-only mode:

> Audit [scope] — do NOT fix anything yet. Produce a comprehensive findings list organized by severity (Critical, Important, Improvement) with file:line references for every finding.

The agent's own prompt defines audit methodology, focus areas, and test-exclusion rules. Do NOT restate them -- pass only scope and output expectations.

### 1c. Create Findings Document

Create `.prove/steward/findings.md` with the standard steward findings format:
- Critical Issues (numbered, with file:line references)
- Structural Refactors
- Naming & Readability
- Code Hygiene
- Performance
- Recommendations

Also create `.prove/steward/fix-plan.md` grouping findings into independent, parallelizable work packages.

### 1d. Human Review

Present findings summary and fix plan. Use `AskUserQuestion` with options:
- **"Approve all"** -- proceed with all work packages
- **"Cherry-pick"** -- user selects which packages to run
- **"Abort"** -- keep findings for reference, stop here

If user aborts, update auto-report with "Aborted by user after pass 1" and stop.

### 1e. Apply Fixes

Launch parallel `code-steward` subagents for approved work packages. Each agent gets its specific findings, file list, and change instructions. Maximize parallelism -- only serialize packages that touch overlapping files.

### 1f. Run Validators & Record Pass

Run `.prove.json` validators (lint first, then tests). Note failures but do NOT stop the loop.

Append pass record to `.prove/steward/auto-report.md`:

```markdown
### Pass [N]
- **Files audited**: [count]
- **Issues found**: [count] (Critical: X, Major: X, Minor: X)
- **Issues fixed**: [count]
- **Files modified**: [list]
- **Validator status**: lint [pass/fail], tests [pass/fail]
```

Track files modified in this pass -- they become the scope for the next pass.

## Phase 2+: Autonomous Re-Audit Loop

**No human approval.** The user approved audit direction in Phase 1 -- subsequent passes clean up residual issues.

Repeat until audit returns clean OR iteration cap is hit:

### 2a. Scope to Modified Files

Re-audit **only files modified in the previous pass** (excluding test files). If no source files were modified, the loop is done.

### 2b. Re-Audit

Launch `code-steward` with a post-refactor focus:

> Re-audit ONLY these files modified in the previous pass: [list files].
>
> These files were just refactored. Check for:
> 1. Issues introduced by refactoring (broken imports, inconsistent naming, incomplete renames)
> 2. Quality issues previously masked by the original problems
> 3. Integration issues with callers/dependencies
>
> Produce findings. Do NOT fix anything yet.

### 2c. Evaluate & Fix

If **no findings** -- loop converges. Skip to Phase 3.

If findings exist:
- Create `.prove/steward/findings-pass-N.md`
- Auto-approve all findings (no human gate)
- Launch fix subagents as in Phase 1e
- Run validators and record pass using the same template from Phase 1f

### 2d. Check Iteration Cap

If pass count equals max-passes and findings remain:
- Record "Cap reached -- issues remain" in auto-report
- Proceed to Phase 3

## Phase 3: Final Report

### 3a. Finalize Auto-Report

Complete `.prove/steward/auto-report.md`:

```markdown
## Summary
- **Total passes**: [N]
- **Outcome**: [Converged clean | Cap reached with N remaining issues]
- **Total issues found**: [sum across all passes]
- **Total issues fixed**: [sum across all passes]
- **Total files modified**: [deduplicated list]

## Test Remediation Required
[If any tests broke, list them with the source change that caused it]

| Test file | Failure reason | Source change that caused it |
|---|---|---|
| ... | ... | ... |

## Remaining Issues (if cap reached)
[List any unfixed findings from the final pass]
```

### 3b. Present to User

Show a concise summary: convergence status, per-pass breakdown (found/fixed), test remediation table if applicable, remaining issues needing manual attention. If cap was hit, suggest running again or addressing manually.
