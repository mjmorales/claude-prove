---
name: slash-command-creator
description: Guide for creating Claude Code slash commands with best practices. Use when the user wants to create a new slash command, asks about slash command structure, or needs help with command frontmatter, arguments, or tool restrictions.
---

# Slash Command Creator

Create Claude Code slash commands following best practices for structure, frontmatter, and organization.

**Interaction patterns**: See `references/interaction-patterns.md` for when to use `AskUserQuestion` vs free-form discussion.

## Workflow

### Phase 1: Gather Requirements

Use `AskUserQuestion` for discrete choices:

1. **Command Location**
   Use `AskUserQuestion` with header "Location" (when presenting ≤3 choices, include a "Research & proceed" option per the Delegation pattern in `references/interaction-patterns.md`):
   - "Project" (`.claude/commands/` — versioned with the repo)
   - "User Global" (`~/.claude/commands/` — available across all projects)
   - "Plugin" (`commands/` — if adding to a prove-style plugin)

2. **Command Purpose** (free-form)
   - What task should this command automate?
   - What problem does it solve?

3. **Arguments**
   Use `AskUserQuestion` with header "Arguments":
   - "No arguments" (standalone command)
   - "Single argument" (use `$ARGUMENTS`)
   - "Multiple arguments" (use `$1`, `$2`, etc.)

4. **Tool Restrictions**
   Use `AskUserQuestion` with header "Tools":
   - "Full access (Recommended)" (omit `allowed-tools`)
   - "Read-only" (`Read, Grep, Glob`)
   - "Git-only" (`Bash(git *)`)
   - "Custom" (let user specify)

5. **Skill Delegation**
   If the command delegates to a skill (common in prove), note which skill it wraps. The command should be a thin entry point that loads the skill.

### Phase 2: Generate Command

Based on requirements, create the command file:

```markdown
---
description: [Brief description for /help — REQUIRED for model invocation]
argument-hint: [Expected arguments shown in autocomplete]
allowed-tools: [Tool restrictions if needed]
model: [Specific model if needed]
---

[Command prompt content here]
```

#### For Plugin Commands (prove pattern)

If the command is part of a plugin, follow the prove convention:
- Keep commands thin — delegate to a skill via `Load and follow the X skill`
- Reference the skill path: `skills/<name>/SKILL.md from the workflow plugin`
- Use `$ARGUMENTS` for user input
- Include the `## Instructions` section with numbered steps

Example:
```markdown
---
description: Do the thing
argument-hint: "[input]"
---

# Command Name

Brief description.

## Input

$ARGUMENTS

## Instructions

Load and follow the skill (`skills/<name>/SKILL.md` from the workflow plugin).

1. Step one
2. Step two
```

### Phase 3: Place the File

- **Project commands:** `.claude/commands/<name>.md`
- **User commands:** `~/.claude/commands/<name>.md`
- **Plugin commands:** `commands/<name>.md` (add scope to `.prove.json` if needed)
- **Namespaced:** `.claude/commands/<namespace>/<name>.md` → `/<namespace>:<name>`

If adding to a plugin, ensure the `commands` scope exists in `.prove.json`:
```json
"scopes": { "commands": "commands/" }
```

## Frontmatter Reference

| Field | Required | Description |
|-------|----------|-------------|
| `description` | For model invocation | Brief description shown in `/help` |
| `argument-hint` | No | Shows expected arguments (e.g., `[issue-number]`) |
| `allowed-tools` | No | Restrict tool access (e.g., `Read, Grep, Glob`) |
| `model` | No | Specific model (e.g., `haiku`) |
| `disable-model-invocation` | No | Set `true` to prevent auto-invocation |

## Tool Restriction Patterns

Common `allowed-tools` configurations:

```yaml
# Read-only analysis
allowed-tools: Read, Grep, Glob

# Git operations only
allowed-tools: Bash(git add:*), Bash(git status:*), Bash(git commit:*)

# Code review (read + git diff)
allowed-tools: Read, Grep, Glob, Bash(git diff:*)

# Full access (omit field entirely)
```

## Arguments

### Single Argument

```markdown
Please analyze issue: $ARGUMENTS
```

Usage: `/fix-issue 123` → `$ARGUMENTS` becomes `"123"`

### Multiple Arguments

```yaml
---
argument-hint: [pr-number] [priority] [assignee]
---
```

```markdown
Review PR #$1 with priority $2 and assign to $3.
```

Usage: `/review-pr 456 high alice`

## Best Practices

1. **Keep commands focused** — one purpose per command
2. **Write clear descriptions** — helps users and Claude understand intent
3. **Start simple** — add complexity only when needed
4. **Include verification steps** — "run tests", "check linting"
5. **Use step-by-step instructions** — numbered steps for complex workflows
6. **Check into git** — share project commands with your team
7. **Delegate to skills** — keep commands thin, put logic in skills

## Committing

When the user asks to commit new commands, delegate to the `commit` skill. The commit skill reads `.prove.json` scopes for valid commit scopes.

Example: `feat(slash-command-creator): add review command`

## Resources

### references/

- `best-practices.md` — comprehensive guide to slash command best practices
