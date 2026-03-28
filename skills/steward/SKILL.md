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

## Phase 1: Progressive Context Distillation (PCD)

Run the multi-round PCD audit pipeline. Produces the same artifacts as a direct
code-steward audit (findings.md + fix-plan.md) but with better coverage through
progressive compression and risk-targeted depth allocation.

### 1a. Round 0a: Structural Map (Deterministic)

Generate the structural map:

```bash
python3 $PLUGIN_DIR/tools/pcd/__main__.py --project-root "$PROJECT_ROOT" map [--scope <scope from Phase 0>]
```

This produces `.prove/steward/pcd/structural-map.json` with file metadata,
dependency edges, and clusters. Review the summary output for file count and
cluster formation.

### 1b. Round 0b: Semantic Annotation (Optional)

**Skip if the structural map has fewer than 20 files.**

Launch the `pcd-annotator` agent:

> Annotate the structural map at `.prove/steward/pcd/structural-map.json`.
> Add semantic labels and module-purpose descriptions to each cluster.
> Write the annotated map back to the same file.

### 1c. Round 1: Parallel Triage (Sonnet)

Read `.prove/steward/pcd/structural-map.json` to get the cluster list.

For each cluster, launch a `pcd-triager` agent **in parallel** (use `run_in_background: true`):

> Triage these files: [file list from cluster].
> Structural context: [cluster metadata, dependency edges for these files].
> Write your triage cards as JSON to `.prove/steward/pcd/triage-batch-{cluster_id}.json`.

After all triagers complete, **merge** all triage-batch-*.json files into a single
`.prove/steward/pcd/triage-manifest.json`:

```json
{
  "version": 1,
  "stats": { "files_reviewed": N, "high_risk": N, "medium_risk": N, "low_risk": N, "total_questions": N },
  "cards": [... all cards from all batches ...],
  "question_index": [... all questions extracted from cards ...]
}
```

### 1d. Collapse (Deterministic)

```bash
python3 $PLUGIN_DIR/tools/pcd/__main__.py --project-root "$PROJECT_ROOT" collapse
```

This compresses low-risk triage cards and produces `.prove/steward/pcd/collapsed-manifest.json`.

### 1e. Round 2: Deep Review (Opus, Targeted)

```bash
python3 $PLUGIN_DIR/tools/pcd/__main__.py --project-root "$PROJECT_ROOT" batch
```

This produces `.prove/steward/pcd/batch-definitions.json` with review batches.

Read the batch definitions. For each batch, launch a `pcd-reviewer` agent (max 3 concurrent, use `run_in_background: true`):

> Review batch {batch_id}.
> Files: [file list].
> Triage context: [triage cards for these files].
> Routed questions: [questions targeting these files — present each question immediately before the file it references].
> Cluster context: [cluster metadata].
> Write findings to `.prove/steward/pcd/findings-batch-{batch_id}.json`.

### 1f. Round 3: Synthesis

Launch the `pcd-synthesizer` agent:

> Synthesize all review artifacts in `.prove/steward/pcd/`:
> - structural-map.json (codebase structure)
> - collapsed-manifest.json (triage summary)
> - findings-batch-*.json (detailed findings from each review batch)
>
> DO NOT read any source files directly.
>
> Produce:
> - `.prove/steward/findings.md` — findings document in the standard steward format
> - `.prove/steward/fix-plan.md` — parallelizable work packages

### 1g. Fallback

If any critical PCD round fails (Round 1 produces no output, Round 2 fails on all batches,
or Round 3 fails to produce findings.md), **fall back** to the original single-pass approach:

> Launch `code-steward` agent:
> Audit [scope] in document-only mode. Produce findings and fix plan.

Log the PCD failure reason in `.prove/steward/pcd/pipeline-status.json`.

## Phase 2: Create Findings Document

> **Note**: If PCD (Phase 1) completed successfully, `findings.md` and `fix-plan.md`
> already exist — skip to Phase 3. This phase only runs when using the single-pass
> fallback.

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
