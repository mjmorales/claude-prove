# Platform Reference -- Notification Scripts

## Slack Webhook

**Env var**: `SLACK_WEBHOOK_URL`

**Curl pattern**:
```bash
curl -sf -X POST "$SLACK_WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -d "$payload"
```

**Simple payload**:
```json
{"text": "Orchestrator: step-complete for task notify-setup-skill (step 2)"}
```

**Rich payload (blocks)**:
```json
{
  "blocks": [
    {
      "type": "header",
      "text": {"type": "plain_text", "text": "Orchestrator: Step Complete"}
    },
    {
      "type": "section",
      "fields": [
        {"type": "mrkdwn", "text": "*Task:*\nnotify-setup-skill"},
        {"type": "mrkdwn", "text": "*Step:*\n2"},
        {"type": "mrkdwn", "text": "*Status:*\ndone"},
        {"type": "mrkdwn", "text": "*Branch:*\norchestrator/notify-setup-skill"}
      ]
    }
  ]
}
```

**Notes**: Use emoji prefixes for status. Keep messages concise -- link to branch/logs. Returns `ok` with HTTP 200.

## Discord Webhook

**Env var**: `DISCORD_WEBHOOK_URL`

**Curl pattern**:
```bash
curl -sf -X POST "$DISCORD_WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -d "$payload"
```

**Simple payload**:
```json
{"content": "Orchestrator: step-complete for task notify-setup-skill (step 2)"}
```

**Rich payload (embeds)**:
```json
{
  "embeds": [{
    "title": "Orchestrator: Step Complete",
    "color": 3066993,
    "fields": [
      {"name": "Task", "value": "notify-setup-skill", "inline": true},
      {"name": "Step", "value": "2", "inline": true},
      {"name": "Status", "value": "done", "inline": true},
      {"name": "Branch", "value": "orchestrator/notify-setup-skill", "inline": false}
    ]
  }]
}
```

**Color codes**: `step-complete`: 3066993 (green), `step-halted`: 15158332 (red), `needs-input`: 15844367 (yellow), `execution-complete`: 3447003 (blue).

**Notes**: 2000-char limit for `content`. Embeds support up to 25 fields. Returns HTTP 204 (no body).

## MCP Integration

**Detection**: MCP servers in `.claude/settings.json` or `~/.claude/settings.json` under `mcpServers`:
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

**Common MCP servers**: `@anthropic/slack-mcp`, `@modelcontextprotocol/server-slack` (provides `send_message`). Look for tool names containing `send`, `post`, `notify`, or `message`.

**Script pattern for MCP**: MCP tools cannot be called from bash directly. Generate a script that formats the payload as JSON, documents which MCP server/tool to use, and falls back to printing formatted JSON to stdout:
```bash
#!/usr/bin/env bash
# MCP Integration: slack / send_message
# Orchestrator should invoke the MCP tool directly when possible.
# Fallback: prints formatted JSON to stdout.
# ... format message from env vars ...
echo "$payload"
```

## Custom Command

Wrap user-provided commands with env var passthrough and error handling:
```bash
#!/usr/bin/env bash
set -uo pipefail

message="[${PROVE_EVENT:-unknown}] Task: ${PROVE_TASK:-unknown} | Step: ${PROVE_STEP:-?} | Status: ${PROVE_STATUS:-unknown} | Branch: ${PROVE_BRANCH:-unknown}"

<user-command> "$message" || {
  echo "Warning: notification command failed (exit $?)" >&2
  exit 0  # Don't crash the orchestrator
}
```

Pass formatted message as first argument. Export all `PROVE_*` env vars. Always wrap in error handling -- custom commands are untrusted.
