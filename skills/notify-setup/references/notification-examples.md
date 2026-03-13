# Notification Script Examples

Reference examples for generating notification scripts during the notify-setup skill workflow. Each script is complete and copy-paste-ready.

## Slack Webhook

```bash
#!/usr/bin/env bash
set -uo pipefail

# Slack notification reporter for prove orchestrator events.
# Reads event data from PROVE_* environment variables and posts to Slack.
#
# Required env: SLACK_WEBHOOK_URL
# Set via: export SLACK_WEBHOOK_URL="https://hooks.slack.com/services/T.../B.../..."

# --- Test mode ---
if [[ "${1:-}" == "--test" ]]; then
  export PROVE_EVENT="test"
  export PROVE_TASK="example-task"
  export PROVE_STEP="1"
  export PROVE_STATUS="complete"
  export PROVE_BRANCH="workflow/example-task"
fi

# --- Validate webhook URL ---
if [[ -z "${SLACK_WEBHOOK_URL:-}" ]]; then
  echo "ERROR: SLACK_WEBHOOK_URL is not set." >&2
  echo "Set it with: export SLACK_WEBHOOK_URL=\"https://hooks.slack.com/services/...\"" >&2
  exit 1
fi

# --- Pick emoji by status ---
case "${PROVE_STATUS:-unknown}" in
  complete)    emoji="✅" ;;
  halted)      emoji="⚠️" ;;
  needs-input) emoji="🔔" ;;
  in_progress) emoji="🔄" ;;
  *)           emoji="📋" ;;
esac

# --- Build message ---
message="${emoji} *prove* | \`${PROVE_EVENT:-unknown}\`"
message+="\n*Task*: ${PROVE_TASK:-unknown}"
[[ -n "${PROVE_STEP:-}" ]] && message+=" (step ${PROVE_STEP})"
message+="\n*Status*: ${PROVE_STATUS:-unknown}"
message+="\n*Branch*: \`${PROVE_BRANCH:-unknown}\`"

# --- Post to Slack ---
payload=$(printf '{"text": "%s"}' "$message")

http_code=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST \
  -H "Content-Type: application/json" \
  -d "$payload" \
  "$SLACK_WEBHOOK_URL")

if [[ "$http_code" -ge 200 && "$http_code" -lt 300 ]]; then
  echo "Slack notification sent (HTTP ${http_code})"
else
  echo "ERROR: Slack returned HTTP ${http_code}" >&2
  exit 1
fi
```

## Discord Webhook

```bash
#!/usr/bin/env bash
set -uo pipefail

# Discord notification reporter for prove orchestrator events.
# Posts rich embeds to a Discord webhook.
#
# Required env: DISCORD_WEBHOOK_URL
# Set via: export DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/..."

# --- Test mode ---
if [[ "${1:-}" == "--test" ]]; then
  export PROVE_EVENT="test"
  export PROVE_TASK="example-task"
  export PROVE_STEP="1"
  export PROVE_STATUS="complete"
  export PROVE_BRANCH="workflow/example-task"
fi

# --- Validate webhook URL ---
if [[ -z "${DISCORD_WEBHOOK_URL:-}" ]]; then
  echo "ERROR: DISCORD_WEBHOOK_URL is not set." >&2
  echo "Set it with: export DISCORD_WEBHOOK_URL=\"https://discord.com/api/webhooks/...\"" >&2
  exit 1
fi

# --- Pick color by status (decimal) ---
case "${PROVE_STATUS:-unknown}" in
  complete)    color=3066993  ;;  # green
  halted)      color=15158332 ;;  # red
  needs-input) color=16776960 ;;  # yellow
  in_progress) color=3447003  ;;  # blue
  *)           color=9807270  ;;  # grey
esac

# --- Build description ---
description="**Task**: ${PROVE_TASK:-unknown}"
[[ -n "${PROVE_STEP:-}" ]] && description+="\n**Step**: ${PROVE_STEP}"
description+="\n**Status**: ${PROVE_STATUS:-unknown}"
description+="\n**Branch**: \`${PROVE_BRANCH:-unknown}\`"

# --- Build JSON payload with embed ---
payload=$(cat <<ENDJSON
{
  "embeds": [
    {
      "title": "prove — ${PROVE_EVENT:-unknown}",
      "description": "${description}",
      "color": ${color}
    }
  ]
}
ENDJSON
)

# --- Post to Discord ---
http_code=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST \
  -H "Content-Type: application/json" \
  -d "$payload" \
  "$DISCORD_WEBHOOK_URL")

if [[ "$http_code" -ge 200 && "$http_code" -lt 300 ]]; then
  echo "Discord notification sent (HTTP ${http_code})"
else
  echo "ERROR: Discord returned HTTP ${http_code}" >&2
  exit 1
fi
```

## Custom Command

```bash
#!/usr/bin/env bash
set -uo pipefail

# Custom command notification reporter for prove orchestrator events.
# Delegates to a user-provided command ($NOTIFY_COMMAND), passing a
# formatted message as the first argument.
#
# Optional env: NOTIFY_COMMAND (falls back to echo)

# --- Test mode ---
if [[ "${1:-}" == "--test" ]]; then
  export PROVE_EVENT="test"
  export PROVE_TASK="example-task"
  export PROVE_STEP="1"
  export PROVE_STATUS="complete"
  export PROVE_BRANCH="workflow/example-task"
fi

# --- Build message ---
message="[prove] ${PROVE_EVENT:-unknown}"
message+=" | task=${PROVE_TASK:-unknown}"
[[ -n "${PROVE_STEP:-}" ]] && message+=" step=${PROVE_STEP}"
message+=" | status=${PROVE_STATUS:-unknown}"
message+=" | branch=${PROVE_BRANCH:-unknown}"

# --- Dispatch ---
cmd="${NOTIFY_COMMAND:-echo}"

if ! command -v "$cmd" &>/dev/null && [[ "$cmd" != "echo" ]]; then
  echo "ERROR: NOTIFY_COMMAND '${cmd}' not found on PATH." >&2
  exit 1
fi

$cmd "$message"
```
