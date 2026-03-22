---
name: auto-docs
description: Analyze scope and delegate to docs-writer and/or agentic-doc-writer. Triggers on "auto docs", "document everything", "generate docs".
---

# Auto Docs

Generate human-readable and/or LLM-optimized documentation for a given scope. Determine what needs documenting, confirm intent with the user, and delegate to specialized skills.

**Interaction patterns**: See `references/interaction-patterns.md` for `AskUserQuestion` usage.

## Workflow

1. **Resolve scope** -- what to document
2. **Analyze subjects** -- classify documentable items
3. **Confirm with user** -- doc types, output location
4. **Delegate** -- invoke specialized skill(s)
5. **Review** -- present results for approval

## Phase 1: Resolve Scope

Determine what to document based on user input:

| Input | Resolution |
|-------|------------|
| No argument | Session context: files read, written, edited, or discussed in this conversation |
| Topic name (e.g., "auth", "acb-core") | Grep/Glob for matching files, packages, or modules |
| Directory path (e.g., `packages/acb-core/`) | All exported/public code in that directory |
| File path(s) | Document those specific files |

If scope is ambiguous, use `AskUserQuestion` with header "Scope":
- "This session" -- everything touched in this conversation
- "Directory" -- user specifies a path
- "Specific files" -- user lists files

### Session Context Prioritization

When resolving from session context, process in this order:

1. **New files** created this session -- most likely undocumented
2. **Significantly modified files** -- docs may be stale
3. **New agents/skills/commands** -- need both usage docs and contracts
4. **Scripts** -- often created without docs

Skip: test files, self-documenting configs (e.g., tsconfig.json), lock files, build artifacts.

## Phase 2: Analyze Subjects

Classify each item in scope:

| Subject Type | Indicators | Human Docs | Agent Docs |
|-------------|------------|------------|------------|
| **Agent** (`.md` in agents/) | Frontmatter with `tools:`, `model:` | No | Yes -- invocation contract |
| **Skill** (SKILL.md in skills/) | Frontmatter with `name:`, workflow | Yes -- user guide | Yes -- delegation protocol |
| **Command** (`.md` in commands/) | Frontmatter with `description:` | Yes -- usage reference | No |
| **Script** (`.sh` in scripts/) | Executable, flags, CLI usage | Yes -- usage and flags | Only if agents invoke it |
| **Package/Module** (src/, lib/) | Exports, public API | Yes -- API reference | Yes -- integration contract |
| **Config** (.json, .yaml) | Schema, options | Yes -- config guide | Only if agents read it |

Build a recommendation list: `[subject, subject_type, human_docs, agent_docs, reason]`

## Phase 3: Confirm with User

Present analysis via `AskUserQuestion` with header "Doc Types":

- "Both human & agent docs (Recommended)"
- "Human docs only"
- "Agent docs only"
- "Let me pick per subject"

If the user chooses "Let me pick per subject", present a second `AskUserQuestion` (multiSelect) with header "Subjects" listing each subject with its recommended doc type.

### Audience (human docs only)

When delegating to docs-writer, determine the audience. If not obvious from context, use `AskUserQuestion` with header "Audience":
- "Contributor" -- setting up dev environment, understanding internals
- "Consumer" -- integrating with the API/module
- "Operator" -- deploying, configuring, monitoring

### Output Location

Use `AskUserQuestion` with header "Output":

- "Alongside source (Recommended)" -- README.md in the subject's directory
- "Centralized docs/" -- all docs in a top-level `docs/` directory
- "Let me specify" -- user provides a path

## Phase 4: Delegate

Process subjects in this order:
1. Agent docs first (they define contracts that human docs may reference)
2. Human docs second (can reference agent doc contracts)
3. Within each type, order by dependency (core modules before consumers)

### Human docs --> docs-writer skill

Invoke `skills/docs-writer/SKILL.md` with:

```
Document [SUBJECT_TYPE]: [SUBJECT_NAME]
Audience: [AUDIENCE from Phase 3]
Source: [FILE_PATH]
Output: [OUTPUT_PATH]

Context:
[MINIMAL RELEVANT CODE/CONFIG]
```

### Agent docs --> agentic-doc-writer skill

Invoke `skills/agentic-doc-writer/SKILL.md` with:

```
Document [SUBJECT_TYPE]: [SUBJECT_NAME]
Source: [FILE_PATH]
Output: [OUTPUT_PATH]

Context:
[MINIMAL RELEVANT CODE/CONFIG]
```

## Phase 5: Review

After all docs are generated, present a summary:

```
## Documentation Generated

| Subject | Human Docs | Agent Docs | Path |
|---------|-----------|------------|------|
| ...     | ...       | ...        | ...  |

Total: X files created/updated
```

Use `AskUserQuestion` with header "Review":
- "Approve all"
- "Revise" -- user specifies what to change
- "Discard" -- remove all generated docs

## Committing

Delegate to the `commit` skill. The commit skill reads `.prove.json` scopes for valid commit scopes.

Example: `docs(auto-docs): generate human and agent docs for acb-core`
