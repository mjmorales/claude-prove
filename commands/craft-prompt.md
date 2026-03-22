---
description: Generate a hyper-optimized LLM prompt from a description or goal. Researches techniques, asks clarifying questions, and produces a research-backed prompt.
argument-hint: "[prompt goal or description]"
---

# Craft Prompt

Generate a maximally LLM-optimized prompt using cutting-edge research and prompt engineering best practices.

## Input

$ARGUMENTS

## Instructions

Load and follow the craft-prompt skill (`skills/craft-prompt/SKILL.md` from the workflow plugin).

1. Determine mode from arguments:
   - Description or goal provided — proceed with prompt generation
   - No arguments — ask the user what prompt they want to create
2. Gather context and confirm scope
3. Delegate to the `llm-prompt-engineer` agent
4. Review and present the output
