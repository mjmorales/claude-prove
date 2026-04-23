---
name: prompting
description: Prompt engineering toolkit — craft optimized LLM prompts, manage the research cache, and count tokens. Dispatches to three subcommands. Use when the user wants to craft a prompt, write a prompt, generate a system prompt, create an agent prompt, optimize a prompt, do prompt engineering, manage the prompt cache, prune the cache, refresh cached research, check token count, or measure prompt size.
---

# Prompting

Single entry point for prompt engineering workflows. Parse the first positional argument as the subcommand; forward remaining arguments.

| Subcommand | Purpose |
|------------|---------|
| `craft [goal] [--research]` | Generate a new optimized prompt via the `llm-prompt-engineer` agent |
| `cache <list\|add\|prune\|refresh> [args]` | Manage the research cache (wraps `prove prompting cache` CLI) |
| `token-count <patterns...>` | Estimate token counts (wraps `prove prompting token-count` CLI) |

Default to `craft` when the user's intent is "make a prompt" without naming a subcommand. Default to `cache list` when the user says "cache" with no further args. `token-count` requires at least one pattern.

---

## Subcommand: craft

Delegate to the `llm-prompt-engineer` agent to generate an optimized prompt from the user's requirements.

### Before Delegating

Gather these inputs (ask if missing):

1. **Target model** — Claude, GPT, open-source, or general-purpose
2. **Task type** — classification, generation, analysis, agent behavior, system prompt
3. **Output expectations** — what a successful response looks like
4. **Constraints** — token budget, latency, cost, safety
5. **Consumption context** — one-shot, system instruction, or agent definition

Do NOT delegate until intent and constraints are clear.

### Research Mode

- **Default (no flag)**: Agent uses bundled `references/prompt-engineering-guide.md` and any cached research. No WebSearch/WebFetch.
- **`--research` flag or explicit user request**: Agent does live web research and caches results.
- **Agent-detected gap**: If the bundled guide and cache don't cover the ask, agent asks the user before researching.

### Delegation Instructions

Pass gathered requirements to `llm-prompt-engineer` with these directives:

1. Read `references/prompt-engineering-guide.md`
2. Check the research cache in priority order — later tiers override earlier: plugin (`cache/prompting/` in plugin dir), global (`~/.claude/cache/prompting/`), project (`.prove/cache/prompting/`)
3. Apply research mode (default: guide + cache; `--research`: live web, cache results)
4. Apply all relevant optimization techniques
5. Embed brief inline comments in the generated prompt explaining key design choices (e.g., `<!-- Primacy effect: critical constraint placed first -->`)
6. Present the result with:
   - **Techniques applied** — each technique used and why
   - **Guide sections referenced** — which parts of the bundled guide informed the design
   - **Token estimate** — approximate token count
   - **Trade-offs** — what was optimized for vs deprioritized

### After Generation

Offer to:
- Iterate on specific sections
- Adjust token-efficiency vs clarity balance
- Add or remove techniques
- Test with example inputs
- Research a specific aspect (`--research`)

If the user provides a file path, write the final prompt there. Otherwise, output directly.

---

## Subcommand: cache

Manage the prompt engineering research cache that supplements the bundled guide. Wraps `prove prompting cache` CLI for filesystem operations; research (`add`/`refresh`) is performed by this skill using WebSearch/WebFetch.

### Cache Tiers (Priority Order)

Later tiers override earlier tiers for entries with the same filename.

1. **Plugin** (read-only): `cache/prompting/` in the plugin directory. Ships with seed entries. Not user-editable.
2. **Global**: `~/.claude/cache/prompting/` — user-managed, shared across projects.
3. **Project**: `.prove/cache/prompting/` — project-specific overrides.

### Cache Entry Format

Each entry is a markdown file named by topic slug (e.g., `claude-tool-use.md`):

```markdown
---
topic: Claude tool use prompting
source: Anthropic docs, blog posts
fetched: 2026-03-29
---

<distilled research content>
```

### Actions

Parse the first argument after `cache`. Default to `list` if none.

#### list

Show all entries from all three tiers, grouped by location. Read frontmatter to show topic + fetch date. Mark plugin entries "read-only".

```
Plugin (read-only):
  claude-prompting-2026.md    — Claude prompting best practices 2026 (2026-03-29)

Global (~/.claude/cache/prompting/):
  few-shot-patterns.md        — Few-shot example patterns (2026-03-15)

Project (.prove/cache/prompting/):
  gemini-grounding.md         — Gemini search grounding (2026-03-28)
```

#### add &lt;topic&gt;

Research a topic and save to cache.

1. `AskUserQuestion` with header "Cache scope" and options: "Global" / "Project"
2. Research via WebSearch + WebFetch — gather 3-5 authoritative sources
3. Distill into a focused, actionable reference (not a link dump)
4. Write to the chosen cache directory with frontmatter (topic, source, fetched date)
5. Report what was cached and the file path

#### prune

Remove stale entries from global and project tiers. Plugin tier is read-only.

1. List entries from global + project with fetch dates
2. `AskUserQuestion` with header "Prune" and multiSelect options listing each entry
3. Delete selected entries
4. Report what was removed

#### refresh &lt;topic&gt;

Re-research an existing entry in place.

1. Find the existing entry (project first, then global)
2. If not found, suggest `add` instead
3. Research fresh via WebSearch + WebFetch
4. Overwrite the entry, updating the `fetched` date
5. Show a brief diff summary of what changed

---

## Subcommand: token-count

Estimate token counts for files via regex-based heuristic tokenizer. Works on any text file.

### Usage

Run from the user's project root. Invoke the CLI directly:

```bash
prove prompting token-count <patterns...> [flags]
```

Positional arguments are glob patterns or literal file paths. Multiple patterns combinable.

| Flag | Effect |
|------|--------|
| `--sort tokens` | Sort by token count descending (default) |
| `--sort name` | Sort alphabetically by path |
| `--sort lines` | Sort by line count descending |
| `--json` | Machine-readable JSON output |
| `--no-strip` | Include YAML frontmatter in count (stripped by default) |

### Examples

```bash
prove prompting token-count '**/*.md'
prove prompting token-count agents/llm-prompt-engineer.md
prove prompting token-count 'agents/**/*.md' 'skills/**/SKILL.md'
prove prompting token-count '**/*.md' --json
```

### Interpreting Results

- **Tokens**: Heuristic, typically within 10-15% of Claude's BPE tokenizer. Slightly overcounts.
- **Lines/Chars**: After frontmatter stripping (unless `--no-strip`).
- **Frontmatter stripping**: YAML between `---` markers excluded by default — Claude Code doesn't send frontmatter as prompt content.

### When to Use

- Before/after prompt optimization — measure the delta
- Auditing prompt budgets across a project
- Comparing agent definitions to find outliers
- Checking if a reference file is too large for context
