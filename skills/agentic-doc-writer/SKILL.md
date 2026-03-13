---
name: agentic-doc-writer
description: Generate machine-parseable, LLM-optimized documentation for Claude Code agents. Use when documenting agents, subagents, APIs, modules, or any code that other agents will consume. Triggers include "document this agent", "write agent docs", "create API docs for agents", or when documentation needs to be actionable by LLMs.
---

# Agentic Doc Writer

Generate structured documentation optimized for LLM consumption and agent recollection efficiency.

## Workflow

1. **Identify subject type** (agent, API, module, code)
2. **Gather context efficiently** (targeted reads, avoid full-file scans)
3. **Delegate to technical-writer** agent with structured prompt
4. **Review output** for contract completeness

## Subject Identification

Determine the documentation target:

| Subject | Indicators | Key Contracts |
|---------|------------|---------------|
| **Agent** | `.md` in `.claude/agents/`, frontmatter with `tools:` | Triggers, inputs, outputs, workflow |
| **API** | HTTP handlers, REST endpoints, GraphQL resolvers | Request/response schemas, errors |
| **Module** | Package exports, public interfaces | Parameters, return types, side effects |
| **Code** | Functions, classes, complex logic | Types, behavior, edge cases |

## Context Gathering Best Practices

Minimize context usage:

- **Targeted reads**: Read only the file/function being documented
- **Grep before read**: Use `Grep` to find relevant sections, then read specific lines
- **Avoid recursion**: Don't follow every import; document the interface, not dependencies
- **Single pass**: Gather all needed info before delegating

```
# Good: Targeted
Read -> specific file:lines -> delegate

# Bad: Exploratory
Read file A -> Read import B -> Read import C -> ...
```

## Delegation to technical-writer

Invoke the `technical-writer` subagent with this prompt structure:

```
Document [SUBJECT_TYPE]: [SUBJECT_NAME]

Source: [FILE_PATH]:[LINE_RANGE]

Context:
[PASTE RELEVANT CODE/CONFIG - MINIMAL]

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

## Output Validation Checklist

Before accepting documentation:

- [ ] YAML frontmatter present with `name`, `type`
- [ ] All inputs explicitly typed
- [ ] All outputs explicitly structured
- [ ] Examples are concrete (no `...` placeholders)
- [ ] No ambiguous language ("may", "might", "sometimes")
- [ ] Error conditions documented

## Anti-Patterns

Avoid these context-wasting patterns:

| Anti-Pattern | Impact | Alternative |
|--------------|--------|-------------|
| Reading entire file | Token waste | Grep for target, read lines |
| Documenting internals | Noise | Document public interface only |
| Verbose examples | Context bloat | Minimal working examples |
| Redundant explanations | Duplication | Assume LLM baseline knowledge |
| Nested exploration | Exponential reads | Stop at interface boundary |

## Example Invocation

User: "Document the go-linter agent"

1. Read `.claude/agents/go-linter.md` (single file)
2. Extract: name, description, tools, workflow
3. Delegate:

   ```
   Document agent: go-linter

   Source: .claude/agents/go-linter.md

   Context:
   [paste frontmatter + body]

   Requirements:
   - Output: agent-doc
   - Include: triggers, inputs, outputs, workflow
   - Format: YAML frontmatter + structured markdown
   ```

4. Validate output against checklist
