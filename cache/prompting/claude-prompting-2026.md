---
topic: Claude prompting best practices 2026
source: platform.claude.com/docs, anthropic.com/engineering/effective-context-engineering, code.claude.com/docs/en/sub-agents
fetched: 2026-03-29
---

# Claude Prompting Best Practices (2026)

Distilled from Anthropic's official docs for Claude 4.6 models (Opus, Sonnet, Haiku).

## Model Calibration: Claude 4.6

- **More concise by default**: Provides fact-based progress reports, not self-celebratory updates. Skip verbosity prompting unless you need it.
- **Opus 4.6 overtriggers on aggressive language**: "CRITICAL: You MUST use this tool" causes overuse. Use natural phrasing: "Use this tool when..."
- **Prefilling deprecated**: Prefilled assistant turns no longer supported in 4.6. Use direct instructions or structured outputs instead.
- **Opus needs less scaffolding**: Scale verbosity inversely with model capability. Opus handles vague instructions better than Sonnet/Haiku.
- **Adaptive thinking replaces budget_tokens**: Use `effort` parameter instead of manual thinking budgets.

## System Prompt Structure

1. Role and identity (1-2 sentences)
2. Core behavioral directives (priority-ordered)
3. Output format constraints
4. Interaction rules
5. Negative constraints paired with positive alternatives

**Token budget**: Frontier models (Opus, Sonnet 4.6) handle 3000+ tokens reliably. Sub-frontier: keep under 1500.

## Agent Definition Structure

From official subagent docs:

- Frontmatter: name, description, tools, model (required: name + description)
- Body: System prompt in Markdown
- Subagents receive ONLY their system prompt + basic environment details, NOT the full Claude Code system prompt
- Description field is critical: Claude uses it to decide when to delegate

### Best Practices for Agent Definitions

- **Design focused subagents**: Each should excel at one specific task
- **Write detailed descriptions**: Claude uses the description for delegation decisions
- **Limit tool access**: Grant only necessary permissions
- **Workflow over enumeration**: Numbered steps for the agent's decision loop are effective
- **Built-in agents are tiny**: Explore (494 tokens), Plan (636 tokens), General-purpose (285 tokens). Keep custom agents lean.

## Key Techniques

### Positive Over Negative

Instead of: "Do not use markdown in your response"
Try: "Your response should be composed of smoothly flowing prose paragraphs."

### XML Tags for Structure

- Use `<example>` tags for few-shot demonstrations
- Wrap instructions in descriptive tags: `<instructions>`, `<context>`, `<input>`
- Consistent, descriptive tag names across prompts

### Examples Are the Strongest Signal

- 3-5 examples for best results
- Cover edge cases, not just happy paths
- Wrap in `<example>` / `<examples>` tags
- Examples override instructions when they conflict

### Context Engineering for Agents

- Start minimal, add instructions for observed failure modes only
- Curate diverse canonical examples rather than exhaustive edge case lists
- Treat context as finite: every token depletes attention budget
- "Smallest set of high-signal tokens that maximize likelihood of desired outcome"
- Be "specific enough to guide behavior, flexible enough to provide strong heuristics"

### Tool Use Optimization

- Opus 4.6 may overtrigger on tools; dial back aggressive language
- Self-contained tools with clear parameters
- Avoid bloated tool sets with ambiguous overlaps
- Describe when to use each tool, not just availability

## Anti-Patterns (Claude-Specific)

- **Excessive hedging**: "be careful", "make sure to" -- Claude is already cautious
- **Repeating instructions in different phrasings**: Causes attention dilution
- **Over-specifying obvious behaviors**: Wastes tokens on defaults
- **Aggressive tool prompting**: "ALWAYS use X" causes overtriggering in 4.6
- **Teaching known concepts**: The model knows them; skip to the instruction
- **Preamble bloat**: "I want you to carefully consider..." -- just state the task

## Subagent Orchestration (4.6)

- Opus 4.6 has strong native subagent orchestration -- may overuse subagents
- Add explicit guidance about when subagents are/aren't warranted
- Subagents cannot spawn other subagents
- Use `tools` field to restrict capabilities per agent

## Slash Command / Skill Definitions

From official docs (code.claude.com/docs/en/slash-commands), updated 2026-03-29.

### How Commands Work

- Commands and skills are unified: `.claude/commands/foo.md` and `.claude/skills/foo/SKILL.md` both create `/foo`. Skills take precedence on name collision.
- **Description** is loaded into context so Claude knows what's available. Full content loads only when invoked. Front-load the key use case -- descriptions truncated at 250 chars.
- **`$ARGUMENTS`** is substituted inline. If not present in content, appended as `ARGUMENTS: <value>`. Positional access: `$ARGUMENTS[N]` or `$N`.
- **Body** becomes the prompt Claude receives when invoked. For skill-delegating commands, keep it minimal: the skill has the full protocol.

### Frontmatter Fields

| Field | Purpose |
|-------|---------|
| `description` | Shown in `/` menu; Claude uses it for auto-invocation decisions. Recommended. |
| `argument-hint` | Placeholder in autocomplete. E.g., `[issue-number]` |
| `disable-model-invocation` | `true` = only user can invoke (use for side-effect commands) |
| `user-invocable` | `false` = hidden from `/` menu, only Claude can invoke |
| `allowed-tools` | Tools allowed without per-use approval when active |
| `model` | Force a specific model |
| `effort` | Override session effort level (`low`, `medium`, `high`, `max`) |
| `context` | `fork` = run in isolated subagent context |
| `agent` | Which subagent type for `context: fork` (`Explore`, `Plan`, custom) |
| `paths` | Glob patterns limiting auto-activation to matching files |
| `shell` | `bash` (default) or `powershell` for inline shell commands |
| `hooks` | Lifecycle hooks scoped to this skill |

### Best Practices for Lean Command Wrappers

- **Description does the heavy lifting**: it's the only text visible before invocation. Make it precise and action-oriented.
- **Don't repeat the description in the body**: the description is already in context when the body loads. Restating it wastes tokens and dilutes attention.
- **Body for skill-delegators = skill path only**: one line pointing to the SKILL.md. The skill contains the full protocol.
- **Add context only when the skill needs runtime info**: e.g., `plan-task.md` passes `$ARGUMENTS` as a labeled "Task Description" because the skill needs that framing. If the skill reads `$ARGUMENTS` directly, don't re-label it.
- **`argument-hint` should match the skill's expected input**: show the format the user needs, not implementation details like `--research`.
- **Keep implementation details out of descriptions**: "Uses bundled guide by default" is an implementation detail. "Craft an optimized LLM prompt" is the user-facing value.

### Dynamic Context Injection

- `` !`command` `` syntax runs shell commands before content reaches Claude
- Output replaces the placeholder -- Claude sees data, not commands
- Useful for injecting git diffs, PR data, file listings
