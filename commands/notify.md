---
description: Configure or test orchestrator notification reporters (Slack, Discord, MCP, custom)
argument-hint: "<setup|test> [args]"
---

# Notify

**Arguments**: $ARGUMENTS

Load and execute the notify skill (`skills/notify/SKILL.md`).

- `setup [platform]` — configure a reporter; generates a bash script in `./.prove/` (or `~/.claude/scripts/`) and registers it in `.claude/.prove.json`. Platforms: `slack`, `discord`, `mcp`, `custom`.
- `test [--reporter <name>] [event-type]` — send a test notification through configured reporters. Defaults to event `step-complete` and all reporters.
- No args — the skill prompts for Setup vs Test via `AskUserQuestion`.
