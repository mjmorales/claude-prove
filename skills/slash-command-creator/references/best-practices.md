# Slash Command Best Practices

Command structure, frontmatter fields, and patterns specific to Claude Code slash commands.

## File Structure

Each slash command is a Markdown file. The filename (without `.md`) becomes the command name:

```
.claude/commands/review.md         → /review
commands/prompting/craft.md        → /prove:prompting:craft
~/.claude/commands/security.md     → /security
```

Subdirectories create namespaces with colon-delimited invocation.

## Frontmatter Fields

```yaml
---
description: Brief action-oriented description
argument-hint: [expected arguments]
allowed-tools: Tool restrictions
model: claude-3-5-haiku-20241022
disable-model-invocation: true
---
```

| Field | Purpose |
|-------|---------|
| `description` | Shown in `/` menu and `/help`. Required for model auto-invocation. |
| `argument-hint` | Placeholder text in autocomplete. |
| `allowed-tools` | Restrict which tools the command can use. |
| `model` | Force a specific model for this command. |
| `disable-model-invocation` | `true` prevents Claude from auto-invoking via SlashCommand tool. |

## Arguments

| Pattern | Usage | Example |
|---------|-------|---------|
| `$ARGUMENTS` | Single argument (full user input) | `/fix-issue 123` → `$ARGUMENTS` = `"123"` |
| `$1`, `$2` | Positional arguments | `/review 456 high` → `$1` = `"456"`, `$2` = `"high"` |
| No args | Standalone command | `/review` |

If `$ARGUMENTS` is not present in the file content, user input is appended as `ARGUMENTS: <value>`.

## Tool Restriction Patterns

| Use Case | `allowed-tools` Value |
|----------|----------------------|
| Read-only analysis | `Read, Grep, Glob` |
| Git operations only | `Bash(git add:*), Bash(git status:*), Bash(git commit:*)` |
| Full access | Omit the field entirely |

## Design Principles

1. **One command, one task** — separate commands for separate workflows
2. **Descriptions do the heavy lifting** — front-load the action verb; descriptions are truncated at ~250 chars
3. **Don't repeat the description in the body** — it's already in context when the body loads
4. **Plugin commands are thin** — delegate to skills for all logic
5. **Use numbered steps** for multi-step workflows
