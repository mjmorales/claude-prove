---
name: auto-steward
description: Iterative code quality audit that loops until clean. Runs the code-steward agent in a bounded fix-audit cycle — first pass gets human approval, subsequent passes auto-fix until the audit returns clean or the iteration cap is hit.
argument-hint: "[--full] [--max-passes N] [directory or module]"
---

# Auto Steward: Iterative Audit-Fix Loop

You are orchestrating an **iterative** code quality audit. Unlike the one-shot `/prove:steward`, this workflow runs the steward in a loop — fixing issues, re-auditing, and fixing again until the codebase comes back clean or the iteration cap is reached.

**Backwards compatibility is NOT required.** Clean breaks. Rename freely. Delete dead code.

**Tests are NOT in scope.** Source code changes first — tests adapt second.

## Phase 0: Prerequisites & Configuration

1. Read the project's `CLAUDE.md` for conventions and validation commands.
2. Check for `.prove.json` — read validators and project structure.
3. Check for `.prove/TASK_PLAN.md` or `.prove/plans/` for task context.

4. **Parse arguments** from `$ARGUMENTS`:
   - `--full` → Audit the full codebase on pass 1 (default: changed files only via `git diff main...HEAD --name-only`)
   - `--max-passes N` → Set iteration cap (default: 3)
   - Any remaining text → scope to that directory/module
   - If no `--full` flag and no directory argument, default to changed-files-only scope

5. **Initialize tracking** — create `.prove/steward/auto-report.md`:

```markdown
# Auto Steward Report
**Date**: [today's date]
**Scope**: [full codebase | changed files | specific directory]
**Max passes**: [N]

## Pass Log
```

## Phase 1: Initial Audit (Human-Approved)

This pass follows the same pattern as `/prove:steward` — full audit with human review.

### 1a. Determine Audit Scope

- **If `--full` or directory specified**: Use that scope
- **If changed-files-only (default)**:
  - Run `git diff main...HEAD --name-only` to get changed files
  - Filter out test files (`test_*`, `*_test.*`, `tests/`, `__tests__/`, `*.spec.*`, `*.test.*`)
  - If no source files remain, inform the user and stop

### 1b. Launch Code Steward Agent

Launch the `code-steward` agent with this directive:

> Perform a complete, line-by-line audit of [scope]. Every source file in scope. Every function. Every abstraction boundary.
>
> **SKIP all test files** — `test_*`, `*_test.*`, `tests/`, `__tests__/`, `*.spec.*`, `*.test.*`, test fixtures, test utilities.
>
> Focus areas: abstraction quality, design patterns, naming & readability, code hygiene, error handling, performance, module boundaries, agent-generated anti-patterns (copy-paste drift, over-engineering, naming collisions, stale scaffolding, orphaned helpers).
>
> Produce a comprehensive findings document. Do NOT fix anything yet — just document everything.

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

Present the findings summary and fix plan. Use `AskUserQuestion` with options:
- **"Approve all"** — proceed with all work packages
- **"Cherry-pick"** — let user select which packages to run
- **"Abort"** — stop here, keep findings for reference

If user aborts, update the auto-report with "Aborted by user after pass 1" and stop.

### 1e. Apply Fixes

Launch parallel `code-steward` subagents to implement approved work packages:
- Each agent gets its specific findings, file list, and clear change instructions
- Instruction: "Backwards compatibility NOT needed. Clean breaks. No test files."
- Maximize parallelism — only serialize packages that touch overlapping files

### 1f. Run Validators

Run validators from `.prove.json` (lint first, then tests). Note any failures but do NOT stop the loop — test failures from source refactors are expected.

### 1g. Record Pass 1

Append to `.prove/steward/auto-report.md`:

```markdown
### Pass 1
- **Files audited**: [count]
- **Issues found**: [count] (Critical: X, Major: X, Minor: X)
- **Issues fixed**: [count]
- **Files modified**: [list]
- **Validator status**: lint [pass/fail], tests [pass/fail]
```

Track the list of files modified in this pass — this becomes the scope for pass 2.

## Phase 2+: Autonomous Re-Audit Loop

**This phase runs without human approval.** The user approved the initial audit direction in Phase 1 — subsequent passes clean up residual issues from the fixes.

Repeat the following until **audit returns clean** or **iteration cap is hit**:

### 2a. Determine Re-Audit Scope

Scope the re-audit to **only the files modified in the previous pass**. Filter out test files as always.

If no source files were modified in the previous pass (all changes were test-only or config), the loop is done.

### 2b. Re-Audit

Launch the `code-steward` agent with a focused directive:

> Re-audit ONLY these source files that were modified in the previous fix pass: [list files].
>
> These files were just refactored. Check for:
> 1. Issues introduced by the refactoring itself (broken imports, inconsistent naming with surrounding code, incomplete renames)
> 2. Quality issues that were masked by the original problems and are now visible
> 3. Integration issues — do these files still work correctly with their callers/dependencies?
>
> **SKIP all test files.** Read surrounding source files for context but only produce findings against the listed files.
>
> Produce findings. Do NOT fix anything yet.

### 2c. Evaluate Findings

If the audit returns **no findings** → the loop converges. Skip to Phase 3.

If findings exist:
- Create/update `.prove/steward/findings-pass-N.md` with the new findings
- Create a fix plan for this pass
- **Auto-approve all findings** — no human gate
- Launch fix subagents as in Phase 1e
- Run validators
- Record the pass in auto-report

### 2d. Record Pass N

Append to `.prove/steward/auto-report.md`:

```markdown
### Pass [N]
- **Files re-audited**: [count]
- **New issues found**: [count] (Critical: X, Major: X, Minor: X)
- **Issues fixed**: [count]
- **Files modified**: [list]
- **Validator status**: lint [pass/fail], tests [pass/fail]
```

### 2e. Check Iteration Cap

If pass count equals max-passes and findings still exist:
- Record "Cap reached — issues remain" in the auto-report
- Proceed to Phase 3 with remaining issues noted

## Phase 3: Final Report & Summary

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

Show a concise summary:
- Convergence status (clean vs. cap hit)
- Per-pass breakdown (issues found → fixed)
- Test remediation table if applicable
- Any remaining issues that need manual attention

If the loop converged clean, celebrate briefly: "Codebase audits clean after N passes."

If cap was hit, note what remains and suggest running again or addressing manually.

## Important Rules

- **First pass only gets human approval.** Subsequent passes are autonomous.
- **Re-runs scope to modified files only.** Do not re-audit the entire codebase on every pass.
- **Respect the iteration cap.** Never exceed max-passes. If issues persist, report them and stop.
- **Track everything.** The auto-report is the audit trail — every pass, every finding, every fix.
- **Skip all test files.** Source first, tests adapt second.
- **Use `.prove.json` validators.** Never guess test/lint commands.
- **Clean breaks over backwards compatibility.** Renames, restructures, deletions are all fine.
- **Steward artifacts live in `.prove/steward/`** and reports in `.prove/reports/steward/`.
- **Do not loop on validator failures.** Test/lint failures are noted but don't trigger additional steward passes. The loop is driven by *audit findings*, not validator output.
