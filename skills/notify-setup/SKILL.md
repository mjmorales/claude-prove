---
name: notify-setup
description: >
  Configure orchestrator notification reporters (Slack, Discord, MCP, custom).
  Generates bash scripts and updates .claude/.prove.json. Triggers on "notify setup",
  "set up notifications", "configure alerts".
---

# Notify Setup

Follow `references/interaction-patterns.md` for all `AskUserQuestion` usage.

## Phase 1: Discovery

Scan existing integrations before prompting the user:

1. Read `.claude/settings.json` and `~/.claude/settings.json` for MCP servers with messaging capabilities
2. Check environment for `SLACK_WEBHOOK_URL`, `DISCORD_WEBHOOK_URL`
3. Check `.claude/.prove.json` for existing reporters
4. Report findings. If an existing reporter suffices, confirm before proceeding.

## Phase 2: Platform Selection

`AskUserQuestion`, header "Platform". Annotate options with discovery results (e.g., "Slack (Webhook) -- SLACK_WEBHOOK_URL detected"):

- "Slack (Webhook)" -- posts via `SLACK_WEBHOOK_URL` and curl
- "Discord (Webhook)" -- posts via `DISCORD_WEBHOOK_URL` and curl
- "MCP Integration" -- reuses a detected MCP server's messaging tool
- "Custom Command" -- user-provided notification command

## Phase 3: Configuration

**Scope** -- `AskUserQuestion`, header "Scope":
- "Project" -- scripts in `./.prove/`, config in `.claude/.prove.json`
- "Global" -- scripts in `~/.claude/scripts/`

**Events** -- `AskUserQuestion`, header "Events" (multiSelect: true). Offer all reporter event types from `references/validation-config.md`: `step-complete`, `step-halted`, `wave-complete`, `execution-complete`, `review-approved`, `review-rejected`, `validation-pass`, `validation-fail`.

**Platform-specific details** (free-form):
- **Slack**: Webhook URL env var name (default `SLACK_WEBHOOK_URL`), channel override, mention preferences
- **Discord**: Webhook URL env var name (default `DISCORD_WEBHOOK_URL`), mention role
- **MCP**: Which MCP server and tool, channel/recipient
- **Custom**: Command to run, any env vars it needs

## Phase 4: Script Generation

Generate a bash script tailored to the user's platform and preferences.

Requirements:
- `#!/usr/bin/env bash`, POSIX-compatible
- Read reporter env vars (`PROVE_EVENT`, `PROVE_TASK`, `PROVE_STEP`, `PROVE_STATUS`, `PROVE_BRANCH`, `PROVE_DETAIL`) per `references/reporter-protocol.md`
- Format a human-readable message from those vars
- Support `--test` flag with dummy data
- Fail gracefully -- use `|| true` and trap so the orchestrator is never blocked
- Reference env vars for secrets; embed no URLs or tokens in the script

See `references/platforms.md` for platform-specific payload formats, curl patterns, and MCP invocation.

Write to `./.prove/notify-<platform>.sh` (project) or `~/.claude/scripts/notify-<platform>.sh` (global), then `chmod +x`.

## Phase 5: Config Update

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

## Phase 6: Verification

1. Run the script with `--test`
2. Report success or failure
3. Summarize: platform, scope, script path, subscribed events, config entry

## Committing

Delegate to the `commit` skill.

Example: `feat(notify-setup): add Slack webhook notification script`
