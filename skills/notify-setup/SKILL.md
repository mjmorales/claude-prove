---
name: notify-setup
description: >
  Set up notification integrations for Claude Code orchestrator events. Dynamically generates
  notification scripts for Slack, Discord, or custom platforms using LLM-driven generation.
  Reuses existing MCP servers and integrations. Use when setting up notifications for
  orchestrator progress, permission needs, or stuck tasks. Triggers on "notify setup",
  "set up notifications", "configure alerts".
---

# Notify Setup

Set up notification integrations so the orchestrator can report progress, failures, and permission needs to external platforms.

**Interaction patterns**: See `references/interaction-patterns.md` for when to use `AskUserQuestion` vs free-form discussion.

## Workflow

### Phase 1: Discovery

Scan for existing integrations before asking the user to configure anything manually.

1. Read `.claude/settings.json` and `~/.claude/settings.json` for MCP servers that might provide messaging capabilities (Slack MCP, Discord MCP, etc.)
2. Check the environment for common notification variables:
   - `SLACK_WEBHOOK_URL`
   - `DISCORD_WEBHOOK_URL`
3. Check existing `.prove.json` for reporters already configured
4. Report what was found — list detected MCP servers, env vars, and existing reporters
5. If an existing reporter already covers the user's needs, say so and ask whether to proceed

### Phase 2: Platform Selection

Use `AskUserQuestion` with header "Platform":

- "Slack (Webhook)" — posts to a Slack channel via `SLACK_WEBHOOK_URL` env var and curl
- "Discord (Webhook)" — posts to a Discord channel via `DISCORD_WEBHOOK_URL` env var and curl
- "MCP Integration" — reuses an existing MCP server's messaging tool (list detected servers if any)
- "Custom Command" — user provides their own notification command

If discovery found specific integrations, note them in the option descriptions (e.g., "Slack (Webhook) — SLACK_WEBHOOK_URL detected").

### Phase 3: Configuration

Gather platform-specific details through a series of questions.

**Scope** — use `AskUserQuestion` with header "Scope":
- "Project" — scripts in `./.prove/`, config in `.prove.json`
- "Global" — scripts in `~/.claude/scripts/`, mentioned in output for manual wiring

**Events** — use `AskUserQuestion` with header "Events" (multiSelect: true):
- "Step Complete" — when an orchestrator step finishes successfully
- "Step Halted" — when something fails or gets stuck
- "Wave Complete" — when a parallel wave of tasks finishes (full mode only)
- "Execution Complete" — when the full run finishes
- "Review Approved" — when the principal architect approves a task
- "Review Rejected" — when the principal architect requests changes
- "Validation Pass" — when an LLM validation check passes
- "Validation Fail" — when an LLM validation check fails

**Platform-specific details** (free-form questions):
- **Slack**: Webhook URL env var name (default `SLACK_WEBHOOK_URL`), channel override, mention preferences
- **Discord**: Webhook URL env var name (default `DISCORD_WEBHOOK_URL`), mention role
- **MCP**: Which MCP server and tool to invoke, channel/recipient
- **Custom**: The command to run, any additional env vars it needs

### Phase 4: Script Generation

Dynamically generate a bash notification script based on the gathered configuration. Do NOT use static templates — tailor each script to the user's specific platform and preferences.

The generated script MUST:
- Be POSIX-compatible bash (`#!/usr/bin/env bash`)
- Read reporter env vars: `PROVE_EVENT`, `PROVE_TASK`, `PROVE_STEP`, `PROVE_STATUS`, `PROVE_BRANCH`, `PROVE_DETAIL`
- Format a human-readable message from those vars
- Support a `--test` flag that sends a sample notification with dummy data
- Handle errors gracefully — non-zero exit should not crash the orchestrator (use `|| true` patterns, trap errors)
- NEVER embed secrets directly — reference env vars for webhook URLs and tokens

Platform-specific generation guidance:
- **Slack webhook**: Use curl to POST JSON payload to `$SLACK_WEBHOOK_URL`. See `references/platforms.md` for payload format.
- **Discord webhook**: Use curl to POST Discord-formatted JSON to `$DISCORD_WEBHOOK_URL`. See `references/platforms.md` for embed format.
- **MCP Integration**: Generate a script that documents how to invoke the MCP tool, or wraps the `claude` CLI if applicable. See `references/platforms.md` for MCP patterns.
- **Custom Command**: Wrap the user's command with env var formatting and error handling.

After generation:
1. Write the script to the appropriate location (`./.prove/notify-<platform>.sh` or `~/.claude/scripts/notify-<platform>.sh`)
2. Run `chmod +x` on the script

### Phase 5: .prove.json Update

Update `.prove.json` with the new reporter entry.

1. Read existing `.prove.json` (create if it doesn't exist)
2. Add or update the `reporters` array with the new reporter:
   ```json
   {
     "name": "<platform>-notify",
     "command": "./.prove/notify-<platform>.sh",
     "events": ["step-complete", "step-halted", "execution-complete"]
   }
   ```
3. Preserve existing validators, reporters, and other config — only touch the reporters array
4. Map the user's event selections to the event slugs:
   - "Step Complete" -> `step-complete`
   - "Step Halted" -> `step-halted`
   - "Wave Complete" -> `wave-complete`
   - "Execution Complete" -> `execution-complete`
   - "Review Approved" -> `review-approved`
   - "Review Rejected" -> `review-rejected`
   - "Validation Pass" -> `validation-pass`
   - "Validation Fail" -> `validation-fail`

### Phase 6: Verification

Test the setup and report results.

1. Run the generated script with the `--test` flag
2. Report success or failure
3. Show a summary of what was configured:
   - Platform and scope
   - Script location
   - Events subscribed to
   - Reporter entry added to `.prove.json`

## Reporter Environment Variables

Scripts generated by this skill receive these env vars from the orchestrator:

| Variable | Description | Example |
|----------|-------------|---------|
| PROVE_EVENT | Event type | step-complete, review-approved, validation-fail |
| PROVE_TASK | Task slug | notify-setup-skill |
| PROVE_STEP | Step number | 1, 2, 3 |
| PROVE_STATUS | Current status | done, HALTED, In Progress |
| PROVE_BRANCH | Branch name | orchestrator/notify-setup-skill |
| PROVE_DETAIL | One-line summary | "3 findings in 2 files", "APPROVED after 1 round" |

## Committing

When the user asks to commit notification scripts or config changes, delegate to the `commit` skill. Do not create ad-hoc commits. The commit skill reads `.prove.json` scopes for valid commit scopes and uses conventional commit format.

Example: `feat(notify-setup): add Slack webhook notification script`

## Rules

- ALWAYS run discovery before asking the user to configure manually.
- ALWAYS generate scripts dynamically — do not use static templates.
- NEVER store secrets (webhook URLs, tokens) in generated scripts — use environment variables.
- PREFER reusing existing MCP servers over creating new webhook integrations.
- PREFER project scope unless the user explicitly wants global.
