---
description: Show orchestrator execution status — current wave, task statuses, review verdicts, and blockers
---

# Progress Report

Read the current orchestrator state and present a compact status summary.

## Steps

1. Check if `.prove/PROGRESS.md` exists
   - If not, check `.prove/reports/` for any run logs
   - If neither exists, tell the user: "No active orchestrator run found. Start one with `/prove:orchestrator` or `/prove:full-auto`."

2. If `.prove/PROGRESS.md` exists, read it and extract:
   - Overall status (In Progress / Completed / Failed / Paused)
   - Current wave number and total waves
   - Per-task status (pending / in-progress / completed / failed)
   - Review verdicts from the Review Log section
   - Any items in the Issues section
   - Test results if available

3. Also check `.prove/reports/*/run-log.md` for the most recent report:
   - Extract the Step Log table
   - Note any WIP or failed steps

4. Present a compact summary:

```
## Orchestrator Status: [Feature Name]

**Status**: In Progress | **Branch**: orchestrator/feature-slug
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

5. If the orchestrator is complete, show final stats and merge instructions.

## Rules
- Read files only — never modify PROGRESS.md or run-log.md
- If data is ambiguous or missing, say so rather than guessing
- Keep output concise — this is a status check, not a full report
