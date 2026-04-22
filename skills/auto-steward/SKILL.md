---
name: auto-steward
description: Iterative code quality audit that loops until clean. Runs the code-steward agent in a bounded fix-audit cycle — first pass gets human approval, subsequent passes auto-fix until the audit returns clean or the iteration cap is hit.
argument-hint: "[--full] [--max-passes N] [directory or module]"
---

# Auto Steward: Iterative Audit-Fix Loop

Audit, fix, re-audit modified files, repeat until clean or capped.

## Constraints (all phases)

- Clean breaks only -- rename, restructure, delete freely.
- Skip test files (`test_*`, `*_test.*`, `tests/`, `__tests__/`, `*.spec.*`, `*.test.*`, fixtures). Source first, tests adapt second.
- Use `.claude/.prove.json` validators. Do not guess commands.
- Artifacts in `.prove/steward/`, reports in `.prove/reports/steward/`.
- Loop on **audit findings**, not validator failures. Test/lint failures are noted, never trigger extra passes.
- Stop at max-passes. Report remaining issues.

## Phase 0: Prerequisites & Configuration

1. Read `CLAUDE.md` for conventions, `.claude/.prove.json` for validators/structure.
2. Check active run's `plan.json` (`scripts/prove-run show plan`) or `.prove/plans/` for task context.
3. **Parse `$ARGUMENTS`**:
   - `--full` -- full codebase on pass 1 (default: changed files via `git diff main...HEAD --name-only`)
   - `--max-passes N` -- iteration cap (default: 3)
   - Remaining text -- scope to that directory/module
4. **Initialize** `.prove/steward/auto-report.md`:

```markdown
# Auto Steward Report
**Date**: [today]  **Scope**: [full | changed files | directory]  **Max passes**: [N]

## Pass Log
```

## Phase 1: Initial Audit (Human-Approved)

### 1a. Determine Scope

- `--full` or directory: use that scope
- Default: `git diff main...HEAD --name-only`, filter test files. No source files remaining = inform user and stop.

### 1b. PCD Audit Pipeline

Run the steward PCD pipeline on the determined scope. This is identical to the pipeline in `skills/steward/SKILL.md` Phase 1 (rounds 0a through synthesis + fallback). Produces `.prove/steward/findings.md` and `.prove/steward/fix-plan.md`.

### 1c. Findings Document (fallback only)

Skip if PCD produced both files. Otherwise create `.prove/steward/findings.md` (standard steward format: Critical Issues, Structural Refactors, Naming & Readability, Code Hygiene, Performance, Recommendations -- numbered with file:line refs) and `.prove/steward/fix-plan.md` (independent, parallelizable work packages).

### 1d. Human Review

Present findings summary and fix plan. AskUserQuestion: "Approve all" / "Cherry-pick" / "Abort".

On abort: update auto-report, stop.

### 1e. Apply Fixes

Launch parallel `code-steward` subagents per approved work package (findings, file list, change instructions). Serialize only packages with overlapping files.

### 1f. Validate & Record Pass

Run `.claude/.prove.json` validators (lint, then tests). Note failures but do not stop the loop.

Append to auto-report:

```markdown
### Pass [N]
- **Files audited**: [count]
- **Issues found**: [count] (Critical: X, Major: X, Minor: X)
- **Issues fixed**: [count]
- **Files modified**: [list]
- **Validator status**: lint [pass/fail], tests [pass/fail]
```

Track modified files -- they scope the next pass.

## Phase 2+: Autonomous Re-Audit Loop

No human approval. The user approved direction in Phase 1.

Repeat until clean or capped:

### 2a. Scope to Modified Files

Re-audit only files modified in the previous pass (excluding tests). No modified source files = loop done.

### 2b. Re-Audit

For **>= 5 files**: run the full PCD pipeline scoped to modified files:
```bash
prove pcd map --project-root "$PROJECT_ROOT" --scope <comma-separated files>
```
Then rounds 1-3 as in Phase 1b.

For **< 5 files**: skip PCD, launch `code-steward` directly:

> Re-audit ONLY these files modified in the previous pass: [list].
> Check for: (1) issues introduced by refactoring, (2) quality issues previously masked, (3) integration issues with callers/dependencies.
> Produce findings. Do not fix yet.

### 2c. Evaluate & Fix

No findings = loop converges, skip to Phase 3.

Findings exist: create `.prove/steward/findings-pass-N.md`, auto-approve, launch fix subagents, validate and record pass (same template as 1f).

### 2d. Check Cap

At max-passes with remaining findings: record "Cap reached" in auto-report, proceed to Phase 3.

## Phase 3: Final Report

### 3a. Finalize Auto-Report

```markdown
## Summary
- **Total passes**: [N]
- **Outcome**: [Converged clean | Cap reached with N remaining issues]
- **Total issues found/fixed**: [sums]
- **Files modified**: [deduplicated]

## Test Remediation Required
| Test file | Failure reason | Source change that caused it |
|---|---|---|

## Remaining Issues (if cap reached)
[Unfixed findings from final pass]
```

### 3b. Present to User

Convergence status, per-pass breakdown, test remediation if applicable, remaining issues. If capped, suggest rerunning or manual fixes.
