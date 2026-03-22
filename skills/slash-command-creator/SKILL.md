---
name: slash-command-creator
description: Guide for creating Claude Code slash commands with best practices. Use when the user wants to create a new slash command, asks about slash command structure, or needs help with command frontmatter, arguments, or tool restrictions.
---

# Slash Command Creator

Create Claude Code slash commands following best practices for structure, frontmatter, and organization.

**Interaction patterns**: See `references/interaction-patterns.md` (project root) for when to use `AskUserQuestion` vs free-form discussion.

## Workflow

### 1. Gather Requirements

Use `AskUserQuestion` for discrete choices, free-form for open-ended questions.

**Command purpose** (free-form):
- What task should this command automate?
- What problem does it solve?

**Command location** -- use `AskUserQuestion` with header "Location" (when presenting <=3 choices, include a "Research & proceed" option per the Delegation pattern in `references/interaction-patterns.md`):
- "Project" (`.claude/commands/` -- versioned with the repo)
- "User Global" (`~/.claude/commands/` -- available across all projects)
- "Plugin" (`commands/` -- if adding to a prove-style plugin)

**Arguments** -- use `AskUserQuestion` with header "Arguments":
- "No arguments" (standalone command)
- "Single argument" (use `$ARGUMENTS`)
- "Multiple arguments" (use `$1`, `$2`, etc.)

**Tool restrictions** -- use `AskUserQuestion` with header "Tools":
- "Full access (Recommended)" (omit `allowed-tools`)
- "Read-only" (`Read, Grep, Glob`)
- "Git-only" (`Bash(git *)`)
- "Custom" (let user specify)

**Skill delegation** (conditional -- only if the command is part of a plugin):
- Which skill does it wrap? The command should be a thin entry point that loads the skill.

### 2. Generate the Command File

Refer to `references/best-practices.md` for the full frontmatter field reference, tool restriction patterns, and argument handling examples.

**Standard command structure:**

```markdown
---
description: [Brief description for /help -- REQUIRED for model invocation]
argument-hint: [Expected arguments shown in autocomplete]
allowed-tools: [Tool restrictions if needed]
model: [Specific model if needed]
---

[Command prompt content here]
```

**Plugin command structure** (prove pattern -- keep commands thin, delegate to skills):

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

### 3. Place the File

| Location | Path | Notes |
|----------|------|-------|
| Project | `.claude/commands/<name>.md` | Versioned with repo |
| User | `~/.claude/commands/<name>.md` | Available across projects |
| Plugin | `commands/<name>.md` | Add scope to `.prove.json` |
| Namespaced | `.claude/commands/<ns>/<name>.md` | Invoked as `/<ns>:<name>` |

If adding to a plugin, ensure the `commands` scope exists in `.prove.json`:
```json
"scopes": { "commands": "commands/" }
```

### 4. Validate

Before writing the file, verify:

- [ ] Filename is lowercase, hyphen-delimited, matches the command's purpose
- [ ] `description` field is present (required for model invocation and `/help`)
- [ ] `argument-hint` is set if the command accepts arguments
- [ ] Tool restrictions match the command's intent (read-only for analysis, etc.)
- [ ] Plugin commands delegate to a skill -- no business logic in the command file
- [ ] Instructions use numbered steps for multi-step workflows

Use `AskUserQuestion` with header "Review" to confirm: "Create Command" (write the file) / "Revise" (make changes first).

## Committing

When the user asks to commit new commands, delegate to the `commit` skill. The commit skill reads `.prove.json` scopes for valid commit scopes.

Example: `feat(slash-command-creator): add review command`

## Resources

### references/

- `best-practices.md` -- comprehensive guide covering frontmatter fields, argument handling, tool restriction patterns, and example commands
