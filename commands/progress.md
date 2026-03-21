---
description: Show orchestrator execution status — current wave, task statuses, review verdicts, and blockers
---

# Progress Report

Read the current orchestrator state and present a compact status summary. Supports multiple concurrent orchestrator runs.

## Steps

1. Scan for active orchestrator runs:
   - Check `.prove/runs/*/PROGRESS.md` for namespaced run directories
   - Fall back to `.prove/PROGRESS.md` for legacy single-run layout
   - Check `.prove/reports/` for any run logs
   - If nothing exists, tell the user: "No active orchestrator run found. Start one with `/prove:orchestrator` or `/prove:full-auto`."

2. If multiple runs are found, list them all in a summary table first:
   ```
   ## Active Orchestrator Runs

   | Slug | Status | Branch | Tasks |
   |------|--------|--------|-------|
   | add-auth | In Progress | orchestrator/add-auth | 3/6 complete |
   | fix-perf | Completed | orchestrator/fix-perf | 4/4 complete |
   ```

3. For each run (or a single run if only one), read PROGRESS.md and extract:
   - Overall status (In Progress / Completed / Failed / Paused)
   - Current wave number and total waves
   - Per-task status (pending / in-progress / completed / failed)
   - Review verdicts from the Review Log section
   - Any items in the Issues section
   - Test results if available

4. Also check `.prove/runs/<slug>/reports/run-log.md` (or legacy `.prove/reports/*/run-log.md`) for the most recent report:
   - Extract the Step Log table
   - Note any WIP or failed steps

5. Present a compact summary per run:

```
## Orchestrator Status: [Feature Name]

**Status**: In Progress | **Branch**: orchestrator/feature-slug
**Worktree**: .claude/worktrees/orchestrator-feature-slug
**Wave**: 2/3 | **Tasks**: 4/6 complete

### Current Wave (Wave 2)
- [x] Task 2.1: Index manager — APPROVED, merged
- [ ] Task 2.2: CLI entry point — In progress

### Review Log (last 5)
- 14:30 Task 1.1: APPROVED (round 2)
- 14:35 Task 1.2: APPROVED (round 2)

### Blockers
- None
```

6. If an orchestrator run is complete, show final stats and merge instructions.

## Rules
- Read files only — never modify PROGRESS.md or run-log.md
- If data is ambiguous or missing, say so rather than guessing
- Keep output concise — this is a status check, not a full report
