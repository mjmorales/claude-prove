---
name: craft-prompt
description: Generate optimized LLM prompts using research-backed prompt engineering. Delegates to the llm-prompt-engineer agent. Use when the user wants to create a new prompt, system instruction, or agent definition from scratch. Triggers on "craft a prompt", "write a prompt", "generate a system prompt", "create an agent prompt", "prompt for", or any request to produce a new LLM prompt.
---

# Craft Prompt

Delegate to the `llm-prompt-engineer` agent to generate an optimized prompt from a user's requirements.

## Before Delegating

Gather these inputs from the user (ask if missing):

1. **Target model** -- which LLM will consume this prompt (Claude, GPT, open-source, general-purpose)
2. **Task type** -- classification, generation, analysis, agent behavior, system prompt, etc.
3. **Output expectations** -- what a successful response looks like
4. **Constraints** -- token budget, latency, cost sensitivity, safety requirements
5. **Consumption context** -- one-shot prompt, system instruction, or agent definition

Do NOT delegate until intent and constraints are clear.

## Delegation Instructions

Pass the gathered requirements to `llm-prompt-engineer` with these directives:

1. Research the target model's prompting best practices using WebSearch/WebFetch before generating
2. Apply all relevant optimization techniques from your expertise
3. Embed brief inline comments in the generated prompt explaining key design choices (e.g., `<!-- Primacy effect: critical constraint placed first -->`)
4. Present the result with:
   - **Techniques applied** -- each technique used and why
   - **Research citations** -- references supporting key decisions
   - **Token estimate** -- approximate token count
   - **Trade-offs** -- what was optimized for vs deprioritized

## After Generation

Ask the user if they want to:
- Iterate on specific sections
- Adjust the token-efficiency vs clarity balance
- Add or remove techniques
- Test with example inputs

If the user provides a file path, write the final prompt there. Otherwise, output directly.
