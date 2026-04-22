---
name: steward
description: Deep codebase quality audit with automated fixes. Runs the code-steward agent for line-by-line source code review, produces a findings document, then orchestrates parallel subagents to implement all fixes. Tests are reviewed separately after source changes land.
argument-hint: "[directory or module to scope the audit]"
---

# Code Steward: Deep Codebase Audit & Fix

Audit every source file for clarity, extensibility, and agent-workflow debt. Clean breaks -- rename, restructure, delete. Test files excluded from all phases (source first, tests adapt separately).

## Phase 0: Prerequisites

1. Read `CLAUDE.md` for conventions, `.claude/.prove.json` for validators/scopes (do not guess commands).
2. Check active run's `plan.json` (`scripts/prove-run show plan`) or `.prove/plans/` for task context.
3. Scope: `$ARGUMENTS` if provided, otherwise full codebase.

## Phase 1: Progressive Context Distillation (PCD)

Multi-round pipeline producing `findings.md` + `fix-plan.md` with progressive compression and risk-targeted depth.

### 1a. Structural Map

```bash
prove pcd map --project-root "$PROJECT_ROOT" [--scope <scope from Phase 0>]
```

Produces `.prove/steward/pcd/structural-map.json` (file metadata, dependency edges, clusters).

### 1b. Semantic Annotation (skip if < 20 files)

Launch `pcd-annotator` agent:

> Annotate `.prove/steward/pcd/structural-map.json` with semantic labels and module-purpose descriptions per cluster. Write back to the same file.

### 1c. Parallel Triage (Sonnet)

For each cluster in the structural map, launch `pcd-triager` (`run_in_background: true`):

> Triage files: [file list]. Context: [cluster metadata, dependency edges].
> Write triage cards to `.prove/steward/pcd/triage-batch-{cluster_id}.json`.

Merge all batches into `.prove/steward/pcd/triage-manifest.json`:

```json
{
  "version": 1,
  "stats": { "files_reviewed": N, "high_risk": N, "medium_risk": N, "low_risk": N, "total_questions": N },
  "cards": [... all cards ...],
  "question_index": [... all questions ...]
}
```

### 1d. Collapse

```bash
prove pcd collapse --project-root "$PROJECT_ROOT"
```

Compresses low-risk cards into `.prove/steward/pcd/collapsed-manifest.json`.

### 1e. Deep Review (Opus, max 3 concurrent)

```bash
prove pcd batch --project-root "$PROJECT_ROOT"
```

For each batch in `batch-definitions.json`, launch `pcd-reviewer` (`run_in_background: true`):

> Review batch {batch_id}. Files: [list]. Triage context: [cards]. Routed questions: [present each question before the file it references]. Cluster context: [metadata].
> Write findings to `.prove/steward/pcd/findings-batch-{batch_id}.json`.

### 1f. Synthesis

Launch `pcd-synthesizer`:

> Synthesize artifacts in `.prove/steward/pcd/`: structural-map.json, collapsed-manifest.json, findings-batch-*.json.
> Do not read source files directly.
> Produce: `.prove/steward/findings.md` (standard format) and `.prove/steward/fix-plan.md` (parallelizable work packages).

### 1g. Fallback

If any critical PCD round fails, fall back to single-pass `code-steward` agent in document-only mode. Log failure in `.prove/steward/pcd/pipeline-status.json`.

## Phase 2: Findings Document (fallback only)

Skip if PCD produced `findings.md` and `fix-plan.md`.

Create `.prove/steward/findings.md`:

```markdown
# Code Steward Audit Findings
**Date**: [today]  **Scope**: [scope]  **Files reviewed**: [count]

## Critical Issues
[numbered, file:line references]

## Structural Refactors
[numbered, before/after]

## Naming & Readability
## Code Hygiene
## Performance
## Systemic Recommendations
```

Create `.prove/steward/fix-plan.md` grouping findings into independent, parallelizable work packages (name, files, finding numbers, changes).

## Phase 3: Review with User

Present findings summary (counts by category) and fix plan (packages with dependency annotations).

AskUserQuestion options: "Approve all" / "Cherry-pick" / "Abort"

## Phase 4: Orchestrate Parallel Fixes

Spawn `code-steward` agents per approved work package. Include only what the agent cannot infer from its own definition:
- Specific finding numbers and file list
- "Document-then-fix mode: implement these findings."
- "Note additional issues discovered while fixing, but stay focused on assigned findings."

Launch independent packages simultaneously; serialize only packages with overlapping files. Update `.prove/steward/fix-plan.md` as agents complete.

## Phase 5: Verification & Test Remediation

1. Run `.claude/.prove.json` validators (lint, then tests).
2. Scan for parallel-agent conflicts (duplicate edits, import collisions).
3. On test failures, append remediation table to findings:

   | Test file | Failure | Source change that caused it |
   |---|---|---|
4. Generate `.prove/reports/steward/report.md` (changes summary, remediation table, remaining recommendations).
5. Present summary. Flag broken tests as follow-up -- do not fix tests in this workflow.

## Constraints

- Refactors preserve behavior. Bug fixes are separate and explicitly called out.
- Artifacts in `.prove/steward/`, reports in `.prove/reports/steward/`.
