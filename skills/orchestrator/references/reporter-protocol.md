# Reporter Protocol

## Run State as Source of Truth

The orchestrator's audit trail is the JSON artifact set under `.prove/runs/<branch>/<slug>/`:

- `state.json` — live run state (run_status, per-task/step status, validator summary, review verdicts, dispatch ledger)
- `reports/<step_id>.json` — write-once per-step report (diff stats, validator outputs, artifacts)

No markdown log files are persisted. The CLI renders views on demand:

```bash
scripts/prove-run show state     # full state
scripts/prove-run show plan      # plan
scripts/prove-run show-report <step-id>
scripts/prove-run summary        # one-line
```

## Update Events (state.json mutations)

| Event | Mutation |
|-------|----------|
| Step start | `scripts/prove-run step-start <id>` — status → `in_progress`, `started_at` set |
| Validator pass/fail | `scripts/prove-run validator <id> <phase> pass\|fail` |
| Step complete | `scripts/prove-run step-complete <id> --commit <sha>` — status → `completed`, captures SHA |
| Step halted | `scripts/prove-run step-halt <id> --reason "..."` — status → `halted` |
| Review verdict | `scripts/prove-run review <task-id> approved\|rejected --notes "..." --reviewer principal-architect` |
| Report at step end | `scripts/prove-run report <id> --status completed --commit <sha>` → `reports/<id>.json` |

## Hook-Based Dispatch

Reporter dispatch is automatic via Claude Code hooks — the orchestrator never invokes reporters manually.

```
Hook Event -> Hook Script -> dispatch-event.sh -> .claude/.prove.json reporters
```

### Hook → Event Mapping

| Claude Code Hook | Matcher | Event | Detection |
|---|---|---|---|
| `PostToolUse` | `Bash` | `step-complete` | Git commit with `orchestrator:` pattern |
| `PostToolUse` | `Bash` | `step-halted` | Git commit with `[WIP]` pattern |
| `PostToolUse` | `Bash` | `wave-complete` | Git merge with orchestrator branch |
| `SubagentStop` | `principal-architect` | `review-approved` | APPROVED in agent output |
| `SubagentStop` | `principal-architect` | `review-rejected` | CHANGES_REQUIRED in agent output |
| `SubagentStop` | `validation-agent` | `validation-pass` | PASS in agent output |
| `SubagentStop` | `validation-agent` | `validation-fail` | FAIL in agent output |
| `Stop` | (all) | `execution-complete` | Active run (state.json not completed) |

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

`dispatch-event.sh` records dispatched events in `state.json.dispatch.dispatched[]` via `scripts/prove-run dispatch-record`. Each `(event, step)` tuple dispatched at most once per run. Slug auto-resolved from `.prove-wt-slug.txt`; branch derived from the run directory layout.

### Scripts

| Script | Purpose |
|--------|---------|
| `scripts/prove-run` | Agent wrapper for all run_state mutations and queries |
| `scripts/dispatch-event.sh` | Core dispatcher — reads `.claude/.prove.json`, fires matching reporters, dedupes via state.json |
| `scripts/hooks/post-tool-use.sh` | Detects orchestrator git commits/merges from Bash tool calls |
| `scripts/hooks/subagent-stop.sh` | Detects review/validation verdicts from subagent completions |
| `scripts/hooks/session-stop.sh` | Dispatches `execution-complete` when a session ends with a live run |

## Reporter Configuration

Reporter schema and environment variables are defined in `references/validation-config.md`. Setup interactively via `/prove:notify:notify-setup`.
