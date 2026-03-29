# Prompt Engineering Guide

Comprehensive reference for LLM prompt optimization. Covers core techniques, model-specific calibration, format guidance, and anti-patterns. This guide replaces live research for most prompt crafting tasks.

## Core Techniques

### 1. Role and Persona Assignment

Set the model's behavioral frame in the first sentence. Concrete roles outperform generic ones.

- **Effective**: "You are a senior security engineer reviewing code for OWASP Top 10 vulnerabilities."
- **Weak**: "You are a helpful assistant that knows about security."

Role assignment activates domain-specific knowledge patterns and calibrates response style. Place it at prompt start (primacy positioning).

### 2. Chain of Thought (CoT)

Instruct the model to reason step-by-step before producing a final answer. Most effective for:
- Multi-step reasoning (math, logic, planning)
- Complex classification with multiple criteria
- Tasks where intermediate reasoning improves accuracy

**Variants:**
- **Zero-shot CoT**: Append "Think step by step" or "Reason through this carefully"
- **Structured CoT**: Provide explicit reasoning stages: "First analyze X, then evaluate Y, finally decide Z"
- **CoT with scratchpad**: Give the model a `<thinking>` block for internal reasoning before output

**When to skip CoT:** Simple retrieval, direct formatting, creative generation where spontaneity matters. CoT adds latency and tokens — use it when reasoning quality justifies the cost.

### 3. Few-Shot Examples

Provide 2-5 input/output examples that demonstrate the exact behavior you want. Examples are the most reliable way to specify format, tone, and edge case handling.

**Best practices:**
- Include edge cases, not just happy paths
- Order examples from simple to complex
- Use realistic data, not placeholder text
- Match the distribution of expected inputs (if 30% of inputs are ambiguous, include ambiguous examples)

**When few-shot beats instructions:** Format-heavy tasks (JSON output, specific markdown structure), nuanced classification, style matching. When examples and instructions conflict, models follow examples.

### 4. Structured Output Specification

Explicitly define output format when you need parseable results.

**Approaches by reliability:**
- **XML tags**: `<result>...</result>` — best for Claude, reliable parsing boundaries
- **JSON with schema**: Provide a sample JSON object with field descriptions
- **Markdown structure**: Headers, lists, tables — good for human-readable output
- **Prefilling**: Start the assistant response with the format opening (e.g., `{"result":`) to lock in structure

**Claude-specific:** XML tags are first-class for Claude. Use `<thinking>`, `<answer>`, `<output>` blocks to separate reasoning from results.

### 5. Constraint Specification

Define boundaries clearly. Always pair negative constraints with positive alternatives.

- **Paired**: "Do not use technical jargon. Instead, explain concepts using everyday analogies."
- **Unpaired (weak)**: "Do not use technical jargon." (model has no fallback behavior)

**Priority ordering:** Place constraints in order of importance. Models attend more reliably to early constraints under long contexts.

### 6. System vs User Prompt Separation

- **System prompt**: Persistent behavioral directives, role, constraints, output format. Loaded once, applies to all turns.
- **User prompt**: Per-turn input, task-specific instructions, data to process.

**Rule of thumb:** If it applies to every interaction, it belongs in the system prompt. If it's task-specific, user prompt.

### 7. Context Window Management

- **Front-load critical information**: Place the most important instructions and context at the beginning. Models attend most reliably to the start and end of long contexts (primacy and recency effects).
- **Avoid redundancy**: Repeating instructions wastes tokens and can introduce inconsistency if the repetitions drift.
- **Chunk large inputs**: For very long documents, summarize or extract relevant sections rather than dumping everything.

### 8. Temperature and Sampling Guidance

Not a prompt technique per se, but affects prompt design:
- **Low temperature (0-0.3)**: Deterministic tasks — classification, extraction, code generation. Prompts can be more concise since the model won't explore alternatives.
- **Medium temperature (0.3-0.7)**: Balanced — creative writing with constraints, brainstorming with structure.
- **High temperature (0.7-1.0)**: Creative, exploratory — poetry, diverse brainstorming, fiction. Prompts should provide guardrails since the model will vary more.

## Advanced Techniques

### 9. Meta-Prompting

Instruct the model to generate or refine its own prompts. Useful for:
- Iterative prompt improvement loops
- Generating prompts for downstream models (e.g., Opus generates prompts for Haiku)
- Self-evaluation: "Rate your confidence in this answer from 1-10 and explain why"

### 10. Decomposition and Chaining

