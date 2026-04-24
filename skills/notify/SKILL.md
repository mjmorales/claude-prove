---
name: notify
description: >
  Unified notification skill. Configures orchestrator reporters (Slack, Discord,
  MCP, custom) by generating bash scripts and updating .claude/.prove.json, and
  sends test notifications through configured reporters. Triggers: "notify
  setup", "set up notifications", "configure alerts", "slack reporter",
  "discord reporter", "test notifications".
---

# notify

Dispatches by subcommand. Follows `references/interaction-patterns.md` for all `AskUserQuestion` usage.

| Subcommand | Purpose |
|------------|---------|
| `setup [platform]` | Configure a reporter — generate script, register in `.claude/.prove.json` |
| `test [--reporter <name>] [event]` | Send a test notification through configured reporter(s) |

Parse first token of `$ARGUMENTS` as subcommand. If absent, `AskUserQuestion` header "Action": "Setup reporter" / "Test reporters".

---

## Subcommand: `setup`

Remaining `$ARGUMENTS` tokens: optional platform (`slack`, `discord`, `mcp`, `custom`). If supplied, skip platform selection.

### Phase 1 — Discovery

Scan existing integrations before prompting:

1. Read `.claude/settings.json` and `~/.claude/settings.json` for MCP servers with messaging capabilities
2. Check environment for `SLACK_WEBHOOK_URL`, `DISCORD_WEBHOOK_URL`
3. Check `.claude/.prove.json` for existing reporters
4. Report findings. If an existing reporter suffices, confirm before proceeding.

### Phase 2 — Platform Selection

Skip if `$ARGUMENTS` already named a platform. Otherwise `AskUserQuestion` header "Platform", annotating options with discovery results (e.g., "Slack (Webhook) — SLACK_WEBHOOK_URL detected"):

- **Slack (Webhook)** — posts via `SLACK_WEBHOOK_URL` and curl
- **Discord (Webhook)** — posts via `DISCORD_WEBHOOK_URL` and curl
- **MCP Integration** — reuses a detected MCP server's messaging tool
- **Custom Command** — user-provided notification command

### Phase 3 — Configuration

`AskUserQuestion` header "Scope":
- **Project** — scripts in `./.prove/`, config in `.claude/.prove.json`
- **Global** — scripts in `~/.claude/scripts/`

`AskUserQuestion` header "Events" (multiSelect: true). Offer all reporter event types: `step-complete`, `step-halted`, `wave-complete`, `execution-complete`, `review-approved`, `review-rejected`, `validation-pass`, `validation-fail`.

Platform-specific details (free-form):

| Platform | Fields |
|----------|--------|
| Slack | Webhook URL env var (default `SLACK_WEBHOOK_URL`), channel override, mention prefs |
| Discord | Webhook URL env var (default `DISCORD_WEBHOOK_URL`), mention role |
| MCP | Which MCP server and tool, channel/recipient |
| Custom | Command to run, any env vars it needs |

### Phase 4 — Script Generation

Generate a bash script tailored to platform + preferences.

Requirements:
- `#!/usr/bin/env bash`, POSIX-compatible
- Read reporter env vars (`PROVE_EVENT`, `PROVE_TASK`, `PROVE_STEP`, `PROVE_STATUS`, `PROVE_BRANCH`, `PROVE_DETAIL`)
- Format a human-readable message from those vars
- Support `--test` flag with dummy data
- Fail gracefully — use `|| true` and trap so the orchestrator is never blocked
- Reference env vars for secrets; embed no URLs or tokens in the script

See `references/platforms.md` for platform-specific payload formats, curl patterns, and MCP invocation. See `references/notification-examples.md` for complete copy-paste-ready scripts (Slack, Discord, custom).

Write to `./.prove/notify-<platform>.sh` (project) or `~/.claude/scripts/notify-<platform>.sh` (global), then `chmod +x`.

### Phase 5 — Config Update

1. Read `.claude/.prove.json` (create if missing)
2. Add/update a `reporters` entry, preserving all other config:
   ```json
   {
     "name": "<platform>-notify",
     "command": "./.prove/notify-<platform>.sh",
     "events": ["step-complete", "step-halted", "execution-complete"]
   }
   ```
3. Convert event selections to kebab-case slugs (e.g., "Step Complete" -> `step-complete`)

### Phase 6 — Verification

1. Run the script with `--test`
2. Report success or failure
3. Summarize: platform, scope, script path, subscribed events, config entry

---

## Subcommand: `test`

Send a test notification through configured reporters.

### Arguments

Remaining `$ARGUMENTS` tokens after `test`:
- `--reporter <name>` — test only the named reporter (defaults to all)
- First non-flag token is the event type (defaults to `step-complete`)

### Preflight

1. Read `.claude/.prove.json`. If no `reporters` entries: inform the user and suggest `/prove:notify setup`. Do not run any script.
2. If `--reporter <name>` specified, filter to that entry. If not found, list available reporter names and stop.

### Execution

Delegate to the CLI which handles script resolution, env var injection, and exit-code capture:

```bash
claude-prove notify test $ARGUMENTS
```

Reporter scripts live in `./.prove/` (project scope) or `~/.claude/scripts/` (global scope).

### Env Var Contract

The CLI exports these before invoking each reporter command:

| Var | Value |
|-----|-------|
| `PROVE_EVENT` | Event name (e.g., `step-complete`) |
| `PROVE_TASK` | Task slug (e.g., `example-task`) |
| `PROVE_STEP` | Step number (if applicable) |
| `PROVE_STATUS` | Current status (e.g., `complete`) |
| `PROVE_BRANCH` | Branch name |
| `PROVE_DETAIL` | One-line summary (may be empty for lifecycle events) |

### Report

Per reporter: name, exit code, stdout/stderr tail on failure. If every configured reporter for the chosen event succeeds, report overall PASS; otherwise FAIL.

---

## Reporter Event Types

| Event | Fires When |
|-------|-----------|
| `step-complete` | Step passes all validators and is committed |
| `step-halted` | Step fails validation after retry, execution stops |
| `wave-complete` | All tasks in a parallel wave merged (full mode) |
| `execution-complete` | Orchestrator run finishes (success or halted) |
| `review-approved` | Principal architect approves a task |
| `review-rejected` | Principal architect requests changes |
| `validation-pass` | LLM validation agent returns PASS |
| `validation-fail` | LLM validation agent returns FAIL |

## Committing

Delegate to the `commit` skill. Example messages:
- `feat(notify): add Slack webhook reporter`
- `chore(notify): subscribe discord reporter to wave-complete`
