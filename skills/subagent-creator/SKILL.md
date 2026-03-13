---
name: subagent-creator
description: Guide for creating specialized Claude Code subagents (AI assistants that Claude delegates tasks to). Use when users want to create a new agent, ask "create an agent for...", "new subagent", or need help designing agent prompts, tool permissions, or role definitions. Also use when asked about agent best practices or configuration options.
---

# Subagent Creator

Create specialized Claude Code subagents following established best practices.

## Workflow

### 1. Gather Requirements

Ask clarifying questions to understand:

- **Agent purpose**: What specific tasks will this agent handle?
- **Expertise domain**: What specialized knowledge should it have?
- **Trigger scenarios**: When should Claude delegate to this agent?

Example prompts that should trigger agent creation:
- "Create an agent for code review"
- "I need a security auditor agent"
- "Make me a test engineer subagent"

### 2. Design the Agent

Based on requirements, determine:

**Agent name** (hyphen-case):
- Use descriptive, role-based names
- Examples: `code-reviewer`, `security-auditor`, `test-engineer`

**Tool permissions** (match to role):

| Agent Type | Recommended Tools |
|------------|-------------------|
| Reviewers/Auditors | Read, Grep, Glob |
| Researchers | Read, Grep, Glob, WebFetch, WebSearch |
| Developers | Read, Write, Edit, Bash, Glob, Grep |
| Planners | Read, Grep, Glob |

**Model selection**:
- `opus` - Complex reasoning, architecture decisions
- `sonnet` - General development (default)
- `haiku` - Simple, repetitive tasks
- `inherit` - Match main conversation

### 3. Create the Agent File

Write the agent to `.claude/agents/<name>.md` using this structure:

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

### 4. Validate the Agent

Check:
- [ ] Name is hyphen-case and matches filename
- [ ] Description explains WHAT it does and WHEN to invoke
- [ ] Tools match the agent's role (read-only for reviewers)
- [ ] System prompt includes clear responsibilities
- [ ] Output format is specified

## Key Principles

**Single Responsibility**: Each agent should have one clear purpose.

**Focused Descriptions**: Be specific about when to invoke:
- Good: "Senior code reviewer. Proactively reviews code for quality and security. Use immediately after writing or modifying code."
- Bad: "Reviews code"

**Appropriate Permissions**: Restrict tools based on role. Reviewers shouldn't have Write access.

**Structured Instructions**: Include step-by-step workflows and checklists.

## References

For detailed examples and advanced patterns (pipelines, troubleshooting):
- See `references/subagents-best-practices.md`
