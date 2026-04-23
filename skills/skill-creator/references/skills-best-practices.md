# Claude Code Skills Best Practices

## Skills vs Commands

Skills are **model-invoked** — Claude autonomously decides when to use them based on the `description` field. Commands are **user-invoked** — explicitly typed as `/command`. This distinction makes the skill's description the highest-leverage field: it determines whether the skill gets activated at all.

## File Structure

```
skills/<name>/
  SKILL.md          # Required: frontmatter + instructions
  references/       # Optional: domain reference material
  assets/           # Optional: templates, examples
  scripts/          # Optional: executable scripts
  *.py              # Optional: Python modules
```

A skill's `SKILL.md` is loaded when Claude determines the skill matches the current task (via description matching) or when a command explicitly delegates to it.

## Frontmatter Fields

```yaml
---
name: skill-name              # Required: hyphen-case identifier
description: What this skill does. When to use it. Trigger phrases.  # Required
---
```

| Field | Purpose |
|-------|---------|
| `name` | Unique identifier, hyphen-case. Must match the directory name convention. |
| `description` | Loaded into Claude's context for delegation decisions. Front-load the action and trigger scenarios. |

## Writing Effective Descriptions

The description is the single most important field. Claude uses it to decide whether to invoke the skill.

**Structure**: `<What it does>. <When to use it>. <Trigger phrases>.`

**Good**:
```yaml
description: Generate optimized LLM prompts using research-backed techniques. Use when creating new prompts, system instructions, or agent definitions. Triggers on "craft a prompt", "write a prompt", "generate a system prompt".
```

**Bad**:
```yaml
description: A tool for prompts.
```

**Guidelines**:
- Front-load the primary action (what the skill produces)
- Include 2-3 concrete trigger scenarios
- List explicit trigger phrases that users might say naturally
- Keep under 300 characters for the primary description; trigger phrases can extend it

## Skill Body Structure

### Autonomous Skills (No User Interaction)

```markdown
# Skill Name

Brief purpose statement.

## Workflow

1. Step one
2. Step two
3. Step three

## Output

What the skill produces and where.
```

### Interactive Skills (With User Gates)

```markdown
# Skill Name

Brief purpose statement.

## Workflow

### 1. Gather Requirements
AskUserQuestion patterns for user input.

### 2. Execute
Core logic with numbered steps.

### 3. Validate
Checklist before finalizing.

### 4. Review Gate
AskUserQuestion for approval.
```

### Delegating Skills (Thin Wrappers)

```markdown
# Skill Name

Brief purpose statement.

## Before Delegating
Gather context needed by the agent.

## Delegation Instructions
What to tell the agent.

## After Delegation
Post-processing or follow-up options.
```

## Resource Bundling

### When to Bundle References

- Domain knowledge the skill needs that isn't in the codebase
- Best practices or conventions specific to the skill's domain
- Examples or templates the skill generates from

### When NOT to Bundle

- Information already in `references/` at the plugin root (use a path reference instead)
- Content that changes frequently (consider the prompt cache instead)
- Generic knowledge the model already has

### Reference File Pattern

Keep references focused and lean. One reference per concern:
- `references/best-practices.md` — domain-specific guidelines
- `assets/template.md` — output template with placeholders

## Interaction Patterns

Skills that interact with users should follow `references/interaction-patterns.md`:
- Binary choices and approval gates → `AskUserQuestion`
- Open-ended clarification → free-form
- Delegation offers → include "Research & proceed" option

## Token Budget Guidelines

Built-in Claude Code agents are 285-636 tokens. Skill SKILL.md files should aim for:
- **Simple skills** (thin delegation): 200-500 tokens
- **Interactive skills** (gather + execute): 500-1200 tokens
- **Complex skills** (multi-phase orchestration): 1200-2500 tokens

Use `prove prompting token-count <file>` to measure.
