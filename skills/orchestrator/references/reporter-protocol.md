# Reporter Protocol

Defines the progress tracking and reporting format used by the orchestrator.

## Overview

The orchestrator maintains two files during execution:

1. **Run Log** (`.prove/reports/<task-slug>/run-log.md`) — detailed, append-only audit trail
2. **Report** (`.prove/reports/<task-slug>/report.md`) — generated at completion, human-readable summary

## Directory Structure

```
.prove/reports/<task-slug>/
├── run-log.md          # live during execution
└── report.md           # generated at completion
```

## Run Log Format

```markdown
# Run Log: <Task Name>

**Branch**: workflow/<task-slug>
**Started**: <ISO timestamp>
**Status**: In Progress | Completed | Halted at Step N
**Mode**: simple | full (auto-detected or forced)

## Configuration
- **Mode**: simple (≤3 steps) | full (parallel worktrees + review)
- **Validators**: <detected list>
- **Steps**: <total count>
- **Waves**: <wave count, full mode only>

## Step Log
| # | Step | Status | Commit | Validator Results | Notes |
|---|------|--------|--------|-------------------|-------|
| 1 | <desc> | done | abc1234 | build:PASS test:PASS | — |
| 2 | <desc> | in_progress | — | — | — |

## Detailed Log

### Step 1: <description>
**Started**: <timestamp>
**Status**: done
**Commit**: abc1234

#### Validator Results
- build: PASS (2.3s)
- test: PASS (5.1s) — 12 tests, 0 failures

#### Handoff Written
- handoff-log.md entry
- api-contracts.md (new)

---

### Step 2: <description>
...
```

## Report Format (Generated at Completion)

```markdown
# Workflow Report: <Task Name>

**Branch**: workflow/<task-slug>
**Status**: Completed | Halted at Step N
**Mode**: simple | full
**Started**: <timestamp>
**Finished**: <timestamp>
**Total Commits**: N

## Summary
<What was accomplished, what remains>

## Steps
| # | Step | Status | Commit |
|---|------|--------|--------|
| 1 | <desc> | done | abc1234 |
| 2 | <desc> | done | def5678 |

## Validation Summary
- Build: PASS/FAIL
- Tests: X passed, Y failed, Z skipped
- Lint: PASS/FAIL

## Review Summary (full mode only)
| Task | Reviews | Final Verdict |
|------|---------|--------------|
| 1.1  | 1       | APPROVED     |
| 1.2  | 2       | APPROVED     |

## Files Changed
<output of: git diff --stat main...HEAD>

## Handoff Context Generated
- `.prove/context/<slug>/handoff-log.md` — N entries
- `.prove/context/<slug>/api-contracts.md` — created
- `.prove/context/<slug>/discoveries.md` — created

## How to Review
\`\`\`bash
# View all changes
git diff main...workflow/<task-slug>

# View step-by-step
git log --oneline main..workflow/<task-slug>
git show <commit-sha>
\`\`\`

## Rollback Options
\`\`\`bash
# Undo everything
git checkout main
git branch -D workflow/<task-slug>

# Revert a specific step
git revert <commit-sha>
\`\`\`

## Merge When Satisfied
\`\`\`bash
git checkout main
git merge --no-ff workflow/<task-slug>
\`\`\`
```

## Update Events

The run-log is updated at these points:

| Event | What's Updated |
|-------|---------------|
| Step start | Status → `in_progress` |
| Validator pass | Validator results column |
| Validator fail | Validator results + detailed error in log |
| Retry attempt | Notes column: "retry 1/1" |
| Step complete | Status → `done`, commit SHA recorded |
| Step halted | Status → `HALTED`, blocker details in log |
| Review verdict (full) | Review results in detailed log |
| Wave complete (full) | Wave summary row |
| Execution complete | Final status, report generated |

## Extending the Reporter

To add custom reporting (e.g., Slack notifications, metrics):

1. Add a `reporters` key to `.prove.json` in the project root (see `references/validation-config.md` for schema)
2. The orchestrator runs listed commands at specified events

```json
{
  "validators": [ ... ],
  "reporters": [
    {
      "name": "slack-notify",
      "command": "./scripts/notify-slack.sh",
      "events": ["step-complete", "execution-complete", "step-halted"]
    },
    {
      "name": "metrics",
      "command": "./scripts/record-metrics.sh",
      "events": ["execution-complete"]
    }
  ]
}
```

Reporter commands receive event data via environment variables:
- `PROVE_EVENT`: event name
- `PROVE_TASK`: task slug
- `PROVE_STEP`: step number (if applicable)
- `PROVE_STATUS`: current status
- `PROVE_BRANCH`: branch name

### Quick Setup

Use the notify-setup skill to configure reporters interactively:

```
/prove:notify-setup
```

This guides you through platform selection (Slack, Discord, custom), generates notification scripts, and configures the reporters section automatically.
