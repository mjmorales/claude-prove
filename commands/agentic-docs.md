---
description: Generate LLM-optimized documentation for agents, APIs, or modules
argument-hint: "[subject to document]"
---

# Agentic Docs

Generate machine-parseable, LLM-optimized documentation.

## Subject

$ARGUMENTS

## Instructions

Load and follow the agentic-doc-writer skill (`skills/agentic-doc-writer/SKILL.md` from the workflow plugin).

1. Identify subject type (agent, API, module, code)
2. Gather context efficiently (targeted reads)
3. Delegate to technical-writer agent with structured prompt
4. Validate output for contract completeness
