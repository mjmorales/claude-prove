---
name: steward
description: Code quality audit and fix orchestration. Three modes — session review of branch diff (default), full deep audit with PCD pipeline + parallel fixes, iterative fix-audit loop bounded by max-passes. Invoked by /prove:steward, /prove:steward-review, /prove:auto-steward, steward, auto-steward, steward review, code audit, code quality, clean up the code, fix code quality, refactor for clarity.
argument-hint: "[--review | --full | --auto] [--max-passes N] [scope]"
---

# Code Steward

Audit source files for clarity, extensibility, and agent-workflow debt. Clean breaks: rename, restructure, delete. Tests excluded from audit scope -- source first, tests adapt after.

All modes share: `.claude/.prove.json` validators (never guess commands), artifacts in `.prove/steward/`, reports in `.prove/reports/steward/`, task context from active run's `plan.json` (`scripts/prove-run show plan`) or `.prove/plans/`. Link findings to scrum task IDs when `plan.json` contains `task_id`.

## Mode Dispatch

Parse `$ARGUMENTS` left-to-right:

- `--review` -> **Review mode** (default if no mode flag)
- `--full` -> **Full mode**
- `--auto` -> **Auto mode**
- `--max-passes N` -> auto-mode iteration cap (default 3)
- Remaining tokens -> scope (directory, module path, or base branch for review mode)

Unknown flags: halt and ask the user to restate intent (which mode, which scope). No mode flag: default to Review mode.

## Phase 0 (All Modes): Prerequisites

1. Read `CLAUDE.md` for conventions.
2. Read `.claude/.prove.json` for validators/scopes.
3. Check `plan.json` for task context and `task_id`.
4. Resolve scope from `$ARGUMENTS`.

## Review Mode (default)

Session-scoped audit of current branch diff. Read-only by default; fix only on approval.

### R1. Scope

- Base branch: `$ARGUMENTS` scope token if supplied, else `main`. Verify with `git rev-parse --verify <base>`. Fall back to `master`, then halt.
- `git diff <base>...HEAD --name-only` and `--stat`.
- Filter tests: `test_*`, `*_test.*`, `*.spec.*`, `*.test.*`, `tests/`, `__tests__/`, fixtures.
- No committed diff? Check `git diff --name-only` and `git diff --cached --name-only`. Same filter.
- No source files after filter: inform "Only test files changed -- nothing to review" and stop.

### R2. Audit

- **< 5 files**: launch `code-steward` directly:
  > Audit ONLY these source files: [list]. Read-only -- produce findings, do NOT fix. Check cross-file integration, consistency, duplication.
