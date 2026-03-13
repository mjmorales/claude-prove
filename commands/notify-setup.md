---
description: Set up notification integrations for orchestrator events (Slack, Discord, SMS, custom)
argument-hint: "[platform]"
---

# Notify Setup

Set up notifications so you get alerted when the orchestrator completes steps, gets stuck, or needs your input.

## Platform

$ARGUMENTS

## Instructions

Load and follow the notify-setup skill (`skills/notify-setup/SKILL.md` from the workflow plugin).

1. Run the Discovery phase to detect existing integrations
2. If a platform was specified in `$ARGUMENTS`, skip platform selection and use it directly
3. Otherwise, guide the user through interactive platform selection
4. Gather configuration (scope, events, platform-specific settings)
5. Generate the notification script using LLM-driven generation
6. Update `.prove.json` with the reporter configuration
7. Run verification to test the notification pipeline
