# Platform Reference — Notification Script Generation

This document provides platform-specific guidance for dynamically generating notification scripts. Use these details as context when generating scripts in Phase 4, but adapt formatting and payloads to the user's specific needs.

## Slack Webhook

**Env var**: `SLACK_WEBHOOK_URL`

**Curl command pattern**:
```bash
curl -sf -X POST "$SLACK_WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -d "$payload"
```

**Simple text payload**:
```json
{
  "text": "Orchestrator: step-complete for task notify-setup-skill (step 2)"
}
```

**Rich payload with blocks** (preferred for readability):
```json
{
  "blocks": [
    {
      "type": "header",
      "text": {
        "type": "plain_text",
        "text": "Orchestrator: Step Complete"
      }
    },
    {
      "type": "section",
      "fields": [
        { "type": "mrkdwn", "text": "*Task:*\nnotify-setup-skill" },
        { "type": "mrkdwn", "text": "*Step:*\n2" },
        { "type": "mrkdwn", "text": "*Status:*\ndone" },
        { "type": "mrkdwn", "text": "*Branch:*\norchestrator/notify-setup-skill" }
      ]
    }
  ]
}
```

**Formatting notes**:
- Use emoji prefixes to convey status at a glance: checkmark for complete, warning for halted, bell for needs-input, flag for execution-complete
- Keep messages concise — link to branch or logs rather than including full output
- Slack webhooks return `ok` on success with HTTP 200

## Discord Webhook

**Env var**: `DISCORD_WEBHOOK_URL`

**Curl command pattern**:
```bash
curl -sf -X POST "$DISCORD_WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -d "$payload"
```

**Simple payload**:
```json
{
  "content": "Orchestrator: step-complete for task notify-setup-skill (step 2)"
}
```

**Rich payload with embeds** (preferred):
```json
{
  "embeds": [
    {
      "title": "Orchestrator: Step Complete",
      "color": 3066993,
      "fields": [
        { "name": "Task", "value": "notify-setup-skill", "inline": true },
        { "name": "Step", "value": "2", "inline": true },
        { "name": "Status", "value": "done", "inline": true },
        { "name": "Branch", "value": "orchestrator/notify-setup-skill", "inline": false }
      ]
    }
  ]
}
```

**Color codes by event**:
- `step-complete`: `3066993` (green)
- `step-halted`: `15158332` (red)
- `needs-input`: `15844367` (yellow/gold)
- `execution-complete`: `3447003` (blue)

**Formatting notes**:
- Discord webhook payloads have a 2000-character limit for `content`
- Embeds support up to 25 fields
- Discord returns HTTP 204 on success (no body)

## MCP Integration

**Detection**: MCP servers are configured in `.claude/settings.json` or `~/.claude/settings.json` under the `mcpServers` key:
```json
{
  "mcpServers": {
    "slack": {
      "command": "npx",
      "args": ["-y", "@anthropic/slack-mcp"]
    }
  }
}
```

**Common messaging MCP servers**:
- `@anthropic/slack-mcp` or `@modelcontextprotocol/server-slack` — provides `send_message` tool
- Custom MCP servers with messaging tools — look for tool names containing `send`, `post`, `notify`, or `message`

**Invocation patterns**:
MCP tools cannot be called directly from bash scripts in the same way as webhooks. For MCP-based notifications, generate a script that:
1. Documents which MCP server and tool to use
2. Formats the message payload as JSON
3. Explains that the orchestrator should invoke the MCP tool directly when available
4. Falls back to printing a formatted message to stdout if MCP invocation is not possible from a script context

**Example documentation in script**:
```bash
#!/usr/bin/env bash
# MCP Integration: slack / send_message
# This script formats the notification payload.
# The orchestrator should invoke the MCP tool directly when possible.
# Fallback: prints formatted JSON to stdout for manual piping.

# ... format message from env vars ...
echo "$payload"
```

## Custom Command

For user-provided commands, wrap them with env var passthrough and error handling.

**Pattern**:
```bash
#!/usr/bin/env bash
set -euo pipefail

# Format message from orchestrator env vars
message="[${PROVE_EVENT:-unknown}] Task: ${PROVE_TASK:-unknown} | Step: ${PROVE_STEP:-?} | Status: ${PROVE_STATUS:-unknown} | Branch: ${PROVE_BRANCH:-unknown}"

# Run user's custom command with message as argument
<user-command> "$message" || {
  echo "Warning: notification command failed (exit $?)" >&2
  exit 0  # Don't crash the orchestrator
}
```

**Guidelines**:
- Pass the formatted message as the first argument to the custom command
- Also export all `PROVE_*` env vars so the command can access them directly
- Always wrap in error handling — custom commands are untrusted
- Support both commands that take a message argument and commands that read env vars

## Message Templates

Use these as a starting point when formatting notification messages. Adapt to the platform's formatting capabilities.

### Step Complete
```
Task: {PROVE_TASK} — Step {PROVE_STEP} complete
Status: {PROVE_STATUS}
Branch: {PROVE_BRANCH}
```

### Step Halted
```
Task: {PROVE_TASK} — Step {PROVE_STEP} HALTED
Status: {PROVE_STATUS}
Branch: {PROVE_BRANCH}
Action required: check logs and resolve the issue.
```

### Needs Input
```
Task: {PROVE_TASK} — Step {PROVE_STEP} needs input
The orchestrator is waiting for user approval or permissions.
Branch: {PROVE_BRANCH}
```

### Execution Complete
```
Task: {PROVE_TASK} — Execution complete
Final status: {PROVE_STATUS}
Branch: {PROVE_BRANCH}
```
