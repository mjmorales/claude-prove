---
description: "Run the orchestrator end-to-end: requirements -> plan -> parallel worktree execution -> merge"
---

# Full Auto

Run the orchestrator skill in full-auto mode to autonomously build a feature from idea to merged code.

## Feature

$ARGUMENTS

## Instructions

Load and follow the orchestrator skill (`skills/orchestrator/SKILL.md` from the workflow plugin).

1. Run the full-auto requirements gathering flow (PRD generation)
2. Execute all phases sequentially: Discover -> Plan -> Execute -> Track
3. Gate on user approval between phases
4. Use `isolation: "worktree"` for parallel task execution
5. Maintain PROGRESS.md throughout execution
6. On completion, present a summary and offer to create a PR
