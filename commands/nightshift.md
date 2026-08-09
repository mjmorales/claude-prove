---
description: Enable, disable, or inspect the overnight scrum-drain driver (night shift)
argument-hint: "<on|off|status> [--milestone <m>] [--deadline HH:MM]"
core: true
summary: Operate night shift — the opt-in overnight driver that drains a milestone through the merge queue
---

# Nightshift

**Arguments**: $ARGUMENTS

Load and follow the nightshift skill at `skills/nightshift/SKILL.md`.

- `on --milestone <m> [--deadline HH:MM] [--task-cap N] [--max-heals N] [--max-parked N]` — preflight, prep permissions, open the night, arm the tick cron + caffeinate, announce to reporters.
- `off` — delete the cron, kill caffeinate, post the morning digest, close the night.
- `status` — night state, floors, lease freshness, ledger timeline.
- No args — the skill prompts for On vs Off vs Status via `AskUserQuestion`.
