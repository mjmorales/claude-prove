---
name: prompting-craft
description: Generate optimized LLM prompts using the bundled prompt engineering guide and optional research. Delegates to the llm-prompt-engineer agent. Use when the user wants to create a new prompt, system instruction, or agent definition from scratch. Triggers on "craft a prompt", "write a prompt", "generate a system prompt", "create an agent prompt", "prompt for", or any request to produce a new LLM prompt.
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

## Research Mode

Check if the user passed `--research` or explicitly asked for live research.

- **Default (no flag):** Tell the agent to use the bundled `references/prompt-engineering-guide.md` and any cached research. Do NOT use WebSearch/WebFetch.
- **`--research` flag or user request:** Tell the agent to research using WebSearch/WebFetch, then cache the results for future use.
- **Agent-detected gap:** If the agent determines the bundled guide and cache don't cover the ask (e.g., niche model, specialized technique), it should ask the user before researching.

## Delegation Instructions

Pass the gathered requirements to `llm-prompt-engineer` with these directives:

1. Read the bundled prompt engineering guide (`references/prompt-engineering-guide.md`)
2. Check the prompt research cache in priority order -- later tiers override earlier: plugin (`cache/prompting/` in plugin dir), global (`~/.claude/cache/prompting/`), project (`.prove/cache/prompting/`)
3. Apply research mode (default: guide + cache only; `--research`: live web research, cache results)
4. Apply all relevant optimization techniques
5. Embed brief inline comments in the generated prompt explaining key design choices (e.g., `<!-- Primacy effect: critical constraint placed first -->`)
6. Present the result with:
   - **Techniques applied** -- each technique used and why
   - **Guide sections referenced** -- which parts of the bundled guide informed the design
   - **Token estimate** -- approximate token count
   - **Trade-offs** -- what was optimized for vs deprioritized

## After Generation

Ask the user if they want to:
- Iterate on specific sections
- Adjust the token-efficiency vs clarity balance
- Add or remove techniques
- Test with example inputs
- Research a specific aspect they want to improve (`--research`)

If the user provides a file path, write the final prompt there. Otherwise, output directly.
