---
name: spec-writer
description: Create, revise, and audit technical specifications following RFC/IETF conventions. Use when the user wants to write a new spec, edit an existing spec, review a spec for completeness, or formalize a design decision into a specification document. Triggers on "write a spec", "spec for", "formalize this", "draft a specification", "audit this spec", "revise the spec", "protocol spec", "format spec", or any request to create structured technical documentation with normative requirements. Also triggers when the user has a brainstorm decision record they want to turn into a formal spec.
---

# Spec Writer

Orchestrate spec lifecycle (create, revise, audit). Delegate all writing to the `spec-writer` agent.

## Workflow

### Step 1: Determine Mode

If not obvious from context, use AskUserQuestion (header "Mode") with "Research & proceed" per `references/interaction-patterns.md`:

- **New Draft** — from user description, decision records, or conversation context
- **Revise** — edit existing spec (user provides path or search `specs/`)
- **Audit** — review for completeness, ambiguity, consistency without modifying

Default to Revise if `$ARGUMENTS` points to a `.spec.md` file. Default to New Draft if it references a `.prove/decisions/` record.

### Step 2: Gather Context

**New Draft:**
1. Read referenced decision records; extract chosen option and design details
2. Check `specs/` for related specs to cross-reference
3. Confirm scope with user (what it covers, what it excludes)

**Revise:**
1. Read the spec in full
2. Clarify desired changes (additions, removals, clarifications, restructuring)
3. Determine version bump: major (breaking) or minor (additive/clarification)

**Audit:**
1. Read the spec in full
2. Optionally read related specs for cross-reference consistency

### Step 3: Delegate to spec-writer Agent

Launch with a structured prompt. The agent handles RFC conventions, section structure, terminology, and self-auditing.

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

**New Draft:** Verify file at `specs/[slug].spec.md` follows expected structure (Purpose, Scope, Terminology, Conformance, normative body, Change Log). Report location and version.

**Revise:** Verify version bump, Change Log update, and cross-reference resolution. Report changes.

**Audit:** Present findings by severity. Use AskUserQuestion (header "Next step"): "Fix issues" (switch to Revise) / "Done".

## Committing

Delegate to the `commit` skill. Examples:
- `docs(spec-writer): draft validation config v2 specification`
- `docs(spec-writer): revise handoff protocol — add context fields`

## Rules

- Delegate writing to the `spec-writer` agent; this skill orchestrates only.
- Confirm scope before drafting; prefer promoting existing decision records over starting from scratch.
