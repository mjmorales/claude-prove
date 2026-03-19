---
name: docs-writer
description: Generate clear, human-readable documentation for projects, APIs, modules, scripts, or workflows. Use when creating READMEs, getting-started guides, API references, architecture overviews, or contributor docs. Triggers include "document this", "write docs", "create a README", "write a guide for", or when documentation needs to be readable by humans onboarding or integrating.
---

# Docs Writer

Generate structured documentation optimized for human readability, scannability, and practical use.

**Interaction patterns**: See `references/interaction-patterns.md` for when to use `AskUserQuestion` vs free-form discussion.

## Workflow

1. **Identify subject type** (project, API, module, script, workflow)
2. **Identify audience** (contributor, consumer, operator)
3. **Gather context efficiently** (targeted reads, avoid full-file scans)
4. **Delegate to technical-writer** agent with structured prompt
5. **Review output** for clarity and completeness

## Subject Identification

Use `AskUserQuestion` with header "Subject" if the type isn't obvious from context:
- "Project" (entire repo or package — README, getting-started)
- "API" (HTTP endpoints, REST/GraphQL — reference docs)
- "Module" (package exports, library interface — usage docs)
- "Script" (CLI tool, build script — usage and flags)
- "Workflow" (multi-step process — guide or runbook)

| Subject | Indicators | Key Sections |
|---------|------------|--------------|
| **Project** | Root directory, package.json, multiple components | Quick start, usage, architecture, config |
| **API** | HTTP handlers, REST endpoints, GraphQL resolvers | Endpoints, request/response, errors, examples |
| **Module** | Package exports, public interfaces | Installation, API surface, examples |
| **Script** | Executable file, CLI flags, `--help` | Usage, flags table, examples |
| **Workflow** | Multi-step process, involves multiple tools | Prerequisites, steps, troubleshooting |

## Audience Identification

Use `AskUserQuestion` with header "Audience" if the audience isn't obvious:
- "New contributor" (setting up dev environment, understanding structure)
- "API consumer" (integrating with the API, needs precise schemas)
- "Operator" (deploying, configuring, monitoring)
- "End user" (using the tool/product, non-technical or semi-technical)

| Audience | Tone | Depth | Assumes |
|----------|------|-------|---------|
| **Contributor** | Casual, direct | Deep on internals | Familiarity with the tech stack |
| **Consumer** | Precise, professional | Interface-level only | No knowledge of internals |
| **Operator** | Practical, task-oriented | Config and operations | Infra/deployment experience |
| **End user** | Friendly, no jargon | Surface-level | Minimal technical background |

## Context Gathering Best Practices

Minimize context usage:

- **Targeted reads**: Read only the file/component being documented
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
Audience: [AUDIENCE_TYPE]

Source: [FILE_PATH]:[LINE_RANGE]

Context:
[PASTE RELEVANT CODE/CONFIG — MINIMAL]

Requirements:
- Output: [project-readme | api-reference | module-docs | script-docs | workflow-guide]
- Audience: [contributor | consumer | operator | end-user]
- Include: [specific sections needed]
- Format: Markdown, no YAML frontmatter unless docs system requires it
```

### Project Documentation Prompt

Ensure the prompt requests:

- One-line project description
- Quick start (3-5 commands max)
- Primary usage workflows with examples
- Architecture overview (if multi-component)
- Configuration reference (table format)
- Contributing guide (dev setup, tests, submit flow)

### API Reference Prompt

Ensure the prompt requests:

- Endpoint method and path
- Request parameters table (name, type, required, description)
- Concrete example request (curl or fetch, real values)
- Success response with example body
- Error table (code, condition, body)

### Module Documentation Prompt

Ensure the prompt requests:

- What the module provides and when to use it
- Installation/import instructions
- Public API with types and descriptions
- 1-2 complete working examples

### Script / CLI Documentation Prompt

Ensure the prompt requests:

- One-line description
- Usage syntax
- Flags table (flag, description, default)
- 2-3 concrete example invocations

### Workflow / Guide Prompt

Ensure the prompt requests:

- Prerequisites (tools, access, context needed)
- Numbered steps with concrete commands/actions
- Expected output at key checkpoints
- Troubleshooting section for common failures

## Prove Plugin Documentation

When documenting prove plugin components, follow these conventions:

- **Skills**: Document purpose, when to use, workflow phases, user interaction points
- **Agents**: Document role, when to invoke, what it produces
- **Commands**: Document what it does, arguments, which skill it delegates to
- **Scripts**: Document usage, flags, output format, examples

Reference the `scopes` section of `.prove.json` for the canonical list of plugin components.

## Output Validation Checklist

Before accepting documentation:

- [ ] Title clearly states what the subject is
- [ ] First paragraph answers "what is this and why would I use it?"
- [ ] All examples are concrete and runnable
- [ ] Headings create a scannable outline
- [ ] Tables used for structured data instead of prose
- [ ] No jargon without context on first use
- [ ] No redundant content — each section adds new information
- [ ] Tone matches the target audience

Use `AskUserQuestion` with header "Quality" to confirm: "Approve" (documentation meets standards) / "Revise" (needs improvements).

## Anti-Patterns

| Anti-Pattern | Impact | Do This Instead |
|--------------|--------|-----------------|
| Leading with history/motivation | Reader wants to *use* it, not hear the origin story | Lead with quick start |
| Placeholder examples (`foo`, `...`) | Can't copy-paste and run | Use realistic values |
| Documenting internals in public docs | Noise for the consumer | Document the interface |
| Walls of text without headings | Unscannable | Break into headed sections |
| Restating what the code says | Goes stale, adds no value | Explain *why* and *when* |
| Over-documenting obvious things | Wastes reader's time | Assume baseline competence |
| Reading entire files for context | Token waste | Grep for target, read lines |

## Committing

When the user asks to commit documentation, delegate to the `commit` skill. The commit skill reads `.prove.json` scopes for valid commit scopes.

Example: `docs(docs-writer): add README for acb-core package`
