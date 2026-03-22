---
name: steward-review
description: Session-scoped code quality review. Audits only source files changed in the current branch/task, skipping tests. Lighter version of /prove:steward for use during active work.
argument-hint: "[base-branch (default: main)]"
---

# Code Steward: Session Review

You are running a **focused** code quality audit scoped to the current session's work — only the source files changed on this branch relative to the base. Same quality standards as a full audit, but narrower blast radius.

**Tests are NOT in scope.** Source code changes first — tests adapt second.

## Phase 0: Prerequisites

1. Read the project's `CLAUDE.md` for conventions.
2. Check for `.prove.json` — if it exists, read it for validators and project structure.
3. Check for `.prove/TASK_PLAN.md` or `.prove/plans/` to understand the intent behind the changes.

## Phase 1: Scope Discovery

Determine exactly what source files to review:

1. **Determine base branch**:
   - If `$ARGUMENTS` is provided, use it as the base branch
   - Otherwise, default to `main`
   - Verify the base branch exists: `git rev-parse --verify <base>`
   - If not found, try `master`, then halt with an error

2. **Gather changed files**:
   ```bash
   git diff <base>...HEAD --name-only
   git diff <base>...HEAD --stat
   ```

3. **Filter out test files** — remove from the review list:
   - `test_*` / `*_test.*` files
   - Files inside `tests/`, `__tests__/` directories
   - `*.spec.*` / `*.test.*` files
   - Test fixtures and test utility files

4. If there are no changes relative to base, check unstaged/staged changes:
   ```bash
   git diff --name-only
   git diff --cached --name-only
   ```
   Apply the same test file filter.

5. If no source files remain after filtering, inform the user: "Only test files changed — nothing to review." and stop.

**Your review scope is ONLY the filtered source files.** Do not audit the full codebase. But DO read surrounding code (imports, callers, interfaces) to understand context.

## Phase 2: Deep Review

Launch the `code-steward` agent with this directive:

> Audit ONLY these source files: [list the filtered source files].
> Scope is read-only — produce findings, do NOT fix anything yet.
> In addition to your standard audit dimensions, check cross-file integration: do the changed files work well together? Are there duplications or inconsistencies across them?

## Phase 3: Findings

Create or update `.prove/steward/session-review.md`:

```markdown
# Session Review
**Date**: [today's date]
**Branch**: [current branch]
**Base**: [base branch]
**Source files reviewed**: [count]
**Test files skipped**: [count]
**Task context**: [from prove plan if available, otherwise from branch name/commits]

## Must Fix
Issues that should be addressed before merging.
[numbered list with file:line references]

## Should Fix
Quality improvements worth making now while context is fresh.
[numbered list]

## Nits
Minor polish — fix if time permits.
[numbered list]

## Fix Plan
[Group findings into 1-3 small work packages, noting which can run in parallel]
```

## Phase 4: Review with User

Present a concise summary:
- How many findings per category
- Proposed fix packages
- Estimated scope of changes

Use `AskUserQuestion` with options:
- **"Fix all"** — apply all fix packages
- **"Must-fix only"** — only address must-fix items
- **"Skip"** — keep findings for reference, don't fix anything

## Phase 5: Apply Fixes

Based on user approval:

- **If 1-2 small work packages**: Fix directly in this conversation using the `code-steward` agent — no need to spawn multiple subagents for a handful of files.
- **If 3+ independent packages**: Spawn parallel `code-steward` agents, each with a focused prompt and explicit file list.

If you discover additional issues while fixing, note them in the findings doc but stay focused on the approved scope.

## Phase 6: Verification

1. Run validators from `.prove.json` (lint phase first, then test phase).
2. **If tests fail** (expected after source refactors), append a test remediation section to `.prove/steward/session-review.md`:

```markdown
## Test Remediation Required
| Test file | Failure reason | Source change that caused it |
|---|---|---|
| ... | ... | ... |
```

3. Run `git diff --stat` to show the user what changed.
4. Present a one-paragraph summary of improvements made, plus the test remediation table if any tests broke.

## Constraints

- **Read context, don't fix context.** Read unchanged files for patterns, but only modify files in scope (unless a rename naturally requires updating source references).
- **Steward artifacts live in `.prove/steward/`**. Do not create top-level directories.
- Flag broader codebase issues for a full `/prove:steward` run.
