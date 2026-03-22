---
name: agentic-doc-writer
description: Generate machine-parseable, LLM-optimized documentation for Claude Code agents. Use when documenting agents, subagents, APIs, modules, or any code that other agents will consume. Triggers include "document this agent", "write agent docs", "create API docs for agents", or when documentation needs to be actionable by LLMs.
---

# Agentic Doc Writer

Generate structured documentation optimized for LLM consumption and agent recollection efficiency.

**Interaction patterns**: See `references/interaction-patterns.md` for when to use `AskUserQuestion` vs free-form discussion.

## Workflow

1. **Identify subject type** (agent, API, module, code)
2. **Gather context efficiently** (targeted reads, avoid full-file scans)
3. **Delegate to technical-writer** agent with structured prompt
4. **Review output** for contract completeness

## Subject Identification

Use `AskUserQuestion` with header "Subject" if the type isn't obvious from context. When presenting ≤3 choices, include a "Research & proceed" option per the Delegation pattern in `references/interaction-patterns.md`.

| Subject | Indicators | Key Contracts | AskUserQuestion Label |
|---------|------------|---------------|-----------------------|
| **Agent** | `.md` in agents dir, frontmatter with `tools:` | Triggers, inputs, outputs, workflow | "Agent" |
| **API** | HTTP handlers, REST endpoints, GraphQL resolvers | Request/response schemas, errors | "API" |
| **Module** | Package exports, public interfaces | Parameters, return types, side effects | "Module" |
| **Code** | Functions, classes, complex logic | Types, behavior, edge cases | "Code" |

## Context Gathering

- **Grep before read**: Use `Grep` to locate relevant sections, then read only those lines
- **Interface boundary**: Document the public interface, not dependencies. Never follow imports recursively.
- **Single pass**: Gather all needed context before delegating -- do not interleave gathering and writing

## Delegation to technical-writer

Invoke the `technical-writer` subagent with this prompt structure:

```
Document [SUBJECT_TYPE]: [SUBJECT_NAME]

Source: [FILE_PATH]:[LINE_RANGE]

Context:
[PASTE RELEVANT CODE/CONFIG — MINIMAL]

Requirements:
- Output: [agent-doc | api-doc | module-doc]
- Include: [specific contracts needed]
- Format: YAML frontmatter + structured markdown
```

### Agent Documentation Template

For agents, ensure the prompt requests:

- Invocation triggers (explicit conditions)
- Input contract (what context it receives)
- Output contract (what it produces, format)
- Workflow steps (numbered, deterministic)
- Tool permissions (which tools it uses)

### API Documentation Template

For APIs, ensure the prompt requests:

- Request schema (params, body, headers)
- Response schema (success and error cases)
- Validation rules (constraints, patterns)
- Error codes and conditions

### Module Documentation Template

For modules, ensure the prompt requests:

- Public interface (exports only)
- Parameter types and constraints
- Return types and structures
- Side effects (I/O, state changes)

## Prove Plugin Documentation

When documenting prove plugin components, follow these conventions:

- **Skills**: Document the workflow phases, interaction points (AskUserQuestion vs free-form), and references
- **Agents**: Document triggers, tool permissions, model, and output format
- **Commands**: Document frontmatter fields, argument handling, and which skill they delegate to
- **Scripts**: Document usage, flags, and output format

Reference the `scopes` section of `.prove.json` for the canonical list of plugin components.

## Output Validation

Before accepting documentation, verify items NOT covered by the delegation templates or the technical-writer's own quality checklist:

- [ ] YAML frontmatter present with `name`, `type`
- [ ] Every contract from the Subject Identification table is addressed
- [ ] Examples use concrete values (no `...` or `foo`/`bar` placeholders)
- [ ] Error/failure conditions documented

Use `AskUserQuestion` with header "Quality" to confirm: "Approve" (documentation meets standards) / "Revise" (needs improvements).

## Anti-Patterns

| Anti-Pattern | Alternative |
|--------------|-------------|
| Verbose examples with inline commentary | Minimal working examples -- code speaks for itself |
| Explaining what the code does line-by-line | Document behavior and contracts, assume reader can read code |

## Committing

When the user asks to commit documentation, delegate to the `commit` skill. The commit skill reads `.prove.json` scopes for valid commit scopes.

Example: `docs(agentic-doc-writer): document validation-agent interface`
