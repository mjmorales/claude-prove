---
name: docs
description: >
  Unified documentation skill. Generates human-readable docs (READMEs, guides,
  API references, getting-started), LLM-optimized agent/API docs, and manages
  CLAUDE.md (full regeneration or single-directive updates). Triggers: "write
  docs", "document this", "README", "API reference", "getting-started",
  "LLM docs", "agent docs", "CLAUDE.md", "claude-md update", "add directive".
---

# docs

Dispatches by subcommand. Follows `references/interaction-patterns.md` for all `AskUserQuestion` usage.

| Subcommand | Purpose |
|------------|---------|
| `human [subject]` | Human-readable docs — delegates to `technical-writer` agent |
| `agent [subject]` | LLM-optimized agent/API/module docs |
| `both [subject]` (default) | Auto-docs: resolve scope, run both audiences |
| `claude-md generate` | Full CLAUDE.md generation via `claude-prove claude-md` CLI |
| `claude-md update <directive>` | Append/update single directive with optimization + craft certification |

Parse first token of `$ARGUMENTS` as subcommand. If absent, default to `both` with empty subject (session context).

---

## Subcommand: `human`

Delegate to `technical-writer` subagent. One-pass gather, one-pass delegate.

### Subject + Audience

`AskUserQuestion` header "Subject" if ambiguous (include "Research & proceed" with <=3 options):

| Subject | Indicators | Key Sections |
|---------|------------|--------------|
| **Project** | Root dir, package.json, multiple components | Quick start, usage, architecture, config |
| **API** | HTTP handlers, REST/GraphQL endpoints | Endpoints, request/response, errors, examples |
| **Module** | Package exports, public interfaces | Install, API surface, examples |
| **Script** | Executable file, CLI flags | Usage, flags table, examples |
| **Workflow** | Multi-step process, multiple tools | Prerequisites, steps, troubleshooting |

`AskUserQuestion` header "Audience" if ambiguous:

| Audience | Tone | Depth | Assumes |
|----------|------|-------|---------|
| **Contributor** | Casual, direct | Deep on internals | Tech stack familiarity |
| **Consumer** | Precise, professional | Interface-level only | No internal knowledge |
| **Operator** | Practical, task-oriented | Config and operations | Infra/deployment experience |
| **End user** | Friendly, no jargon | Surface-level | Minimal technical background |

### Context Gathering

- Grep to locate targets, then read specific lines
- Document public interface only — never follow imports recursively
- Complete all reads before delegating

### Delegation Prompt

Invoke `technical-writer` agent with:

```
Document [SUBJECT_TYPE]: [SUBJECT_NAME]
Audience: [AUDIENCE_TYPE]

Source: [FILE_PATH]:[LINE_RANGE]

Context:
[MINIMAL RELEVANT CODE/CONFIG]

Requirements:
- Output: [project-readme | api-reference | module-docs | script-docs | workflow-guide]
- Audience: [contributor | consumer | operator | end-user]
- Include: [subject-specific sections the template does not cover by default]
- Format: Markdown, no YAML frontmatter unless docs system requires it
```

### Validation

- [ ] Title states what the subject is
- [ ] First paragraph answers "what is this and why use it?"
- [ ] Examples are concrete and runnable (no `foo`/`bar`/`...`)
- [ ] Headings create a scannable outline
- [ ] Structured data uses tables, not prose
- [ ] No unexplained jargon on first use
- [ ] Tone matches target audience

`AskUserQuestion` header "Quality": "Approve" / "Revise".

---

## Subcommand: `agent`

Generate machine-parseable, LLM-consumable documentation. Delegate to `technical-writer` with agent-doc output flag.

### Subject Identification

`AskUserQuestion` header "Subject" if ambiguous:

