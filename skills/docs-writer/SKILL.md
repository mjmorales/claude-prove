---
name: docs-writer
description: Generate human-readable documentation (READMEs, guides, API references, contributor docs). Triggers: "document this", "write docs", "create a README", "write a guide for".
---

# Docs Writer

Generate structured documentation optimized for human readability, scannability, and practical use. Delegates writing to the `technical-writer` subagent.

**Interaction patterns**: See `/references/interaction-patterns.md` for `AskUserQuestion` vs free-form rules.

## Workflow

1. **Identify subject type** (project, API, module, script, workflow)
2. **Identify audience** (contributor, consumer, operator, end user)
3. **Gather context** -- targeted reads only, single pass
4. **Delegate to technical-writer** with structured prompt including audience
5. **Validate output** against the Output Validation Checklist below

## Subject Identification

Use `AskUserQuestion` with header "Subject" if the type is ambiguous. For <=3 choices, include "Research & proceed" per the Delegation pattern.

| Subject | Indicators | Key Sections |
|---------|------------|--------------|
| **Project** | Root directory, package.json, multiple components | Quick start, usage, architecture, config |
| **API** | HTTP handlers, REST endpoints, GraphQL resolvers | Endpoints, request/response, errors, examples |
| **Module** | Package exports, public interfaces | Installation, API surface, examples |
| **Script** | Executable file, CLI flags, `--help` | Usage, flags table, examples |
| **Workflow** | Multi-step process, involves multiple tools | Prerequisites, steps, troubleshooting |

## Audience Identification

Use `AskUserQuestion` with header "Audience" if the audience is ambiguous. For <=3 choices, include "Research & proceed" per the Delegation pattern.

| Audience | Tone | Depth | Assumes |
|----------|------|-------|---------|
| **Contributor** | Casual, direct | Deep on internals | Familiarity with the tech stack |
| **Consumer** | Precise, professional | Interface-level only | No knowledge of internals |
| **Operator** | Practical, task-oriented | Config and operations | Infra/deployment experience |
| **End user** | Friendly, no jargon | Surface-level | Minimal technical background |

## Context Gathering

- **Grep before read**: Locate relevant sections with `Grep`, then read specific lines
- **Interface boundary**: Document the public interface, not dependencies. Never follow imports recursively.
- **Single pass**: Gather all needed context before delegating -- do not interleave gathering and writing

## Delegation to technical-writer

The `technical-writer` agent already has templates for each subject type. Your job is to provide it with accurate context and clear requirements -- not to repeat its templates.

Invoke with this structure:

```
Document [SUBJECT_TYPE]: [SUBJECT_NAME]
Audience: [AUDIENCE_TYPE]

Source: [FILE_PATH]:[LINE_RANGE]

Context:
[PASTE RELEVANT CODE/CONFIG -- MINIMAL]

Requirements:
- Output: [project-readme | api-reference | module-docs | script-docs | workflow-guide]
- Audience: [contributor | consumer | operator | end-user]
- Include: [specific sections needed beyond the standard template]
- Format: Markdown, no YAML frontmatter unless docs system requires it
```

Populate `Include:` only with sections specific to this subject that the standard template might miss. Do NOT re-list sections the technical-writer already covers by default.

## Prove Plugin Documentation

When documenting prove plugin components:

| Component | Document |
|-----------|----------|
| **Skills** | Purpose, when to use, workflow phases, user interaction points |
| **Agents** | Role, when to invoke, what it produces |
| **Commands** | What it does, arguments, which skill it delegates to |
| **Scripts** | Usage, flags, output format, examples |

Reference `.prove.json` `scopes` for the canonical component list.

## Output Validation Checklist

Before accepting output from technical-writer, verify:

- [ ] Title clearly states what the subject is
- [ ] First paragraph answers "what is this and why would I use it?"
- [ ] All examples are concrete and runnable (no `foo`, `bar`, `...`)
- [ ] Headings create a scannable outline
- [ ] Tables used for structured data instead of prose
- [ ] No jargon without context on first use
- [ ] No redundant content -- each section adds new information
- [ ] Tone matches the target audience

Use `AskUserQuestion` with header "Quality" to confirm: "Approve" / "Revise".

## Anti-Patterns

These are anti-patterns for **this skill's workflow** (context gathering and delegation). The technical-writer agent handles output quality independently.

| Anti-Pattern | Do This Instead |
|--------------|-----------------|
| Reading entire files for context | Grep for target, read specific lines |
| Re-listing the technical-writer's template sections in `Include:` | Only add sections beyond the default template |
| Interleaving context gathering and writing | Complete all reads before delegating |
| Delegating without specifying audience | Always include `Audience:` in the prompt |

## Committing

Delegate to the `commit` skill. It reads `.prove.json` scopes for valid commit scopes.

Example: `docs(docs-writer): add README for acb-core package`
