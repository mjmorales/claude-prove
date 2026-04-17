---
name: steward-review
description: Session-scoped code quality review. Audits only source files changed in the current branch/task, skipping tests. Lighter version of /prove:steward for use during active work.
argument-hint: "[base-branch (default: main)]"
---

# Code Steward: Session Review

Audit source files changed on this branch. Tests are excluded from scope. Artifacts go in `.prove/steward/`.

## Phase 0: Prerequisites

Read these for context (do not modify):
1. `CLAUDE.md` -- project conventions
2. `.claude/.prove.json` -- validators, project structure (if exists)
3. Active run's `plan.json` (`scripts/prove-run show plan`) or `.prove/plans/` -- intent behind changes (if exists)

## Phase 1: Scope Discovery

1. **Base branch**: Use `$ARGUMENTS` if provided, otherwise `main`. Verify with `git rev-parse --verify <base>`. Fall back to `master`, then halt.

2. **Changed files**:
   ```bash
   git diff <base>...HEAD --name-only
   git diff <base>...HEAD --stat
   ```

3. **Filter test files**: Remove `test_*`, `*_test.*`, `*.spec.*`, `*.test.*`, files in `tests/`/`__tests__/`, test fixtures/utilities.

4. No changes vs base? Check unstaged/staged (`git diff --name-only`, `git diff --cached --name-only`). Apply same filter.

5. No source files after filtering? Inform user "Only test files changed -- nothing to review." and stop.

**Scope = filtered source files only.** Read surrounding code (imports, callers, interfaces) for context; do not audit it.

## Phase 2: Deep Review

### < 5 source files

Launch `code-steward` agent directly:

> Audit ONLY these source files: [list]. Read-only -- produce findings, do NOT fix. Check cross-file integration: consistency, duplication, and coherence across changed files.

### 5+ source files

Run PCD pipeline:

```bash
python3 $PLUGIN_DIR/tools/pcd/__main__.py --project-root "$PROJECT_ROOT" map --scope <comma-separated changed files>
```

Run Rounds 1-3 per the steward skill's Phase 1. Synthesizer output: `.prove/steward/session-review.md`.

## Phase 3: Findings

Write `.prove/steward/session-review.md`:

```markdown
# Session Review
**Date**: [today] | **Branch**: [branch] | **Base**: [base]
**Source files reviewed**: [count] | **Test files skipped**: [count]
**Task context**: [from plan or branch/commits]

## Must Fix
[numbered, file:line refs -- address before merging]

## Should Fix
[numbered -- quality improvements worth making now]

## Nits
[numbered -- minor polish if time permits]

## Fix Plan
[1-3 work packages, note which can run in parallel]
```

## Phase 4: Review with User

Summarize: finding counts per category, proposed fix packages, estimated scope.

AskUserQuestion with options:
- **"Fix all"** -- apply all packages
- **"Must-fix only"** -- address must-fix items only
- **"Skip"** -- keep findings for reference, no fixes

## Phase 5: Apply Fixes

- **1-2 packages**: Fix directly via `code-steward` agent.
- **3+ independent packages**: Spawn parallel `code-steward` agents with focused prompts and explicit file lists.

New issues found while fixing: note in findings doc, stay on approved scope.

## Phase 6: Verification

1. Run `.claude/.prove.json` validators (lint first, then test).
2. If tests fail, append to `.prove/steward/session-review.md`:
   ```markdown
   ## Test Remediation Required
   | Test file | Failure reason | Source change that caused it |
   |---|---|---|
   ```
3. `git diff --stat` to show changes.
4. One-paragraph summary of improvements + test remediation table if applicable.

## Constraints

- **Only modify in-scope files.** Read unchanged files for patterns. Exception: renames requiring source reference updates.
- Flag broader issues for a full `/prove:steward` run.