Break complex tasks into sub-tasks. Each sub-task gets its own focused prompt.

**When to decompose:**
- Task has >3 distinct cognitive steps
- Different steps need different model capabilities (reasoning vs creativity)
- You need to validate intermediate results

**Chaining patterns:**
- Sequential: Output of step N feeds into step N+1
- Fan-out: One input spawns multiple parallel sub-tasks, results merge
- Gate: Step N decides whether to proceed or branch

### 11. Retrieval-Augmented Generation (RAG) Prompt Patterns

When injecting retrieved context into prompts:
- **Cite your sources**: "Answer using only the provided context. Cite the source document for each claim."
- **Handle missing info**: "If the context doesn't contain enough information to answer, say so explicitly rather than guessing."
- **Relevance filtering**: "Ignore any retrieved passages that are not directly relevant to the question."

### 12. Tool Use and Function Calling

When designing prompts for models with tool access:
- **Describe tools concisely**: Name, purpose, parameters, return type. Skip implementation details.
- **Specify when to use tools**: "Use the search tool when the user's question requires information you don't have."
- **Handle tool failures**: "If a tool call fails, explain what happened and suggest alternatives."
- **Avoid tool overuse**: "Only call tools when necessary. Answer directly from your knowledge when confident."

### 13. Multi-Turn Conversation Design

For system prompts governing multi-turn interactions:
- **State management**: Define what the model should track across turns
- **Escalation rules**: When to ask for clarification vs proceed with assumptions
- **Recovery patterns**: How to handle contradictions, corrections, or topic changes
- **Session boundaries**: What resets between conversations, what persists

## Model Family Calibration

### Claude (Anthropic)

**Strengths:** Long context, instruction following, structured output, nuanced reasoning, safety alignment.

**Prompting notes:**
- XML tags are native — use `<tag>` blocks for structured I/O
- Responds well to direct, operational instructions — skip pedagogical framing
- Extended thinking (`<thinking>` blocks) is built-in for complex reasoning
- Prefilling the assistant turn is effective for format control
- System prompts are strongly respected — use them for persistent behavior
- Opus needs less scaffolding than Haiku — scale verbosity inversely with capability
- `<example>` tags work well for few-shot demonstrations

**Anti-patterns for Claude:**
- Excessive hedging instructions ("be careful", "make sure to") — Claude is already cautious
- Repeating the same instruction in different phrasings — causes attention dilution
- Over-specifying obvious behaviors — wastes tokens on things Claude does by default

### GPT (OpenAI)

**Strengths:** Creative generation, code generation, function calling, JSON mode.

**Prompting notes:**
- JSON mode (`response_format: json_object`) locks output to valid JSON
- Function calling schema defines tool interface — separate from prompt text
- System messages are respected but user messages can override — reinforce critical constraints
- Benefits from explicit output format specification more than Claude
- `gpt-4o` handles complex multi-step tasks; `gpt-4o-mini` needs more decomposition

**Anti-patterns for GPT:**
- Very long system prompts with GPT-4o-mini — instruction following degrades
- Relying solely on system prompt for safety — user messages can override
- Omitting JSON schema when using function calling — leads to schema drift

### Open Source Models (Llama, Mistral, Gemma, Qwen)

**Strengths:** Self-hosted, customizable, fine-tunable, no rate limits.

**Prompting notes:**
- Chat templates vary by model — use the model's native template, not a generic one
- Smaller models (7B-13B) need more explicit instructions and examples
- Few-shot examples are more critical than for frontier models
- System prompt support varies — some models ignore or poorly follow system prompts
- Structured output is less reliable — use constrained decoding (grammar-based sampling) when available
- CoT is particularly beneficial for smaller models — compensates for weaker reasoning

**Anti-patterns for open source:**
- Assuming GPT/Claude prompt patterns transfer directly — they often don't
- Skipping the model's chat template — causes severe degradation
- Complex multi-step instructions without decomposition for smaller models

### Gemini (Google)

**Strengths:** Multimodal (native image/video/audio), long context (1M+ tokens), grounding with Google Search.

**Prompting notes:**
- Grounding: Can verify claims against Google Search — enable for factual tasks
- Multimodal prompts: Interleave text and images naturally
- Long context: Effective at needle-in-haystack retrieval across very long inputs
- JSON mode available via response schema
- Benefits from explicit role and task framing

## Format-Specific Guidance

### System Prompts

System prompts set persistent behavior across all interactions.

