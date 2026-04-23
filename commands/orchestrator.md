---
description: Autonomous task orchestrator — dispatches autopilot (plan exists) or full-auto (PRD-first) modes
argument-hint: "[--autopilot [plan-id] | --full [desc]]"
core: true
summary: Unified entry point for orchestrator, autopilot, and full-auto execution
---

# Orchestrator: $ARGUMENTS

Load and follow the orchestrator skill (`skills/orchestrator/SKILL.md`). Pass `$ARGUMENTS` through to its **Mode Dispatch** section, which resolves the invocation mode (`--autopilot`, `--full`, or auto-detect) and routes to the correct entry phase.
