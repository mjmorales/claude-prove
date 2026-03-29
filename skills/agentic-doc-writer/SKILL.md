---
name: agentic-doc-writer
description: Generate machine-parseable, LLM-optimized documentation for Claude Code agents. Use when documenting agents, subagents, APIs, modules, or any code that other agents will consume. Triggers include "document this agent", "write agent docs", "create API docs for agents", or when documentation needs to be actionable by LLMs.
---

# Agentic Doc Writer

Generate documentation optimized for LLM consumption. Follow `references/interaction-patterns.md` for all `AskUserQuestion` usage.

## Workflow

1. Identify subject type (agent, API, module, code)
2. Gather context -- targeted reads, single pass
3. Delegate to `technical-writer` with structured prompt
4. Review output for contract completeness

## Subject Identification

`AskUserQuestion` header "Subject" if ambiguous. For <=3 choices, include "Research & proceed".

| Subject | Indicators | Key Contracts |
|---------|------------|---------------|
| **Agent** | `.md` in agents dir, `tools:` frontmatter | Triggers, inputs, outputs, workflow |
| **API** | HTTP handlers, REST/GraphQL endpoints | Request/response schemas, errors |
| **Module** | Package exports, public interfaces | Parameters, return types, side effects |
| **Code** | Functions, classes, complex logic | Types, behavior, edge cases |

## Context Gathering

- Grep to locate targets, then read specific lines
- Document public interface only -- never follow imports recursively
- Complete all reads before delegating

## Delegation to technical-writer

Invoke with:

```
Document [SUBJECT_TYPE]: [SUBJECT_NAME]

Source: [FILE_PATH]:[LINE_RANGE]

Context:
[MINIMAL RELEVANT CODE/CONFIG]

Requirements:
- Output: [agent-doc | api-doc | module-doc]
- Include: [specific contracts needed]
- Format: YAML frontmatter + structured markdown
```

### Required Contracts by Subject

**Agent**: Invocation triggers, input contract, output contract (format), workflow steps (numbered), tool permissions

**API**: Request schema (params, body, headers), response schema (success + error), validation rules, error codes

**Module**: Public interface (exports only), parameter types/constraints, return types, side effects (I/O, state)

## Prove Plugin Documentation

| Component | Document |
|-----------|----------|
| **Skills** | Workflow phases, interaction points, references |
| **Agents** | Triggers, tool permissions, model, output format |
| **Commands** | Frontmatter fields, arguments, delegated skill |
| **Scripts** | Usage, flags, output format |

Reference `.claude/.prove.json` `scopes` for canonical component list.

## Output Validation

Verify before accepting:

- [ ] YAML frontmatter has `name`, `type`
- [ ] All contracts from Subject Identification table addressed
- [ ] Examples use concrete values (no `...`/`foo`/`bar`)
- [ ] Error/failure conditions documented

`AskUserQuestion` header "Quality": "Approve" / "Revise".

## Anti-Patterns

| Anti-Pattern | Instead |
|--------------|---------|
| Verbose examples with inline commentary | Minimal working examples |
| Line-by-line code explanation | Document behavior and contracts |

## Committing

Delegate to `commit` skill. Example: `docs(agentic-doc-writer): document validation-agent interface`
