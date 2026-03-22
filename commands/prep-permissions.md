---
description: Configure Claude Code permissions (.claude/settings.local.json) for the active task's toolchain
argument-hint: "[autopilot|full-auto|plan|implement]"
---

# Prep Permissions

Invoke the `prep-permissions` skill from `skills/prep-permissions/SKILL.md`.

Pass `$ARGUMENTS` as the workflow hint:
- **autopilot / full-auto**: Include orchestrator-specific rules (Agent permissions, prove scripts)
- **plan**: Minimal read-only plus git basics
- **implement**: Build/test/lint rules, skip orchestrator agent rules
- No argument: analyze the task plan and infer scope
