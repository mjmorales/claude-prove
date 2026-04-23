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
Hook Event -> prove run-state hook <event> -> .claude/.prove.json reporters
```

### Hook → Event Mapping

| Claude Code Hook | Matcher | Event | Detection |
|---|---|---|---|
| `PostToolUse` | `Bash` (`if: Bash(git commit*)`) | commit audit | `prove acb hook post-commit` records the intent manifest |
| `PostToolUse` | `Write\|Edit\|MultiEdit` | `step-complete` / `step-halted` | `prove run-state hook validate` reads state.json, emits step events |
| `PreToolUse` | `Write\|Edit\|MultiEdit` | guard | `prove run-state hook guard` blocks edits that violate run state |
| `SessionStart` | `resume\|compact` | session-start | `prove run-state hook session-start` rehydrates the active run |
| `Stop` | (all) | `execution-complete` | `prove run-state hook stop` dispatches when a session ends with a live run |
| `SubagentStop` | `general-purpose` | review / validation verdicts | `prove run-state hook subagent-stop` parses agent output for APPROVED / CHANGES_REQUIRED / PASS / FAIL |

### Hook Configuration (`.claude/settings.json`)

Prove-owned blocks are tagged with `_tool` and scaffolded by `prove install init-hooks` (or `prove install init`). They resolve the runtime prefix from the active plugin root (dev: `bun run <pluginRoot>/packages/cli/bin/run.ts`; compiled: `prove`) and emit canonical blocks:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "if": "Bash(git commit*)", "command": "<prefix> acb hook post-commit --workspace-root $CLAUDE_PROJECT_DIR", "timeout": 10000 }],
        "_tool": "acb"
      },
      {
        "matcher": "Write|Edit|MultiEdit",
        "hooks": [{ "type": "command", "command": "<prefix> run-state hook validate", "timeout": 5000 }],
        "_tool": "run_state"
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit",
        "hooks": [{ "type": "command", "command": "<prefix> run-state hook guard", "timeout": 5000 }],
        "_tool": "run_state"
      }
    ],
    "SessionStart": [
      {
        "matcher": "resume|compact",
        "hooks": [{ "type": "command", "command": "<prefix> run-state hook session-start", "timeout": 3000 }],
        "_tool": "run_state"
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [{ "type": "command", "command": "<prefix> run-state hook stop", "timeout": 5000 }],
        "_tool": "run_state"
      }
    ],
    "SubagentStop": [
      {
        "matcher": "general-purpose",
        "hooks": [{ "type": "command", "command": "<prefix> run-state hook subagent-stop", "timeout": 5000 }],
        "_tool": "run_state"
      }
    ]
  }
}
```

The canonical block list lives in `packages/installer/src/write-settings-hooks.ts` (`PROVE_HOOK_BLOCKS`). User-authored blocks (no `_tool` key) are preserved byte-for-byte across re-runs.

### Deduplication

The dispatcher records fired events in `state.json.dispatch.dispatched[]` via `prove run-state dispatch record`. Each `(event, step)` tuple dispatches at most once per run. Slug auto-resolved from `.prove-wt-slug.txt`; branch derived from the run directory layout.

### Commands

| Command | Purpose |
|--------|---------|
| `prove run-state <action>` | All run_state mutations and queries — show, step, validator, review, report, dispatch |
| `prove run-state hook validate` | PostToolUse `Write\|Edit\|MultiEdit` — advances step state and fires `step-complete` / `step-halted` |
| `prove run-state hook guard` | PreToolUse `Write\|Edit\|MultiEdit` — blocks edits incompatible with the active step |
| `prove run-state hook subagent-stop` | SubagentStop `general-purpose` — fires review / validation verdicts |
| `prove run-state hook session-start` | SessionStart `resume\|compact` — rehydrates run context |
| `prove run-state hook stop` | Stop — fires `execution-complete` when the session ends with a live run |
| `prove acb hook post-commit` | PostToolUse `Bash` (`if: Bash(git commit*)`) — records ACB intent manifest |

## Reporter Configuration

Reporter schema and environment variables are defined in `references/validation-config.md`. Setup interactively via `/prove:notify setup`.
