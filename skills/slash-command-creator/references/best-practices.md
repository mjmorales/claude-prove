# Claude Code Slash Commands Best Practices Guide

## Overview

Slash commands in Claude Code are custom prompts defined as Markdown files that Claude can execute. They provide a powerful way to automate frequently-used workflows, enforce consistency across teams, and extend Claude's capabilities for your specific use cases.

Commands are organized by scope (project-specific or personal) and support namespacing through directory structures. They become available through the slash commands menu when you type `/` in Claude Code.

## Key Concepts

### Command Locations

- **Project Commands:** `.claude/commands/` — Available only in the current project. Shows "(project)" in `/help`.
- **Personal Commands:** `~/.claude/commands/` — Available across all your projects. Shows "(user)" in `/help`.

### User-Invoked vs Model-Invoked

Slash commands are **user-invoked** — you explicitly type `/command` to trigger them. This differs from Skills, which are model-invoked (Claude autonomously decides when to use them).

## Command File Structure

### Basic Structure

Each slash command is a Markdown file. The filename (without `.md`) becomes the command name:

```text
.claude/commands/review.md  →  /review
~/.claude/commands/security-check.md  →  /security-check
```

### Frontmatter (Optional but Recommended)

Command files support YAML frontmatter for metadata:

```yaml
---
allowed-tools: Bash(git add:*), Bash(git status:*)
argument-hint: [message]
description: Create a git commit
model: claude-3-5-haiku-20241022
---
```

### Frontmatter Fields

| Field | Description |
|-------|-------------|
| `description` | Brief description shown in `/help`. Required for SlashCommand tool invocation. |
| `allowed-tools` | Restrict which tools the command can use. |
| `argument-hint` | Shows expected arguments in autocomplete. |
| `model` | Specify which model to use for this command. |
| `disable-model-invocation` | Set to `true` to prevent Claude from auto-invoking via SlashCommand tool. |

## Working with Arguments

### The `$ARGUMENTS` Variable

Use `$ARGUMENTS` to pass parameters from the command invocation into your prompt:

```markdown
Please analyze and fix the GitHub issue: $ARGUMENTS
```

When you run `/fix-issue 123`, the `$ARGUMENTS` is replaced with `"123"`.

### Positional Arguments

For multiple arguments, use `$1`, `$2`, `$3`, etc:

```yaml
---
argument-hint: [pr-number] [priority] [assignee]
description: Review pull request
---
```

```markdown
Review PR #$1 with priority $2 and assign to $3.
```

## Best Practices

### Design Principles

1. **Keep commands focused.** Create separate commands for different workflows rather than one large multi-purpose command.
2. **Write clear descriptions.** The description field helps both users and Claude understand when to use the command.
3. **Start simple.** Begin with basic instructions and expand as needed. You can always add complexity later.
4. **Include examples.** Show concrete inputs and expected outputs to help Claude understand what success looks like.
5. **Use step-by-step instructions.** Structure complex workflows as numbered steps for clarity and reliability.

### Organization Tips

- Check project commands into git so they're available to your entire team.
- Use subdirectories for namespacing (e.g., `.claude/commands/dev/lint.md` becomes `/dev:lint`).
- Keep personal commands in `~/.claude/commands/` for workflows you use across all projects.
- Name commands descriptively — the filename should indicate what the command does.

### Content Guidelines

- Write prompts in natural language — these are essentially prompt templates.
- Be specific about expected outcomes and quality criteria.
- Include verification steps when appropriate (e.g., "run tests", "check linting").
- Reference `CLAUDE.md` patterns if your command should follow project conventions.

## Example Commands

### GitHub Issue Fixer

```markdown
# .claude/commands/fix-issue.md
---
argument-hint: [issue-number]
description: Analyze and fix a GitHub issue
---
Please analyze and fix GitHub issue: $ARGUMENTS

1. Use `gh issue view` to get issue details
2. Search codebase for relevant files
3. Implement necessary changes
4. Write and run tests
5. Ensure code passes linting
6. Create descriptive commit message
```

### Code Review Command

```markdown
# .claude/commands/review.md
---
allowed-tools: Read, Grep, Glob, Bash(git diff:*)
description: Comprehensive code review
---
Review recent changes for:
1. Code quality and readability
2. Security vulnerabilities
3. Performance implications
4. Test coverage
5. Documentation completeness
```

### Git Commit Helper

```markdown
# ~/.claude/commands/commit.md
---
allowed-tools: Bash(git add:*), Bash(git status:*), Bash(git commit:*)
argument-hint: [message]
description: Create a git commit
---
Create a git commit with message: $ARGUMENTS
```

## SlashCommand Tool (Model Invocation)

The SlashCommand tool allows Claude to programmatically execute custom slash commands during a conversation. To enable this:

1. Include a `description` field in your command's frontmatter.
2. Reference the command by name with its slash in your prompts or `CLAUDE.md`.

**Example instruction:** Run `/write-unit-test` when you are about to start writing tests.

To prevent model invocation, add `disable-model-invocation: true` to the frontmatter.

## MCP Server Commands

MCP servers can expose prompts as slash commands that become available in Claude Code. These are dynamically discovered from connected MCP servers:

```text
/mcp__github__list_prs
/mcp__github__pr_review 456
/mcp__jira__create_issue "Bug title" high
```

## Additional Resources

- **Official Documentation:** [docs.claude.com/en/docs/claude-code/slash-commands](https://docs.claude.com/en/docs/claude-code/slash-commands)
- **Best Practices Blog:** [anthropic.com/engineering/claude-code-best-practices](https://anthropic.com/engineering/claude-code-best-practices)
- **Community Commands:** [github.com/wshobson/commands](https://github.com/wshobson/commands) — Production-ready slash commands collection
- **Awesome Claude Code:** [github.com/hesreallyhim/awesome-claude-code](https://github.com/hesreallyhim/awesome-claude-code) — Curated list of commands and workflows
