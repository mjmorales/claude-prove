# Notification Script Examples

Complete, copy-paste-ready scripts for each platform.

## Slack Webhook

```bash
#!/usr/bin/env bash
set -uo pipefail

# Slack notification reporter for prove orchestrator events.
# Required env: SLACK_WEBHOOK_URL

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
# Required env: DISCORD_WEBHOOK_URL

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

## Slack Night Thread

One Slack thread per night: `nightshift-enabled` posts the opener and persists its `ts`; every later night event replies in that thread; `morning-digest` broadcasts its reply back to the channel. Threading needs `chat.postMessage` (a bot token with `chat:write`) — incoming webhooks cannot thread.

```bash
#!/usr/bin/env bash
set -uo pipefail

# Slack night-thread reporter for prove night-shift events.
# Required env: SLACK_BOT_TOKEN (xoxb-*, chat:write), SLACK_CHANNEL_ID
# Thread state: .prove/nightshift/slack-thread.json (reporters run from the
# project root; the file lives beside the night's engine state and dies with it)

# --- Test mode ---
if [[ "${1:-}" == "--test" ]]; then
  export PROVE_EVENT="${PROVE_EVENT:-nightshift-enabled}"
  export PROVE_TASK="example-task"
  export PROVE_STATUS="test"
  export PROVE_DETAIL="Test night event from notify test"
fi

# --- Validate credentials ---
if [[ -z "${SLACK_BOT_TOKEN:-}" || -z "${SLACK_CHANNEL_ID:-}" ]]; then
  echo "ERROR: SLACK_BOT_TOKEN and SLACK_CHANNEL_ID must be set." >&2
  exit 1
fi

THREAD_FILE=".prove/nightshift/slack-thread.json"
EVENT="${PROVE_EVENT:-unknown}"

# --- Pick emoji by night event ---
case "$EVENT" in
  nightshift-enabled) emoji="🌙" ;;
  task-landed)        emoji="✅" ;;
  heal-attempt)       emoji="🔧" ;;
  task-parked)        emoji="⚠️" ;;
  trunk-red)          emoji="🔴" ;;
  halted)             emoji="🛑" ;;
  morning-digest)     emoji="☀️" ;;
  *)                  emoji="📋" ;;
esac

# --- Build message ---
message="${emoji} *night shift* | \`${EVENT}\`"
[[ -n "${PROVE_TASK:-}" ]] && message+="\n*Task*: ${PROVE_TASK}"
[[ -n "${PROVE_DETAIL:-}" ]] && message+="\n${PROVE_DETAIL}"

# --- Thread routing ---
# Opener starts a fresh thread; everything else replies into the saved one.
# A missing thread file degrades to an un-threaded channel message — never
# drop an event over lost state.
thread_args=""
if [[ "$EVENT" == "nightshift-enabled" ]]; then
  rm -f "$THREAD_FILE"
elif [[ -f "$THREAD_FILE" ]]; then
  thread_ts=$(sed -n 's/.*"thread_ts":"\([0-9.]*\)".*/\1/p' "$THREAD_FILE" | head -1)
  [[ -n "$thread_ts" ]] && thread_args=", \"thread_ts\": \"${thread_ts}\""
  [[ "$EVENT" == "morning-digest" && -n "$thread_ts" ]] && thread_args+=", \"reply_broadcast\": true"
fi

payload=$(printf '{"channel": "%s", "text": "%s"%s}' \
  "$SLACK_CHANNEL_ID" "$message" "$thread_args")

# --- Post via chat.postMessage ---
response=$(curl -s -X POST \
  -H "Authorization: Bearer ${SLACK_BOT_TOKEN}" \
  -H "Content-Type: application/json; charset=utf-8" \
  -d "$payload" \
  "https://slack.com/api/chat.postMessage")

if [[ "$response" != *'"ok":true'* ]]; then
  echo "ERROR: Slack chat.postMessage failed: ${response}" >&2
  exit 1
fi

# --- Persist the opener's ts as the night's thread anchor ---
if [[ "$EVENT" == "nightshift-enabled" ]]; then
  ts=$(printf '%s' "$response" | sed -n 's/.*"ts":"\([0-9.]*\)".*/\1/p' | head -1)
  if [[ -n "$ts" ]]; then
    mkdir -p .prove/nightshift
    printf '{"thread_ts":"%s","channel":"%s"}\n' "$ts" "$SLACK_CHANNEL_ID" > "$THREAD_FILE"
  fi
fi

echo "Slack night notification sent (${EVENT})"
```

## Custom Command

```bash
#!/usr/bin/env bash
set -uo pipefail

# Custom command notification reporter for prove orchestrator events.
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
