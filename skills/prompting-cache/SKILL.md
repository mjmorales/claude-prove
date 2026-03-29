---
name: prompting-cache
description: Manage the prompt engineering research cache. List, add, prune, or refresh cached research artifacts across three tiers — plugin-bundled, global, and project. Use when the user wants to manage their prompt research cache.
---

# Prompt Research Cache

Manage the prompt engineering research cache that supplements the bundled guide.

## Cache Tiers (Priority Order)

Later tiers override earlier tiers for entries with the same filename.

1. **Plugin** (read-only): `cache/prompting/` in the plugin directory. Ships with seed entries for common topics. Not user-editable — updates come via plugin releases.
2. **Global**: `~/.claude/cache/prompting/` -- user-managed, shared across all projects.
3. **Project**: `.prove/cache/prompting/` -- project-specific overrides.

## Cache Entry Format

Each cache entry is a markdown file named by topic slug (e.g., `claude-tool-use.md`, `llama3-system-prompts.md`):

```markdown
---
topic: Claude tool use prompting
source: Anthropic docs, blog posts
fetched: 2026-03-29
---

<distilled research content>
```

## Subcommands

Parse the first argument to determine the subcommand. Default to `list` if no argument.

### list

Show all cached entries from all three tiers, grouped by location.

```
Plugin (read-only):
  claude-prompting-2026.md    — Claude prompting best practices 2026 (2026-03-29)

Global (~/.claude/cache/prompting/):
  few-shot-patterns.md        — Few-shot example patterns (2026-03-15)

Project (.prove/cache/prompting/):
  gemini-grounding.md         — Gemini search grounding (2026-03-28)
```

For each entry, read the frontmatter to show the topic and fetch date. If no entries exist in a tier, say so. Mark plugin entries as "read-only".

### add <topic>

Research a topic using WebSearch/WebFetch, distill the findings, and save to cache.

1. `AskUserQuestion` with header "Cache scope" and options: "Global" / "Project"
2. Research the topic using WebSearch and WebFetch -- gather 3-5 authoritative sources
3. Distill into a focused, actionable reference (not a link dump)
4. Write to the chosen cache directory with frontmatter (topic, source, fetched date)
5. Report what was cached and the file path

### prune

Remove stale or unwanted cache entries from global and project tiers. Plugin-tier entries are read-only and cannot be pruned.

1. List entries from global and project tiers with their fetch dates
2. `AskUserQuestion` with header "Prune" and multiSelect options listing each entry
3. Delete selected entries
4. Report what was removed

### refresh <topic>

Re-research an existing cached topic and update the entry in place.

1. Find the existing entry (check project first, then global)
2. If not found, suggest `add` instead
3. Research the topic fresh using WebSearch/WebFetch
4. Overwrite the existing entry, updating the `fetched` date
5. Show a brief diff summary of what changed
