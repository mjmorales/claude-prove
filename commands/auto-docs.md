---
description: Generate human-readable and LLM-optimized documentation for the current session or a specified scope
argument-hint: "[topic, directory, or files — defaults to session context]"
---

# Auto Docs

Generate both human and agent documentation in one pass.

## Scope

$ARGUMENTS

## Instructions

Load and follow the auto-docs skill (`skills/auto-docs/SKILL.md` from the workflow plugin).

1. Resolve scope (session context, topic, directory, or files)
2. Analyze subjects and classify what needs documenting
3. Recommend doc types (human, agent, or both) and confirm with user
4. Delegate to docs-writer and/or agentic-doc-writer skills
5. Review generated documentation with user
