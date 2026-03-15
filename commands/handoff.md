---
description: Create a focused handoff prompt for clean conversation-level handoffs without context loss
argument-hint: "[optional: brief note about what to hand off]"
---

# Handoff: $ARGUMENTS

Create a focused handoff prompt so a fresh Claude Code session can pick up where this one left off.

Load and follow the handoff skill (`skills/handoff/SKILL.md` from the workflow plugin).

## Quick Start

1. **Gather context** deterministically from git state and prove artifacts
2. **Generate pickup note** (3-5 sentences on what to do next)
3. **Recommend an agent** (existing, create new, or general-purpose)
4. **Write** `.prove/handoff.md` and output the command to run

## Key Behaviors

- No user interview — gather context silently from artifacts
- Reference-heavy prompt (~100-200 lines) — point to files, don't inline
- Ephemeral — stale handoffs auto-deleted on next run
- Only LLM-generated part: the pickup note

## Do NOT

- Ask the user questions during handoff generation
- Inline full file contents into the handoff
- Skip the agent recommendation step
- Leave the handoff file larger than ~200 lines
