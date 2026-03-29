# Reporter Protocol

## Run Log

Append-only audit trail at `.prove/runs/<slug>/reports/run-log.md`. Created during Phase 0 initialization (see SKILL.md).

### Update Events

| Event | What's Updated |
|-------|---------------|
| Step start | Status -> `in_progress` |
| Validator pass | Validator results column |
| Validator fail | Validator results + detailed error |
| Retry attempt | Notes: "retry 1/1" |
| Step complete | Status -> `done`, commit SHA |
| Step halted | Status -> `HALTED`, blocker details |
| Review verdict (full) | Review results in detailed log |
| Wave complete (full) | Wave summary row |
| Execution complete | Final status, report generated |
| Cleanup complete | Archive location, deleted branches |

### Detailed Entry Format

Each step gets a detailed section appended:

```markdown
### Step N: <description>
**Started**: <timestamp>
**Status**: done
**Commit**: abc1234

#### Validator Results
- build: PASS (2.3s)
- test: PASS (5.1s) — 12 tests, 0 failures

#### Handoff Written
- handoff-log.md entry
- api-contracts.md (new)
```

## Report

Generated at completion: `.prove/runs/<slug>/reports/report.md`. Format defined in SKILL.md Phase 3.

## Hook-Based Dispatch

Reporter dispatch is automatic via Claude Code hooks -- the orchestrator never invokes reporters manually.

```
Hook Event -> Hook Script -> dispatch-event.sh -> .claude/.prove.json reporters
```

### Hook -> Event Mapping

| Claude Code Hook | Matcher | Event | Detection |
|---|---|---|---|
| `PostToolUse` | `Bash` | `step-complete` | Git commit with `orchestrator:` pattern |
| `PostToolUse` | `Bash` | `step-halted` | Git commit with `[WIP]` pattern |
| `PostToolUse` | `Bash` | `wave-complete` | Git merge with orchestrator branch |
| `SubagentStop` | `principal-architect` | `review-approved` | APPROVED in agent output |
| `SubagentStop` | `principal-architect` | `review-rejected` | CHANGES_REQUIRED in agent output |
| `SubagentStop` | `validation-agent` | `validation-pass` | PASS in agent output |
| `SubagentStop` | `validation-agent` | `validation-fail` | FAIL in agent output |
| `Stop` | (all) | `execution-complete` | Active run in PROGRESS.md |

### Hook Configuration (`.claude/settings.json`)

```json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "Bash",
      "hooks": [{
        "type": "command",
        "command": "bash \"$CLAUDE_PROJECT_DIR/scripts/hooks/post-tool-use.sh\"",
        "async": true, "timeout": 30
      }]
    }],
    "SubagentStop": [{
      "matcher": "principal-architect|prove:principal-architect|validation-agent|prove:validation-agent",
      "hooks": [{
        "type": "command",
        "command": "bash \"$CLAUDE_PROJECT_DIR/scripts/hooks/subagent-stop.sh\"",
        "async": true, "timeout": 30
      }]
    }],
    "Stop": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "bash \"$CLAUDE_PROJECT_DIR/scripts/hooks/session-stop.sh\"",
        "async": true, "timeout": 30
      }]
    }]
  }
}
```

### Deduplication

`dispatch-event.sh` maintains `.prove/runs/<slug>/dispatch-state.json`. Each `(event, step)` tuple dispatched at most once per run. Slug from `PROVE_TASK` env var or current branch.

### Scripts

| Script | Purpose |
|--------|---------|
| `scripts/dispatch-event.sh` | Core dispatcher -- reads `.claude/.prove.json`, fires matching reporters, deduplicates |
| `scripts/hooks/post-tool-use.sh` | Detects orchestrator git commits/merges from Bash tool calls |
| `scripts/hooks/subagent-stop.sh` | Detects review/validation verdicts from subagent completions |
| `scripts/hooks/session-stop.sh` | Dispatches `execution-complete` on session end |

## Reporter Configuration

Reporter schema and environment variables are defined in `references/validation-config.md`. Setup interactively via `/prove:notify:notify-setup`.
