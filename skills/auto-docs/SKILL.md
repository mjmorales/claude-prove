---
name: auto-docs
description: Analyze scope and delegate to docs-writer and/or agentic-doc-writer. Triggers on "auto docs", "document everything", "generate docs".
---

# Auto Docs

Orchestrate documentation generation by resolving scope, classifying subjects, and delegating to `docs-writer` and/or `agentic-doc-writer`. Follow `references/interaction-patterns.md` for all `AskUserQuestion` usage.

## Workflow

1. Resolve scope
2. Classify subjects
3. Confirm doc types, audience, output location with user
4. Delegate to specialized skills
5. Present results for approval

## Step 1: Resolve Scope

| Input | Resolution |
|-------|------------|
| No argument | Session context: files read, written, edited, or discussed |
| Topic name (e.g., "auth", "cafi") | Grep/Glob for matching files/packages/modules |
| Directory path | All exported/public code in that directory |
| File path(s) | Those specific files |

If ambiguous, `AskUserQuestion` header "Scope": "This session" / "Directory" / "Specific files".

### Session Context Priority

1. New files created this session
2. Significantly modified files
3. New agents/skills/commands
4. Scripts

Skip: test files, lock files, build artifacts, self-documenting configs.

## Step 2: Classify Subjects

| Subject Type | Indicators | Human Docs | Agent Docs |
|-------------|------------|------------|------------|
| **Agent** (agents/*.md) | `tools:`/`model:` frontmatter | No | Yes |
| **Skill** (skills/*/SKILL.md) | `name:` frontmatter, workflow | Yes | Yes |
| **Command** (commands/*.md) | `description:` frontmatter | Yes | No |
| **Script** (scripts/*.sh) | Executable, CLI flags | Yes | Only if agents invoke it |
| **Package/Module** (src/, lib/) | Exports, public API | Yes | Yes |
| **Config** (.json, .yaml) | Schema, options | Yes | Only if agents read it |

## Step 3: Confirm with User

`AskUserQuestion` header "Doc Types":
- "Both human & agent docs (Recommended)"
- "Human docs only"
- "Agent docs only"
- "Let me pick per subject"

If "Let me pick per subject": follow up with per-subject `AskUserQuestion`.

**Audience** (human docs): If not obvious, `AskUserQuestion` header "Audience": "Contributor" / "Consumer" / "Operator".

**Output location**: `AskUserQuestion` header "Output":
- "Alongside source (Recommended)"
- "Centralized docs/"
- "Let me specify"

## Step 4: Delegate

Order: agent docs first (define contracts), then human docs (can reference contracts). Within each type, core modules before consumers.

### docs-writer

```
Document [SUBJECT_TYPE]: [SUBJECT_NAME]
Audience: [AUDIENCE]
Source: [FILE_PATH]
Output: [OUTPUT_PATH]

Context:
[MINIMAL RELEVANT CODE/CONFIG]
```

### agentic-doc-writer

```
Document [SUBJECT_TYPE]: [SUBJECT_NAME]
Source: [FILE_PATH]
Output: [OUTPUT_PATH]

Context:
[MINIMAL RELEVANT CODE/CONFIG]
```

## Step 5: Review

Present summary table of generated docs (subject, human/agent, path, file count).

`AskUserQuestion` header "Review": "Approve all" / "Revise" / "Discard".

## Committing

Delegate to `commit` skill. Example: `docs(auto-docs): generate human and agent docs for cafi`
