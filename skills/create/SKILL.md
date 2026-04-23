---
name: create
description: Create Claude Code skills, slash commands, subagents, or technical specs. Dispatches by type. Use when the user wants to create a new skill, new slash command, new subagent, new agent, write a spec, draft a specification, formalize a design, audit a spec, promote a decision record, or needs help with skill descriptions, command frontmatter, agent tool permissions, or RFC-style technical documentation. Triggers on "create a skill", "new skill", "create a command", "new slash command", "create an agent", "new subagent", "write a spec", "spec for", "draft an RFC", "formalize this", "audit this spec", "revise the spec".
---

# Create

Unified creator for skills, commands, agents, and specs. Parses `--type` from `$ARGUMENTS` (or asks) and runs the matching workflow.

**Shared references:** `references/creator-conventions.md`, `references/prompt-engineering-guide.md`, `references/interaction-patterns.md`.

## Dispatch

Parse `$ARGUMENTS` for `--type skill|command|agent|spec` (or leading positional token `skill|command|agent|spec`). If ambiguous, `AskUserQuestion` (header "Type"):

- "Skill" — new Claude Code skill
- "Command" — new slash command
- "Agent" — new subagent
- "Spec" — technical specification (delegates to `spec-writer` agent)

Remainder of `$ARGUMENTS` is the subject/name hint.

---

## Shared Workflow

All types follow this skeleton; per-type sections add fields and validation.

### 1. Gather Requirements

`AskUserQuestion` for discrete choices; free-form for open-ended.

**Common fields:**
- Purpose (free-form): what it does, when to invoke it.
- Location — `AskUserQuestion` header "Location":
  - "Project" — `.claude/<kind>/` (versioned with repo)
  - "User Global" — `~/.claude/<kind>/` (across projects)
  - "Plugin" — `<kind>/` (prove-style plugin root)

Type-specific fields follow (see per-type sections).

### 2. Generate

Apply `references/prompt-engineering-guide.md` techniques. Derive hyphen-case name from purpose when not supplied.

### 3. Quality Self-Check

Before presenting, verify:
- Primacy: critical directives appear early.
- Constraint pairing: every "never X" has an "instead, do Y".
- No preamble bloat, no redundant restatement.
- Model calibration: Opus < Sonnet < Haiku in scaffolding.
- Token budget fits consumption context.

Fix failures before presenting.

### 4. Validate

Per-type checklist (see sections below). Must pass before writing.

### 5. Review Gate

`AskUserQuestion` header "Review": "Create" / "Revise".

### 6. Commit Delegation

On commit request, delegate to the `commit` skill. Do not craft ad-hoc commits.

### Plugin Scope Registration

When adding to a plugin, ensure `.claude/.prove.json` has the scope:

```json
"scopes": { "commands": "commands/", "agents": "agents/", "skills": "skills/" }
```

---

## Type: Skill

Path: `skills/<name>/SKILL.md` (plus optional `references/`, `assets/`, scripts).

### Gather (skill-specific)

- **Interaction pattern** — `AskUserQuestion` header "Interaction":
  - "Autonomous" — no user input
  - "Interactive" — uses `AskUserQuestion` gates
  - "Delegating" — thin wrapper over an agent
- **Resources** — `AskUserQuestion` header "Resources" (multiSelect):
  - "Reference docs" (`references/<topic>.md`)
  - "Templates/assets" (`assets/<template>.md`)
  - "Scripts"
  - "None"

### Frontmatter

```yaml
---
name: <hyphen-case>
description: <action-first; 2-3 trigger scenarios; natural trigger phrases>
---
```

**Description tuning** (highest-leverage field):
- Front-load the primary action verb.
- Include 2-3 concrete trigger scenarios.
- List natural trigger phrases the user would say.

### Body by Interaction Pattern

- **Autonomous**: numbered workflow steps.
- **Interactive**: gather → execute → validate → review gate.
- **Delegating**: before delegating → delegation prompt → after delegation.

### Validation Checklist

- [ ] Directory name matches `name` frontmatter
- [ ] `name` and `description` present
- [ ] Description front-loads action and includes trigger scenarios
- [ ] Body uses numbered steps for workflows
- [ ] Interactive skills follow `references/interaction-patterns.md`
- [ ] Token budget appropriate for skill context
- [ ] Referenced resources exist or are in plan
- [ ] Plugin skills: `skills` scope in `.claude/.prove.json`

### Optional Command Wrapper

If the skill should be user-invocable via `/prove:<name>`, offer a thin command:

```markdown
---
description: <short skill description>
argument-hint: "[input]"
---

# <Name>: $ARGUMENTS

Load and follow `skills/<name>/SKILL.md`.
```

Commit example: `feat(skills): add <name> skill`.

---

## Type: Command

Path: `<location>/commands/<name>.md` (or `commands/<ns>/<name>.md` for namespaced `/ns:name`).

### Gather (command-specific)

- **Arguments** — `AskUserQuestion` header "Arguments":
  - "No arguments"
  - "Single argument" — use `$ARGUMENTS`
  - "Multiple arguments" — use `$1`, `$2`, ...
- **Tool restrictions** — `AskUserQuestion` header "Tools":
  - "Full access (Recommended)" — omit `allowed-tools`
  - "Read-only" — `Read, Grep, Glob`
  - "Git-only" — `Bash(git *)`
  - "Custom" — user specifies
- **Skill delegation** (plugins only, free-form): which skill does it wrap? Plugin commands are thin entry points.

### Frontmatter

```yaml
---
description: <action-first; shown in /help and autocomplete (~250 char cap)>
argument-hint: "[expected args]"
allowed-tools: <if restricted>
---
```

### Body Templates

**Standalone:**

