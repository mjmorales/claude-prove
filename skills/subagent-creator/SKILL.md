---
name: subagent-creator
description: Create Claude Code subagents. Triggers on "create an agent", "new subagent", agent design questions, or tool permission/role definition requests.
---

# Subagent Creator

Create specialized Claude Code subagents following established best practices.

**Shared conventions**: See `references/creator-conventions.md` for the standard creator workflow (gather, generate, quality self-check, validate, review gate, commit).

**Prompting best practices**: See `references/prompt-engineering-guide.md` for optimization techniques to apply when generating the agent's system prompt.

## Workflow

### 1. Gather Requirements

Use `AskUserQuestion` for discrete choices, free-form for open-ended questions.

**Agent purpose** (free-form):
- What specific tasks will this agent handle?
- What specialized knowledge should it have?
- When should Claude delegate to this agent?

**Agent location** — `AskUserQuestion` with header "Location":
- "Project" (`.claude/agents/` — versioned with the repo)
- "User Global" (`~/.claude/agents/` — available across all projects)
- "Plugin" (`agents/` — if adding to a prove-style plugin)

**Tool permissions** — `AskUserQuestion` with header "Tools":
- "Read-only (Recommended for reviewers)" (`Read, Grep, Glob`)
- "Read + Research" (`Read, Grep, Glob, WebFetch, WebSearch`)
- "Full developer" (`Read, Write, Edit, Bash, Glob, Grep`)
- "Custom" (let user specify)

**Model selection** — `AskUserQuestion` with header "Model":
- "opus" (complex reasoning, architecture decisions)
- "sonnet (Recommended)" (general development, good default)
- "haiku" (simple, repetitive, cost-efficient tasks)

### 2. Create the Agent File

**Agent name** — derive a hyphen-case name from the role (e.g., `code-reviewer`, `security-auditor`, `test-engineer`).

Use `assets/agent-template.md` as the scaffold. Refer to `references/subagents-best-practices.md` for tool permission patterns and example agents.

**Model calibration** — adjust the generated system prompt verbosity based on the selected model:
- **Opus**: Lean instructions, fewer guardrails. Built-in agents are 285-636 tokens — aim for similar.
- **Sonnet**: Moderate detail, explicit workflow steps.
- **Haiku**: More scaffolding, explicit examples, precise constraints.

Apply the quality self-check from `references/creator-conventions.md` before presenting. Key checks for agents:
- Description explains WHAT it does and WHEN to invoke (this drives auto-delegation)
- System prompt body is operational, not pedagogical
- Token budget is appropriate for the model

### 3. Validate

Before writing, verify:

- [ ] Name is hyphen-case and matches filename
- [ ] Description explains what it does and when to invoke
- [ ] Tools match the agent's role (read-only for reviewers)
- [ ] System prompt has clear responsibilities and workflow
- [ ] Output format is specified
- [ ] Model is appropriate for the task complexity
- [ ] If plugin: `agents` scope exists in `.claude/.prove.json`

Use `AskUserQuestion` with header "Review" to confirm: "Create Agent" / "Revise".

## Committing

Delegate to the `commit` skill. Example: `feat(agents): add security-auditor agent`

## Resources

- `references/subagents-best-practices.md` — tool permissions, example agents, pipeline patterns
- `assets/agent-template.md` — blank agent template with placeholder fields
- `references/creator-conventions.md` — shared creator workflow patterns
- `references/prompt-engineering-guide.md` — prompting techniques for the system prompt