**Structure:**
1. Role and identity (1-2 sentences)
2. Core behavioral directives (ordered by priority)
3. Output format constraints
4. Interaction rules (when to ask vs assume)
5. Negative constraints paired with alternatives

**Token budget:** Keep under 1500 tokens for sub-frontier models. Frontier models (Opus, GPT-4o) handle 3000+ tokens reliably.

### Agent Definitions

Agent prompts define autonomous behavior with tool access.

**Structure:**
1. Identity and purpose (what this agent does)
2. Available tools and when to use each
3. Workflow — numbered steps for the agent's decision loop
4. Output format and reporting
5. Constraints and guardrails
6. Failure handling — what to do when stuck

**Key principles:**
- Be explicit about decision authority — what the agent decides vs escalates
- Define success criteria so the agent knows when it's done
- Specify tool selection logic, not just tool availability

### Classification / Extraction Prompts

**Structure:**
1. Task definition (classify X into categories / extract fields from Y)
2. Category or field definitions with clear boundaries
3. 3-5 examples covering typical and edge cases
4. Handling ambiguity — what to do when uncertain
5. Output format (JSON, labels, structured text)

**Key principles:**
- Define category boundaries precisely — overlap causes inconsistency
- Include a "none/other" category for inputs that don't fit
- Order examples to demonstrate boundary cases

### Creative / Generative Prompts

**Structure:**
1. Task and desired output type
2. Tone, style, audience constraints
3. Structural requirements (length, format, sections)
4. 1-2 examples of desired quality level
5. What to avoid (specific anti-patterns, not vague "be creative")

**Key principles:**
- Constraints enable creativity — they narrow the search space productively
- Provide style exemplars rather than describing style in abstract terms

## Anti-Patterns

### Token Waste

- **Preamble bloat**: "I want you to carefully consider the following task and apply your best knowledge to..." → Just state the task.
- **Redundant re-statement**: Saying the same constraint in 3 different ways. Once is enough if it's clear.
- **Teaching known concepts**: "Machine learning is a field of AI where..." → The model knows this. Skip to the instruction.
- **Excessive hedging**: "Please make sure to try to..." → "Do X."

### Instruction Dilution

- **Too many constraints**: Beyond ~10 constraints, models start dropping low-priority ones. Consolidate or prioritize.
- **Conflicting signals**: "Be concise" + "Be thorough and detailed" → Pick one, or specify when each applies.
- **Buried critical instructions**: Important constraints in the middle of a long prompt get less attention than those at the start or end.

### Fragile Formatting

- **Relying on whitespace**: Models don't reliably preserve exact whitespace. Use structural markers (XML tags, headers).
- **Implicit format**: Expecting a format without specifying it. Always be explicit.
- **No output examples**: Describing the format verbally when an example would be clearer and more reliable.

### Model Mismatch

- **Opus prompts on Haiku**: Over-specified prompts work on Opus but overwhelm smaller models. Simplify for less capable models.
- **Open-source assumptions**: Prompts designed for API models often fail on self-hosted models with different chat templates.
- **One-size-fits-all**: Different models need different prompt styles. Test and adapt.

## Evaluation and Iteration

### Prompt Testing

- **A/B testing**: Run the same inputs through two prompt variants, compare outputs
- **Boundary testing**: Test edge cases and adversarial inputs
- **Regression testing**: When modifying a prompt, verify it doesn't break previously working cases
- **Human evaluation**: For subjective quality, there's no substitute for human judgment on a sample

### Iteration Heuristics

1. If the model ignores an instruction → move it earlier in the prompt or make it more prominent (heading, bold)
2. If output format is wrong → add an explicit example of the correct format
3. If the model is too verbose → add a word/sentence count constraint and a concise example
4. If the model hallucinates → add "Only use information from the provided context" or "Say 'I don't know' when uncertain"
5. If quality varies across runs → lower temperature, add more examples, make instructions more specific

## Quick Reference

| Technique | Best For | Token Cost | Reliability |
|-----------|----------|------------|-------------|
| Role assignment | All tasks | Low | High |
| Few-shot examples | Format, classification | Medium-High | Very High |
| Chain of thought | Reasoning, math | Medium | High |
| XML structured output | Claude extraction | Low | Very High |
| JSON mode | API integration | Low | High (varies) |
| Decomposition | Complex multi-step | High (total) | High |
| Prefilling | Format control | Low | High |
| Constraint pairing | Behavioral control | Low | Medium-High |
| Temperature tuning | Quality calibration | None | Medium |