| Subject | Indicators | Required Contracts |
|---------|------------|-------------------|
| **Agent** | `.md` in agents dir, `tools:` frontmatter | Triggers, input contract, output contract, workflow steps (numbered), tool permissions |
| **API** | HTTP handlers, REST/GraphQL endpoints | Request schema (params, body, headers), response schema (success + error), validation rules, error codes |
| **Module** | Package exports, public interfaces | Public interface (exports only), parameter types/constraints, return types, side effects (I/O, state) |
| **Code** | Functions, classes, complex logic | Types, behavior, edge cases |

### Delegation Prompt

```
Document [SUBJECT_TYPE]: [SUBJECT_NAME]

Source: [FILE_PATH]:[LINE_RANGE]

Context:
[MINIMAL RELEVANT CODE/CONFIG]

Requirements:
- Output: [agent-doc | api-doc | module-doc]
- Include: [specific contracts from table above]
- Format: YAML frontmatter + structured markdown
```

### Validation

- [ ] YAML frontmatter has `name`, `type`
- [ ] All contracts from Subject table addressed
- [ ] Examples use concrete values (no `...`/`foo`/`bar`)
- [ ] Error/failure conditions documented

`AskUserQuestion` header "Quality": "Approve" / "Revise".

---

## Subcommand: `both` (default)

Resolve scope, classify subjects, run agent docs first (define contracts), then human docs.

### Step 1 — Resolve Scope

| Input | Resolution |
|-------|------------|
| No argument | Session context: files created/modified/discussed this session |
| Topic name | Grep/Glob for matching files/packages/modules |
| Directory path | All exported/public code in that directory |
| File path(s) | Those specific files |

Session priority: new files > significantly modified > new agents/skills/commands > scripts. Skip: test files, lock files, build artifacts, self-documenting configs.

If ambiguous: `AskUserQuestion` header "Scope": "This session" / "Directory" / "Specific files".

### Step 2 — Classify Subjects

