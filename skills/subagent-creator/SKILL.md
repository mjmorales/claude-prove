---
name: subagent-creator
description: Guide for creating specialized Claude Code subagents (AI assistants that Claude delegates tasks to). Use when users want to create a new agent, ask "create an agent for...", "new subagent", or need help designing agent prompts, tool permissions, or role definitions. Also use when asked about agent best practices or configuration options.
---

# Subagent Creator

Create specialized Claude Code subagents following established best practices.

**Interaction patterns**: See `references/interaction-patterns.md` for when to use `AskUserQuestion` vs free-form discussion.

## Workflow

### 1. Gather Requirements

Use `AskUserQuestion` for discrete choices, free-form for open-ended questions.

**Agent purpose** (free-form):
- What specific tasks will this agent handle?
- What specialized knowledge should it have?
- When should Claude delegate to this agent?

**Agent location** — use `AskUserQuestion` with header "Location":
- "Project" (`.claude/agents/` — versioned with the repo)
- "User Global" (`~/.claude/agents/` — available across all projects)
- "Plugin" (`agents/` — if adding to a prove-style plugin)

**Tool permissions** — use `AskUserQuestion` with header "Tools":
- "Read-only (Recommended for reviewers)" (`Read, Grep, Glob`)
- "Read + Research" (`Read, Grep, Glob, WebFetch, WebSearch`)
- "Full developer" (`Read, Write, Edit, Bash, Glob, Grep`)
- "Custom" (let user specify)

**Model selection** — use `AskUserQuestion` with header "Model":
- "opus" (complex reasoning, architecture decisions)
- "sonnet (Recommended)" (general development, good default)
- "haiku" (simple, repetitive, cost-efficient tasks)

### 2. Design the Agent

Based on requirements, determine:

**Agent name** (hyphen-case):
- Use descriptive, role-based names
- Examples: `code-reviewer`, `security-auditor`, `test-engineer`

**Tool permissions reference**:

| Agent Type | Recommended Tools |
|------------|-------------------|
| Reviewers/Auditors | Read, Grep, Glob |
| Researchers | Read, Grep, Glob, WebFetch, WebSearch |
| Developers | Read, Write, Edit, Bash, Glob, Grep |
| Planners | Read, Grep, Glob |

### 3. Create the Agent File

Write the agent using this structure:

```yaml
---
name: agent-name
description: [Role description]. [Trigger scenarios]. Use [proactively/when X].
tools: Read, Grep, Glob
model: sonnet
---

You are a [role description with years of experience].

## Core Responsibilities
- [Key responsibility 1]
- [Key responsibility 2]

## When Invoked
1. [First step]
2. [Analysis step]
3. [Action step]
4. [Documentation step]

## [Domain-Specific Section]
- [Checklist or guidelines]

## Output Format
[How to structure findings/results]
```

If adding to a plugin with a MANIFEST, register the agent:
```
agent | <name> | agents/ | <description>
```

### 4. Validate the Agent

Check:
- [ ] Name is hyphen-case and matches filename
- [ ] Description explains WHAT it does and WHEN to invoke
- [ ] Tools match the agent's role (read-only for reviewers)
- [ ] System prompt includes clear responsibilities
- [ ] Output format is specified
- [ ] Model is appropriate for the task complexity

Use `AskUserQuestion` with header "Review" to confirm: "Create Agent" (write the file) / "Revise" (make changes first).

## Key Principles

**Single Responsibility**: Each agent should have one clear purpose.

**Focused Descriptions**: Be specific about when to invoke:
- Good: "Senior code reviewer. Proactively reviews code for quality and security. Use immediately after writing or modifying code."
- Bad: "Reviews code"

**Appropriate Permissions**: Restrict tools based on role. Reviewers shouldn't have Write access.

**Structured Instructions**: Include step-by-step workflows and checklists.

## Prove Plugin Agents

When creating agents for a prove-style plugin, follow the patterns established by existing agents:

- **principal-architect** (`agents/principal-architect.md`) — opus model, full tools, code review role
- **validation-agent** (`agents/validation-agent.md`) — haiku model, read-only tools, lightweight validation

These demonstrate the two common patterns: heavyweight (opus, write access) for complex judgment, and lightweight (haiku, read-only) for fast, focused tasks.

## Committing

When the user asks to commit new agents, delegate to the `commit` skill. The commit skill reads `MANIFEST` for valid scopes.

Example: `feat(subagent-creator): add security-auditor agent`

## Resources

- `references/subagents-best-practices.md` — comprehensive guide with examples and pipeline patterns
- `assets/agent-template.md` — blank agent template with placeholder fields
