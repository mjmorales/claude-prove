---
name: auto-docs
description: Generate both human-readable and LLM-optimized documentation in one pass. Analyzes the current session context or a specified scope (topic, directory, files) and recommends which documentation types are needed. Triggers on "auto docs", "document everything", "generate docs", or when comprehensive documentation is needed for both human and agent consumers.
---

# Auto Docs

Generate human-readable and/or LLM-optimized documentation for a given scope. Determines what needs documenting, asks the user about intent, and delegates to the appropriate specialized skills.

**Interaction patterns**: See `references/interaction-patterns.md` for when to use `AskUserQuestion` vs free-form discussion.

## Workflow

1. **Resolve scope** — what to document
2. **Analyze subjects** — identify documentable items within scope
3. **Recommend doc types** — which docs are needed and for whom
4. **Confirm with user** — scope, audience, doc types
5. **Delegate** — invoke the appropriate skill(s) for each subject
6. **Review** — present results for approval

## Phase 1: Resolve Scope

Determine what to document based on user input:

| Input | Resolution |
|-------|------------|
| No argument | Use the active session context — look at files read, edited, or discussed in this conversation |
| Topic name (e.g., "auth", "acb-core") | Grep/Glob for matching files, packages, or modules |
| Directory path (e.g., `packages/acb-core/`) | All public-facing code in that directory |
| File path(s) | Document those specific files |

**Active session context**: When no argument is given, scan the conversation for:
- Files that were read, written, or edited
- Packages or modules that were discussed
- New features or commands that were created

If the scope is ambiguous, use `AskUserQuestion` with header "Scope" to clarify:
- "This session" (everything touched in this conversation)
- "Directory" (let user specify a path)
- "Specific files" (let user list files)

## Phase 2: Analyze Subjects

For each item in scope, classify it:

| Subject Type | Indicators | Human Docs Needed? | Agent Docs Needed? |
|-------------|------------|-------------------|-------------------|
| **Agent** (`.md` in agents/) | Frontmatter with `tools:`, `model:` | Rarely — agents are for LLMs | Yes — invocation contract |
| **Skill** (SKILL.md in skills/) | Frontmatter with `name:`, workflow | Yes — user guide | Yes — delegation protocol |
| **Command** (`.md` in commands/) | Frontmatter with `description:` | Yes — usage reference | Rarely |
| **Script** (`.sh` in scripts/) | Executable, flags, CLI usage | Yes — usage and flags | Only if agents invoke it |
| **Package/Module** (src/, lib/) | Exports, public API | Yes — API reference | Yes — integration contract |
| **Config** (.json, .yaml) | Schema, options | Yes — configuration guide | Only if agents read it |

Build a recommendation list: `[subject, subject_type, human_docs, agent_docs, reason]`

## Phase 3: Recommend and Confirm

Present the analysis to the user via `AskUserQuestion` with header "Doc Types":

- "Both human & agent docs (Recommended)" — generate full documentation suite
- "Human docs only" — skip LLM-optimized docs
- "Agent docs only" — skip human-readable docs
- "Let me pick per subject" — show the full list and let user select

If the user chooses "Let me pick per subject", present a second `AskUserQuestion` (multiSelect) with header "Subjects" listing each subject with its recommended doc type.

Also confirm output location via `AskUserQuestion` with header "Output":

- "Alongside source (Recommended)" — README.md in the subject's directory, or docs/ subdirectory
- "Centralized docs/" — all docs in a top-level `docs/` directory
- "Let me specify" — user provides a path

## Phase 4: Delegate

For each subject that needs documentation:

### Human docs → docs-writer skill

Invoke the docs-writer skill (`skills/docs-writer/SKILL.md`) with:

```
Document [SUBJECT_TYPE]: [SUBJECT_NAME]
Audience: [AUDIENCE]
Source: [FILE_PATH]
Output: [OUTPUT_PATH]

Context:
[MINIMAL RELEVANT CODE/CONFIG]
```

### Agent docs → agentic-doc-writer skill

Invoke the agentic-doc-writer skill (`skills/agentic-doc-writer/SKILL.md`) with:

```
Document [SUBJECT_TYPE]: [SUBJECT_NAME]
Source: [FILE_PATH]
Output: [OUTPUT_PATH]

Context:
[MINIMAL RELEVANT CODE/CONFIG]
```

### Delegation order

1. Agent docs first (they define contracts that human docs may reference)
2. Human docs second (can reference agent doc contracts)
3. Within each type, order by dependency (core modules before consumers)

## Phase 5: Review

After all docs are generated, present a summary:

```
## Documentation Generated

| Subject | Human Docs | Agent Docs | Path |
|---------|-----------|------------|------|
| ...     | ...       | ...        | ...  |

Total: X files created/updated
```

Use `AskUserQuestion` with header "Review" to confirm:
- "Approve all" — keep everything as written
- "Revise" — user specifies what to change
- "Discard" — remove all generated docs

## Scope Heuristics

When working from session context, prioritize:

1. **New files** created in this session — most likely undocumented
2. **Significantly modified files** — docs may be stale
3. **New agents/skills/commands** — need both usage docs and contracts
4. **Scripts** — often created without docs

Skip:
- Test files (document the thing being tested, not the test)
- Config files that are self-documenting (e.g., tsconfig.json)
- Lock files, build artifacts

## Committing

When the user asks to commit documentation, delegate to the `commit` skill. The commit skill reads `.prove.json` scopes for valid commit scopes.

Example: `docs(auto-docs): generate human and agent docs for acb-core`
