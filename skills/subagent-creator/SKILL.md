---
name: subagent-creator
description: Create Claude Code subagents. Triggers on "create an agent", "new subagent", agent design questions, or tool permission/role definition requests.
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

**Agent location** — use `AskUserQuestion` with header "Location" (when presenting ≤3 choices, include a "Research & proceed" option per the Delegation pattern in `references/interaction-patterns.md`):
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

### 2. Create the Agent File

**Agent name** — derive a hyphen-case name from the role (e.g., `code-reviewer`, `security-auditor`, `test-engineer`).

Use `assets/agent-template.md` as the scaffold. Fill in all placeholder fields based on the gathered requirements.

Refer to `references/subagents-best-practices.md` for tool permission patterns by agent type, example agents, and pipeline composition patterns.

If adding to a plugin, ensure the `agents` scope exists in `.prove.json`:
```json
"scopes": { "agents": "agents/" }
```

For plugin agents, follow established patterns: heavyweight (opus, write access) for complex judgment, lightweight (haiku, read-only) for fast focused tasks. See `agents/principal-architect.md` and `agents/validation-agent.md` as examples.

### 3. Validate the Agent

Check:
- [ ] Name is hyphen-case and matches filename
- [ ] Description explains WHAT it does and WHEN to invoke
- [ ] Tools match the agent's role (read-only for reviewers)
- [ ] System prompt includes clear responsibilities
- [ ] Output format is specified
- [ ] Model is appropriate for the task complexity

Use `AskUserQuestion` with header "Review" to confirm: "Create Agent" (write the file) / "Revise" (make changes first).

## Committing

When the user asks to commit new agents, delegate to the `commit` skill. The commit skill reads `.prove.json` scopes for valid commit scopes.

Example: `feat(subagent-creator): add security-auditor agent`

## Resources

- `references/subagents-best-practices.md` — comprehensive guide with examples and pipeline patterns
- `assets/agent-template.md` — blank agent template with placeholder fields
