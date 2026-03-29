---
name: docs-writer
description: Generate human-readable documentation (READMEs, guides, API references, contributor docs). Triggers: "document this", "write docs", "create a README", "write a guide for".
---

# Docs Writer

Delegate writing to the `technical-writer` subagent. Follow `references/interaction-patterns.md` for all `AskUserQuestion` usage.

## Workflow

1. Identify subject type and audience
2. Gather context -- targeted reads, single pass
3. Delegate to `technical-writer` with structured prompt
4. Validate output against checklist below

## Subject Identification

`AskUserQuestion` header "Subject" if ambiguous. For <=3 choices, include "Research & proceed".

| Subject | Indicators | Key Sections |
|---------|------------|--------------|
| **Project** | Root directory, package.json, multiple components | Quick start, usage, architecture, config |
| **API** | HTTP handlers, REST/GraphQL endpoints | Endpoints, request/response, errors, examples |
| **Module** | Package exports, public interfaces | Installation, API surface, examples |
| **Script** | Executable file, CLI flags | Usage, flags table, examples |
| **Workflow** | Multi-step process, multiple tools | Prerequisites, steps, troubleshooting |

## Audience Identification

`AskUserQuestion` header "Audience" if ambiguous. For <=3 choices, include "Research & proceed".

| Audience | Tone | Depth | Assumes |
|----------|------|-------|---------|
| **Contributor** | Casual, direct | Deep on internals | Tech stack familiarity |
| **Consumer** | Precise, professional | Interface-level only | No internal knowledge |
| **Operator** | Practical, task-oriented | Config and operations | Infra/deployment experience |
| **End user** | Friendly, no jargon | Surface-level | Minimal technical background |

## Context Gathering

- Grep to locate targets, then read specific lines
- Document public interface only -- never follow imports recursively
- Complete all reads before delegating

## Delegation to technical-writer

Invoke with:

```
Document [SUBJECT_TYPE]: [SUBJECT_NAME]
Audience: [AUDIENCE_TYPE]

Source: [FILE_PATH]:[LINE_RANGE]

Context:
[MINIMAL RELEVANT CODE/CONFIG]

Requirements:
- Output: [project-readme | api-reference | module-docs | script-docs | workflow-guide]
- Audience: [contributor | consumer | operator | end-user]
- Include: [sections beyond the standard template only]
- Format: Markdown, no YAML frontmatter unless docs system requires it
```

`Include:` lists only subject-specific sections the template does not cover by default.

## Prove Plugin Documentation

| Component | Document |
|-----------|----------|
| **Skills** | Purpose, when to use, workflow phases, interaction points |
| **Agents** | Role, invocation triggers, output format |
| **Commands** | What it does, arguments, delegated skill |
| **Scripts** | Usage, flags, output format, examples |

Reference `.claude/.prove.json` `scopes` for canonical component list.

## Output Validation Checklist

Verify before accepting `technical-writer` output:

- [ ] Title states what the subject is
- [ ] First paragraph answers "what is this and why use it?"
- [ ] Examples are concrete and runnable (no `foo`/`bar`/`...`)
- [ ] Headings create a scannable outline
- [ ] Structured data uses tables, not prose
- [ ] No unexplained jargon on first use
- [ ] No redundant content across sections
- [ ] Tone matches target audience

`AskUserQuestion` header "Quality": "Approve" / "Revise".

## Anti-Patterns

| Anti-Pattern | Instead |
|--------------|---------|
| Reading entire files | Grep target, read specific lines |
| Re-listing template sections in `Include:` | Only add non-default sections |
| Interleaving gathering and writing | Complete all reads before delegating |
| Omitting audience from prompt | Always include `Audience:` |

## Committing

Delegate to `commit` skill. Example: `docs(docs-writer): add README for cafi tool`