- **>= 5 files**: run [PCD Pipeline](#pcd-pipeline) scoped to changed files. Synthesizer output path: `.prove/steward/session-review.md`.

### R3. Findings Document

Write `.prove/steward/session-review.md`:

```markdown
# Session Review
**Date**: [today] | **Branch**: [branch] | **Base**: [base]
**Source files reviewed**: [N] | **Test files skipped**: [N]
**Task**: [plan task_id or branch context]

## Must Fix
[numbered, file:line -- address before merging]

## Should Fix
[numbered -- quality worth doing now]

## Nits
[numbered -- minor polish]

## Fix Plan
[1-3 packages; note parallelism]
```

### R4. Approval Gate

Summarize counts and packages. `AskUserQuestion` header "Review":
- **Fix all** -- apply every package
- **Must-fix only** -- address Must Fix items
- **Skip** -- keep findings, no fixes

### R5. Apply

- 1-2 packages: `code-steward` agent directly.
- 3+ independent packages: parallel `code-steward` agents with explicit file lists.
- New issues mid-fix: note in findings, stay on approved scope.

### R6. Verify

Run `.claude/.prove.json` validators (lint, then tests). On test failure, append to session-review.md:

```markdown
## Test Remediation Required
| Test file | Failure | Source change that caused it |
|---|---|---|
```

`git diff --stat`, then one-paragraph summary. Flag broader findings for `--full`.

**Constraint**: modify only in-scope files. Read unchanged files for patterns only. Exception: renames requiring reference updates.

## Full Mode

Deep audit of full scope with PCD pipeline, parallel fix orchestration, separate test remediation phase.

### F1. Scope

Use `$ARGUMENTS` scope token if provided; else full codebase.

### F2. PCD Pipeline

Run [PCD Pipeline](#pcd-pipeline). Synthesizer outputs: `.prove/steward/findings.md` + `.prove/steward/fix-plan.md`.

### F3. Fallback Findings (only if PCD failed)

Create `.prove/steward/findings.md`:

```markdown
# Code Steward Audit Findings
**Date**: [today] | **Scope**: [scope] | **Files**: [N]

## Critical Issues
## Structural Refactors
## Naming & Readability
## Code Hygiene
## Performance
## Systemic Recommendations
```

Each section: numbered, file:line refs, before/after for refactors.

Create `.prove/steward/fix-plan.md` grouping findings into parallelizable work packages (name, files, finding numbers, changes).

### F4. Approval Gate

Present counts per category and fix plan with dependency annotations. `AskUserQuestion` header "Approval":
- **Approve all** -- execute every package
- **Cherry-pick** -- select packages
- **Abort** -- record and stop

### F5. Parallel Fixes

Spawn `code-steward` agents per approved package. Prompt includes only what agent cannot infer:
- Finding numbers and file list
- "Document-then-fix mode: implement these findings."
- "Note additional issues discovered, but stay focused on assigned findings."

Launch independent packages simultaneously. Serialize only overlapping-file packages. Update `fix-plan.md` as agents complete.

### F6. Verify & Remediate

1. Run validators (lint, then tests).
2. Scan for parallel-agent conflicts (duplicate edits, import collisions).
3. On test failures, append remediation table to findings.
4. Generate `.prove/reports/steward/report.md`: changes summary, remediation table, remaining recommendations.
5. Present summary. Flag broken tests as follow-up -- do not fix tests here.

**Constraints**: refactors preserve behavior. If a behavior-changing fix is required, do not bundle it — surface it as a separate finding and call it out explicitly in the report.

## Auto Mode

Iterative audit -> fix -> re-audit, human-approved on pass 1 only, bounded by `--max-passes N`.

### A0. Init

Parse `--full` (full codebase on pass 1; default = `git diff main...HEAD --name-only`), `--max-passes N` (default 3), scope.

Initialize `.prove/steward/auto-report.md`:

```markdown
# Auto Steward Report
**Date**: [today] | **Scope**: [full | diff | dir] | **Max passes**: [N]

## Pass Log
```

### A1. Pass 1 (Human-Approved)

1. Scope: `--full`/dir if supplied, else `git diff main...HEAD --name-only` minus tests. None remaining -> inform and stop.
2. Run [PCD Pipeline](#pcd-pipeline). Outputs: `findings.md` + `fix-plan.md`. Fallback per F3 if PCD fails.
3. `AskUserQuestion` header "Approval": **Approve all** / **Cherry-pick** / **Abort**. Abort -> update report, stop.
4. Launch parallel `code-steward` subagents per approved package (serialize overlapping files).
5. Run validators. Note failures; do not halt the loop.
6. Append Pass N block:

```markdown
### Pass [N]
- **Files audited**: [N]
- **Issues found**: [N] (Critical: X, Major: X, Minor: X)
- **Issues fixed**: [N]
- **Files modified**: [list]
- **Validator status**: lint [pass/fail], tests [pass/fail]
```

Track modified files for next pass scope.

### A2. Passes 2..N (Autonomous)

No approval. Loop until clean or capped:

1. **Scope**: files modified last pass, minus tests. None -> converged, goto A3.
2. **Re-audit**:
   - **>= 5 files**: [PCD Pipeline](#pcd-pipeline) scoped to modified files.
   - **< 5 files**: skip PCD, launch `code-steward` directly:
     > Re-audit ONLY these files modified last pass: [list].
     > Check: (1) refactor-introduced issues, (2) previously masked quality issues, (3) caller/dep integration.
     > Produce findings. Do not fix yet.
3. **Evaluate**: no findings -> converged, goto A3.
4. **Fix**: write `.prove/steward/findings-pass-N.md`, auto-approve, launch fix subagents, validate, append Pass N block.
5. **Cap**: at `max-passes` with remaining findings, record "Cap reached" and goto A3.

**Loop invariant**: iterate on audit findings, not validator failures. Test/lint failures are logged, never trigger extra passes.

### A3. Final Report

Append to `auto-report.md`:

```markdown
## Summary
- **Total passes**: [N]
- **Outcome**: [Converged clean | Cap reached with N remaining]
- **Total found/fixed**: [sums]
- **Files modified**: [dedup list]

## Test Remediation Required
| Test file | Failure | Source change that caused it |
|---|---|---|

## Remaining Issues (if capped)
[unfixed findings from final pass]
```

Present: convergence status, per-pass breakdown, test remediation, remaining issues. If capped, suggest rerun or manual fixes.

## PCD Pipeline

Progressive Context Distillation -- multi-round pipeline producing structured findings with risk-targeted depth. Shared by Review (>= 5 files), Full (always), Auto (pass 1 always; pass N >= 5 files).

### 1a. Structural Map

```bash
claude-prove pcd map --project-root "$PROJECT_ROOT" [--scope <scope>]
```

Produces `.prove/steward/pcd/structural-map.json` (file metadata, dependency edges, clusters).

### 1b. Semantic Annotation

Skip if < 20 files. Launch `pcd-annotator`:
> Annotate `.prove/steward/pcd/structural-map.json` with semantic labels and module-purpose per cluster. Write back.

### 1c. Parallel Triage (Sonnet)

Per cluster, launch `pcd-triager` (`run_in_background: true`):
> Triage files: [list]. Context: [cluster metadata, dependency edges].
> Write triage cards to `.prove/steward/pcd/triage-batch-{cluster_id}.json`.

Merge into `.prove/steward/pcd/triage-manifest.json`:

```json
{
  "version": 1,
  "stats": { "files_reviewed": N, "high_risk": N, "medium_risk": N, "low_risk": N, "total_questions": N },
  "cards": [...],
  "question_index": [...]
}
```

### 1d. Collapse

```bash
claude-prove pcd collapse --project-root "$PROJECT_ROOT"
```

Compresses low-risk cards -> `.prove/steward/pcd/collapsed-manifest.json`.

### 1e. Deep Review (Opus, max 3 concurrent)

```bash
claude-prove pcd batch --project-root "$PROJECT_ROOT"
```

Per batch in `batch-definitions.json`, launch `pcd-reviewer` (`run_in_background: true`):
> Review batch {batch_id}. Files: [list]. Triage: [cards]. Routed questions: [present each before referenced file]. Cluster context: [metadata].
> Write findings to `.prove/steward/pcd/findings-batch-{batch_id}.json`.

### 1f. Synthesis

Launch `pcd-synthesizer`:
> Synthesize artifacts in `.prove/steward/pcd/`: structural-map.json, collapsed-manifest.json, findings-batch-*.json.
> Do not read source directly.
> Produce target findings file (see mode) and `.prove/steward/fix-plan.md` (parallelizable work packages).

Synthesizer findings target by mode: Review -> `session-review.md`; Full -> `findings.md`; Auto pass 1 -> `findings.md`, pass N -> `findings-pass-N.md`.

### 1g. Fallback

Any critical PCD round fails -> single-pass `code-steward` in document-only mode. Log in `.prove/steward/pcd/pipeline-status.json`.