```markdown
---
description: <action>
argument-hint: "[input]"
---

<Command prompt content>
```

**Plugin wrapper (thin — logic lives in skill):**

```markdown
---
description: <action>
argument-hint: "[input]"
---

# <Name>: $ARGUMENTS

Load and follow `skills/<name>/SKILL.md`.
```

### Placement

| Location | Path |
|----------|------|
| Project | `.claude/commands/<name>.md` |
| User | `~/.claude/commands/<name>.md` |
| Plugin | `commands/<name>.md` |
| Namespaced | `commands/<ns>/<name>.md` → `/ns:name` |

### Validation Checklist

- [ ] Filename lowercase, hyphen-delimited, matches purpose
- [ ] `description` present (required for model invocation and `/help`)
- [ ] `argument-hint` set if command accepts arguments
- [ ] Tool restrictions match intent (read-only for analysis, etc.)
- [ ] Plugin commands delegate to a skill — no business logic in the file
- [ ] Multi-step workflows use numbered steps
- [ ] Body does not restate the description

Commit example: `feat(commands): add <name> command`.

---

## Type: Agent

Path: `<location>/agents/<name>.md`.

### Gather (agent-specific)

- **Tool permissions** — `AskUserQuestion` header "Tools":
  - "Read-only (Recommended for reviewers)" — `Read, Grep, Glob`
  - "Read + Research" — `Read, Grep, Glob, WebFetch, WebSearch`
  - "Full developer" — `Read, Write, Edit, Bash, Glob, Grep`
  - "Custom"
- **Model** — `AskUserQuestion` header "Model":
  - "opus" — complex reasoning, architecture
  - "sonnet (Recommended)" — general development
  - "haiku" — simple, repetitive, cost-efficient

### Frontmatter

```yaml
---
name: <hyphen-case>
description: <WHAT it does + WHEN to invoke; drives auto-delegation>
tools: <scoped permission list>
model: opus|sonnet|haiku
---
```

### System Prompt Structure

1. Identity and purpose
2. Available tools and when to use each
3. Workflow — numbered decision loop
4. Output format and reporting
5. Constraints and guardrails
6. Failure handling

**Model calibration:**
- **Opus**: lean, few guardrails. Target ~285-636 tokens (built-in agent range).
- **Sonnet**: moderate detail, explicit workflow steps.
- **Haiku**: more scaffolding, explicit examples, precise constraints.

### Validation Checklist

- [ ] Name hyphen-case, matches filename
- [ ] Description explains what + when (drives auto-delegation)
- [ ] Tools match role (read-only for reviewers; no `Write`/`Edit`/`Bash` unless needed)
- [ ] System prompt has clear responsibilities and workflow
- [ ] Output format specified
- [ ] Model appropriate for task complexity
- [ ] Plugin agents: `agents` scope in `.claude/.prove.json`

Commit example: `feat(agents): add <name> agent`.

---

## Type: Spec

Orchestrates spec lifecycle (create, revise, audit). **Delegates all writing to the `spec-writer` agent** — this skill does not author spec text directly.

### Step 1: Determine Mode

If not obvious from context, `AskUserQuestion` header "Mode" with "Research & proceed" per `references/interaction-patterns.md`:

- **New Draft** — from description, decision records, or conversation
- **Revise** — edit existing spec (user gives path or search `specs/`)
- **Audit** — review for completeness, ambiguity, consistency; no modifications

Defaults:
- `$ARGUMENTS` points to a `.spec.md` file → Revise
- `$ARGUMENTS` references `.prove/decisions/` → New Draft

### Step 2: Gather Context

**New Draft:**
1. Read referenced decision records; extract chosen option and design details.
2. Check `specs/` for related specs to cross-reference.
3. Confirm scope (in/out of scope) with user.

**Revise:**
1. Read the spec in full.
2. Clarify desired changes (additions, removals, clarifications, restructuring).
3. Determine version bump: major (breaking) or minor (additive/clarification).

**Audit:**
1. Read the spec in full.
2. Optionally read related specs for cross-reference consistency.

### Step 3: Delegate to `spec-writer` Agent

Launch the `spec-writer` agent with a structured prompt. The agent owns RFC conventions, section structure (Purpose, Scope, Terminology, Conformance, normative body, Change Log), normative language, and self-auditing.

**New Draft:**

```markdown
Mode: New Draft
Subject: [title]
Version: 0.1 (Draft)
Input context: [decision records, brainstorm notes, or requirements]
Scope:
- In scope: [what the spec defines]
- Out of scope: [what it excludes]
Related specs: [existing specs in specs/ to cross-reference]
Write to: specs/[slug].spec.md
```

**Revise:**

```markdown
Mode: Revise
Spec path: specs/[name].spec.md
Current version: [X.Y]
Changes requested: [what to add, remove, or modify]
Version bump: [major | minor]
Update in place.
```

**Audit:**

```markdown
Mode: Audit
Spec path: specs/[name].spec.md
Run the full Completeness Checklist. Report findings as:
- Location (section number or line)
- Issue description
- Severity (Critical / Important / Improvement)
- Suggested fix
Do not modify the spec.
```

### Step 4: Review Output

- **New Draft**: verify file at `specs/[slug].spec.md` follows expected structure. Report location and version.
- **Revise**: verify version bump, Change Log update, cross-reference resolution. Report changes.
- **Audit**: present findings by severity. `AskUserQuestion` header "Next step": "Fix issues" (switch to Revise) / "Done".

### Rules

- Delegate writing to the `spec-writer` agent; this skill orchestrates only.
- Confirm scope before drafting; prefer promoting existing decision records over starting from scratch.

Commit examples:
- `docs(specs): draft validation config v2 specification`
- `docs(specs): revise handoff protocol — add context fields`
