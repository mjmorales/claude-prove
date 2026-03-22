# Craft Prompt Skill

Generate a maximally LLM-optimized prompt using cutting-edge research and prompt engineering best practices.

## Workflow

Delegate to the `llm-prompt-engineer` agent with the following phases:

### Phase 1: Understand Intent

1. Read the user's input carefully. Identify:
   - **Target model**: Which LLM will consume this prompt? (Claude, GPT, open-source, general-purpose)
   - **Task type**: Classification, generation, analysis, instruction-following, agent behavior, system prompt, etc.
   - **Output expectations**: What does a successful response look like?
   - **Constraints**: Token budget, latency, cost sensitivity, safety requirements

2. If the input is ambiguous or underspecified, ask the user to clarify:
   - Who/what will consume this prompt (model, agent framework, API)
   - Expected input/output format
   - Edge cases or failure modes to handle
   - Whether this is a one-shot prompt, system instruction, or agent definition

Do NOT proceed to generation until you have a clear picture of intent and constraints.

### Phase 2: Research

3. Use `/find-docs` to fetch the latest prompting techniques relevant to this task type:
   - Check the target model provider's prompt engineering documentation
   - Search for recent papers or blog posts on relevant techniques
   - Review model-specific best practices for the target LLM

4. Identify which techniques apply:
   - Chain-of-thought / step-by-step reasoning
   - Few-shot examples vs zero-shot
   - Role anchoring and persona priming
   - Structured output formatting
   - Constitutional / self-checking patterns
   - Meta-cognitive cues
   - Instruction hierarchy and attention optimization

### Phase 3: Generate

5. Write the optimized prompt applying all relevant techniques. For each design choice, include a brief inline comment explaining the reasoning (e.g., `<!-- Primacy effect: critical constraint placed first -->`).

6. Present the prompt with:
   - **Techniques applied**: List each technique used and why
   - **Research citations**: Links or references supporting key decisions
   - **Token estimate**: Approximate token count of the generated prompt
   - **Trade-offs**: What was optimized for, what was deprioritized, and why

### Phase 4: Refine

7. Ask the user if they want to:
   - Iterate on specific sections
   - Optimize further for token efficiency vs clarity
   - Add/remove techniques
   - Test with example inputs

8. If the user provides a file path, write the final prompt to that location. Otherwise, output it directly.
