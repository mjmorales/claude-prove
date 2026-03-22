---
description: Show orchestrator execution status — current wave, task statuses, review verdicts, and blockers
---

# Progress Report

Read-only status check across all active orchestrator runs. Never modify any files.

## Steps

1. Scan `.prove/runs/*/PROGRESS.md` for active runs.
   - If none exist: "No active orchestrator run found. Start one with `/prove:orchestrator` or `/prove:full-auto`."

2. For each run, read `PROGRESS.md` and `reports/run-log.md`. Extract:
   - Overall status, current wave/total waves, per-task status
   - Review verdicts (last 5), issues/blockers, test results
   - Any WIP or failed steps from the Step Log

3. If multiple runs exist, show a summary table first:

   | Slug | Status | Branch | Tasks |
   |------|--------|--------|-------|

4. Present a compact summary per run:

```
## Orchestrator Status: [Feature Name]
**Status**: In Progress | **Branch**: orchestrator/<slug>
**Wave**: 2/3 | **Tasks**: 4/6 complete

### Current Wave
- [x] Task 2.1: Index manager — APPROVED, merged
- [ ] Task 2.2: CLI entry point — In progress

### Review Log (last 5)
- 14:30 Task 1.1: APPROVED (round 2)

### Blockers
- None
```

5. For completed runs, include final stats and merge instructions.

## Rules
- Read-only — never modify run files
- State ambiguity explicitly rather than guessing
- Keep output concise — status check, not full report