| Subject Type | Indicators | Human Docs | Agent Docs |
|-------------|------------|------------|------------|
| **Agent** (agents/*.md) | `tools:`/`model:` frontmatter | No | Yes |
| **Skill** (skills/*/SKILL.md) | `name:` frontmatter, workflow | Yes | Yes |
| **Command** (commands/*.md) | `description:` frontmatter | Yes | No |
| **Script** (scripts/*.sh) | Executable, CLI flags | Yes | Only if agents invoke it |
| **Package/Module** (src/, lib/) | Exports, public API | Yes | Yes |
| **Config** (.json, .yaml) | Schema, options | Yes | Only if agents read it |

### Step 3 — Confirm

`AskUserQuestion` header "Doc Types":
- "Both human & agent docs (Recommended)"
- "Human docs only"
- "Agent docs only"
- "Let me pick per subject"

If human docs selected and audience non-obvious: `AskUserQuestion` header "Audience": "Contributor" / "Consumer" / "Operator".

`AskUserQuestion` header "Output":
- "Alongside source (Recommended)"
- "Centralized docs/"
- "Let me specify"

### Step 4 — Delegate

Order: agent docs first (establish contracts), human docs second (can reference them). Within each type: core modules before consumers. Dispatch to `human` and `agent` subcommand workflows above.

### Step 5 — Review

Present summary table (subject, human/agent, path, file count).

`AskUserQuestion` header "Review": "Approve all" / "Revise" / "Discard".

---

## Subcommand: `claude-md generate`

Full CLAUDE.md regeneration. Scans codebase (tech stack, conventions, structure), reads `.claude/.prove.json`, composes deterministic output.

### Execution

1. `$PLUGIN` = absolute path to this plugin's root (parent of `skills/`)
2. `$CWD` = user's cwd (target project, not plugin dir)
3. Run: `bun run $PLUGIN/packages/cli/bin/run.ts claude-md generate --project-root $CWD --plugin-dir $PLUGIN`
4. Display CLI output

### Related CLI Subcommands

| Command | Purpose |
|---------|---------|
| `claude-md scan --project-root $CWD --plugin-dir $PLUGIN` | Scanner only, JSON output |
| `claude-md subagent-context --project-root $CWD --plugin-dir $PLUGIN` | Compact context for subagent injection |

Safe to re-run — the CLI owns the file.

---

## Subcommand: `claude-md update <directive>`

Append or update a single directive in project or user-global CLAUDE.md. **Never write `$ARGUMENTS` verbatim** — instead, route it through Step 3 (optimize via `llm-prompt-engineer`) and Step 4 (certify via `/prove:prompting craft`) before writing.

### Step 1 — Resolve scope

`AskUserQuestion` header "Scope":
- **Project** — write to `<cwd>/CLAUDE.md`
- **User Global** — write to `$HOME/.claude/CLAUDE.md`

If **User Global**, resolve symlinks before writing:

- Run `readlink -f "$HOME/.claude/CLAUDE.md"` (or `realpath`). If it resolves into `~/.claude-envs/pool/...`, use the resolved path as the write target.
- **Never replace the symlink with a regular file** — that decouples the active claude-env. Instead, write to the resolved target.
- If the path does not exist yet and `~/.claude/` is itself a symlink into `~/.claude-envs/<env>/`, create the file at the resolved pool location (`~/.claude-envs/pool/...`).

### Step 2 — Choose action

`AskUserQuestion` header "Action":
- **Append** — add as new section at end of file
- **Update Section** — replace an existing named section

If **Update Section**: ask free-form for the section heading. Read target, locate heading, confirm match. If ambiguous or missing, fall back to Append and tell the user.

If target file does not exist, skip this question — the directive becomes the file's first content.

### Step 3 — Optimize via subagent

Invoke `llm-prompt-engineer` (Task tool) with:

> Rewrite the following directive for inclusion in a CLAUDE.md file. CLAUDE.md is consumed as a persistent system directive by Claude on every turn. Apply primacy positioning, operational phrasing (what to do, not how to think), paired constraints (every "never X" gets an "instead, do Y"), and structural anchoring (heading + tight bullets). Preserve all semantic requirements. Output only the rewritten directive markdown — no commentary, no fences.
>
> Directive:
> $ARGUMENTS

Capture output as `DRAFT`.

### Step 4 — Certify via craft

Run `/prove:prompting craft` with `DRAFT` as input. Capture certified output as `CERTIFIED`.

If craft flags issues: apply them and re-run once. If it still fails, surface findings and stop.

### Step 5 — Review gate

Show the user:
- Target path (resolved, post-symlink)
- Action (Append / Update Section — and which section)
- `CERTIFIED` text in a fenced block

`AskUserQuestion` header "Review":
- **Insert** — write to disk
- **Revise** — return to step 3 with user feedback

### Step 6 — Write

- **Append** or **new file**: append `\n\n` + `CERTIFIED` to target (or create with `CERTIFIED` as sole content). Ensure single trailing newline.
- **Update Section**: replace from matched heading up to (but excluding) next heading of equal or higher level with `CERTIFIED`. Preserve surrounding content exactly.

Use Edit or Write on the resolved path. Never rewrite `~/.claude/CLAUDE.md` directly when it resolves elsewhere — instead, write to the `readlink -f` target so the symlink stays intact.

Report write with absolute path and byte delta.

---

## Anti-Patterns

| Anti-Pattern | Instead |
|--------------|---------|
| Reading entire files | Grep target, read specific lines |
| Interleaving gathering and writing | Complete all reads before delegating |
| Omitting audience from `human` prompt | Always include `Audience:` |
| Verbose examples with inline commentary (agent docs) | Minimal working examples |
| Line-by-line code explanation (agent docs) | Document behavior and contracts |
| Writing raw user directive to CLAUDE.md | Optimize + certify first (update flow) |
| Overwriting `~/.claude/CLAUDE.md` symlink | Resolve first, write to pool target |

## Committing

Delegate to `commit` skill. Example messages:
- `docs(docs): add README for cafi tool`
- `docs(docs): document validation-agent interface`
- `docs(docs): regenerate CLAUDE.md`
- `docs(claude-md): add tool vs pack boundary directive`

`claude-md update` never commits automatically — the user decides when.
