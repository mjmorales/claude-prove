---
name: prep-permissions
description: Analyze active task and configure Claude Code permissions for smooth execution
argument-hint: "[autopilot|full-auto|plan|implement]"
allowed_tools: Bash, Read, Write, Edit, Glob, Grep
---

# Prep Permissions

Analyze the active task plan and project toolchain, then configure `.claude/settings.local.json` with appropriate permissions so you can run prove workflows without constant approval prompts.

## Instructions

Invoke the `prep-permissions` skill from `skills/prep-permissions/SKILL.md`.

If `$ARGUMENTS` is provided, use it as a hint for which workflow the user plans to run:
- **autopilot** or **full-auto**: Include orchestrator-specific rules (Agent permissions, prove scripts)
- **plan**: Minimal rules — mostly read-only plus git basics
- **implement**: Include build/test/lint rules but skip orchestrator agent rules

If no argument, analyze the task plan and infer the appropriate scope.
