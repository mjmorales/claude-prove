---
description: "Run the orchestrator end-to-end: requirements -> plan -> parallel worktree execution -> merge"
---

# Full Auto

Run the orchestrator skill in full-auto mode to autonomously build a feature from idea to merged code.

## Feature

$ARGUMENTS

## Instructions

Load and follow the orchestrator skill (`skills/orchestrator/SKILL.md` from the workflow plugin).

1. Derive slug from feature name and create `.prove/runs/<slug>/` **before** writing any artifacts
2. Write PRD and TASK_PLAN directly to `.prove/runs/<slug>/` (not to `.prove/` global)
3. Gate on user approval between phases using `AskUserQuestion` (Approve / Request Changes)
4. Create orchestrator worktree (`.claude/worktrees/orchestrator-<slug>`) — does not touch the main worktree
5. Use `scripts/manage-worktree.sh` for parallel sub-task worktrees (namespaced per slug to prevent collisions)
6. Maintain `.prove/runs/<slug>/PROGRESS.md` throughout execution
7. On completion, present a summary and offer to create a PR
