---
name: slash-command-creator
description: Guide for creating Claude Code slash commands with best practices. Use when the user wants to create a new slash command, asks about slash command structure, or needs help with command frontmatter, arguments, or tool restrictions.
---

# Slash Command Creator

Create Claude Code slash commands following best practices for structure, frontmatter, and organization.

**Shared conventions**: See `references/creator-conventions.md` for the standard creator workflow (gather, generate, quality self-check, validate, review gate, commit).

**Prompting best practices**: See `references/prompt-engineering-guide.md` for optimization techniques to apply when generating command prompt content.

## Workflow

### 1. Gather Requirements

Use `AskUserQuestion` for discrete choices, free-form for open-ended questions.

**Command purpose** (free-form):
- What task should this command automate?
- What problem does it solve?

**Command location** — `AskUserQuestion` with header "Location":
- "Project" (`.claude/commands/` — versioned with the repo)
- "User Global" (`~/.claude/commands/` — available across all projects)
- "Plugin" (`commands/` — if adding to a prove-style plugin)

**Arguments** — `AskUserQuestion` with header "Arguments":
- "No arguments" (standalone command)
- "Single argument" (use `$ARGUMENTS`)
- "Multiple arguments" (use `$1`, `$2`, etc.)

**Tool restrictions** — `AskUserQuestion` with header "Tools":
- "Full access (Recommended)" (omit `allowed-tools`)
- "Read-only" (`Read, Grep, Glob`)
- "Git-only" (`Bash(git *)`)
- "Custom" (let user specify)

**Skill delegation** (conditional — only if the command is part of a plugin):
- Which skill does it wrap? Plugin commands should be thin entry points that load the skill.

### 2. Generate the Command File

Refer to `references/best-practices.md` for frontmatter fields, tool restriction patterns, and argument handling.

**Standard command structure:**

```markdown
---
description: [Action-oriented description — REQUIRED for model invocation]
argument-hint: [Expected arguments shown in autocomplete]
allowed-tools: [Tool restrictions if needed]
---

[Command prompt content here]
```

**Plugin command structure** (thin wrapper — keep all logic in the skill):

```markdown
---
description: Do the thing
argument-hint: "[input]"
---

# Command Name: $ARGUMENTS

Load and follow the skill (`skills/<name>/SKILL.md` from the workflow plugin).
```

Apply the quality self-check from `references/creator-conventions.md` before presenting. Key checks for commands:
- Description front-loads the action verb (it's truncated at ~250 chars in autocomplete)
- Body doesn't restate the description (it's already in context)
- Plugin commands are thin — no business logic in the command file

### 3. Place the File

| Location | Path | Notes |
|----------|------|-------|
| Project | `.claude/commands/<name>.md` | Versioned with repo |
| User | `~/.claude/commands/<name>.md` | Available across projects |
| Plugin | `commands/<name>.md` | Add scope to `.claude/.prove.json` |
| Namespaced | `commands/<ns>/<name>.md` | Invoked as `/ns:name` |

### 4. Validate

Before writing the file, verify:

- [ ] Filename is lowercase, hyphen-delimited, matches the command's purpose
- [ ] `description` field is present (required for model invocation and `/help`)
- [ ] `argument-hint` is set if the command accepts arguments
- [ ] Tool restrictions match the command's intent (read-only for analysis, etc.)
- [ ] Plugin commands delegate to a skill — no business logic in the command file
- [ ] Instructions use numbered steps for multi-step workflows

Use `AskUserQuestion` with header "Review" to confirm: "Create Command" / "Revise".

## Committing

Delegate to the `commit` skill. Example: `feat(commands): add review command`

## Resources

- `references/best-practices.md` — frontmatter fields, tool restriction patterns, argument handling
- `references/creator-conventions.md` — shared creator workflow patterns
- `references/prompt-engineering-guide.md` — prompting techniques for command content
