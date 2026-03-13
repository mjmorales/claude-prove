---
name: slash-command-creator
description: Guide for creating Claude Code slash commands with best practices. Use when the user wants to create a new slash command, asks about slash command structure, or needs help with command frontmatter, arguments, or tool restrictions.
---

# Slash Command Creator

Create Claude Code slash commands following best practices for structure, frontmatter, and organization.

## Workflow

Follow this guided wizard to create slash commands:

### Phase 1: Gather Requirements

Use the AskUserQuestion tool to clarify:

1. **Command Purpose**
   - What task should this command automate?
   - What problem does it solve?

2. **Command Location**
   - Project-specific (`.claude/commands/`) - for this project only
   - User-global (`~/.claude/commands/`) - available across all projects

3. **Arguments Needed**
   - Does it need user input? (use `$ARGUMENTS`)
   - Multiple arguments? (use `$1`, `$2`, etc.)

4. **Tool Restrictions**
   - Should Claude have full tool access, or limited?
   - Common restrictions: Read-only, git-only, specific tools

5. **Model Selection**
   - Default model, or specific model (e.g., haiku for fast/cheap tasks)?

### Phase 2: Generate Command

Based on requirements, create the command file with:

```markdown
---
description: [Brief description for /help - REQUIRED for model invocation]
argument-hint: [Expected arguments shown in autocomplete]
allowed-tools: [Tool restrictions if needed]
model: [Specific model if needed]
---

[Command prompt content here]
```

### Phase 3: Place the File

- **Project commands:** `.claude/commands/<name>.md`
- **User commands:** `~/.claude/commands/<name>.md`
- **Namespaced:** `.claude/commands/<namespace>/<name>.md` → `/<namespace>:<name>`

## Frontmatter Reference

| Field | Required | Description |
|-------|----------|-------------|
| `description` | For model invocation | Brief description shown in `/help` |
| `argument-hint` | No | Shows expected arguments (e.g., `[issue-number]`) |
| `allowed-tools` | No | Restrict tool access (e.g., `Read, Grep, Glob`) |
| `model` | No | Specific model (e.g., `claude-3-5-haiku-20241022`) |
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

## Command Templates

### Issue Fixer

```markdown
---
argument-hint: [issue-number]
description: Analyze and fix a GitHub issue
---
Analyze and fix GitHub issue: $ARGUMENTS

1. Use `gh issue view` to get issue details
2. Search codebase for relevant files
3. Implement necessary changes
4. Write and run tests
5. Ensure code passes linting
6. Create descriptive commit message
```

### Code Review

```markdown
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

### Quick Commit

```markdown
---
allowed-tools: Bash(git add:*), Bash(git status:*), Bash(git commit:*)
argument-hint: [message]
description: Create a git commit
---
Create a git commit with message: $ARGUMENTS
```

### Test Runner

```markdown
---
description: Run tests and fix failures
---
Run the test suite and fix any failures:

1. Run tests with `npm test` or appropriate command
2. If tests fail, analyze the error
3. Fix the failing tests or code
4. Re-run to verify
```

## Best Practices

1. **Keep commands focused** - One purpose per command
2. **Write clear descriptions** - Help users and Claude understand intent
3. **Start simple** - Add complexity only when needed
4. **Include verification steps** - "run tests", "check linting"
5. **Use step-by-step instructions** - Numbered steps for complex workflows
6. **Check into git** - Share project commands with your team

## Resources

### references/

- `best-practices.md` - Comprehensive guide to slash command best practices
