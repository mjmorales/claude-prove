---
description: Task-lifecycle dispatcher — handoff, pickup, progress, complete, cleanup
argument-hint: "<handoff|pickup|progress|complete|cleanup> [slug]"
---

# Task: $ARGUMENTS

Load and follow the task skill (`skills/task/SKILL.md`).

Pass `$ARGUMENTS` through verbatim. The skill dispatches on the first token
(`handoff` | `pickup` | `progress` | `complete` | `cleanup`); remaining tokens
are the slug/note for that subcommand. With no args, the skill prints its
routing table and exits.
