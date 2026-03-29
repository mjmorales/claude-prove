---
name: spec-writer
description: Create, revise, and audit technical specifications following RFC/IETF conventions. Use when the user wants to write a new spec, edit an existing spec, review a spec for completeness, or formalize a design decision into a specification document. Triggers on "write a spec", "spec for", "formalize this", "draft a specification", "audit this spec", "revise the spec", "protocol spec", "format spec", or any request to create structured technical documentation with normative requirements. Also triggers when the user has a brainstorm decision record they want to turn into a formal spec.
---

# Spec Writer

Orchestrate the creation, revision, and audit of technical specifications. Delegates the actual writing to the `spec-writer` agent, which follows RFC/IETF conventions with RFC 2119 keyword discipline, hierarchical section numbering, and controlled terminology.

**Interaction patterns**: See `references/interaction-patterns.md` for when to use `AskUserQuestion` vs free-form discussion.

## Workflow

### Step 1: Determine Mode

Use `AskUserQuestion` with header "Mode" if not obvious from context. When presenting ≤3 choices, include a "Research & proceed" option per the Delegation pattern in `references/interaction-patterns.md`:

- **New Draft** — create a spec from scratch based on user description, decision records, or conversation context
- **Revise** — edit an existing spec (user provides the spec or you find it in `specs/`)
- **Audit** — review a spec for completeness, ambiguity, and consistency without changing it

If `$ARGUMENTS` contains a path to an existing `.spec.md` file, default to Revise. If it references a decision record in `.prove/decisions/`, default to New Draft using that decision as input.

### Step 2: Gather Context

Before delegating to the agent, collect the inputs it needs.

**For New Draft:**

1. Read any referenced decision records from `.prove/decisions/`. When a decision record is the primary input, extract the chosen option and its design details to frame the draft prompt.
2. Check `specs/` for existing specs that might be related or that the new spec should reference
3. Ask the user to confirm scope — what the spec covers and what it explicitly does not

**For Revise:**

1. Read the existing spec in full
2. Understand what the user wants changed — additions, removals, clarifications, restructuring
3. Check if the change is major (bump major version) or minor (bump minor version)

**For Audit:**

1. Read the existing spec in full
2. Optionally read related specs for cross-reference consistency

### Step 3: Delegate to spec-writer Agent

Launch the `spec-writer` agent with a structured prompt. The agent handles all RFC conventions, section structure, terminology management, and self-auditing.

**New Draft prompt template:**

```markdown
Mode: New Draft

Subject: [title of the spec]
Version: 0.1 (Draft)

Input context:
[paste relevant decision records, brainstorm notes, or user requirements]

Scope:
- In scope: [what the spec defines]
- Out of scope: [what it does not define]

Related specs: [list any existing specs in specs/ that should be cross-referenced]

Write the spec to: specs/[slug].spec.md
```

**Revise prompt template:**

```markdown
Mode: Revise

Spec path: specs/[name].spec.md
Current version: [X.Y]

Changes requested:
[describe what to add, remove, or modify]

Version bump: [major if breaking, minor if additive/clarification]

Update the spec in place.
```

**Audit prompt template:**

```markdown
Mode: Audit

Spec path: specs/[name].spec.md

Run the full Completeness Checklist. Report findings as:
- Location (section number or line)
- Issue description
- Severity (Critical / Important / Improvement)
- Suggested fix

Do NOT modify the spec. Findings only.
```

### Step 4: Review Output

After the agent completes:

**For New Draft:**

1. Verify the spec was written to `specs/[slug].spec.md`
2. Confirm the file follows the document structure (Purpose, Scope, Terminology, Conformance, normative body, Change Log)
3. Report the spec location and version to the user

**For Revise:**

1. Verify the version was bumped appropriately
2. Verify the Change Log was updated
3. Confirm cross-references still resolve
4. Report what changed to the user

**For Audit:**

1. Present findings to the user organized by severity
2. Use `AskUserQuestion` with header "Next step" to offer:
   - "Fix issues" — switch to Revise mode and address the findings
   - "Done" — audit complete, no further action

## Committing

When the user asks to commit specs, delegate to the `commit` skill. The commit skill reads `.claude/.prove.json` scopes for valid commit scopes.

Examples:

- `docs(spec-writer): draft validation config v2 specification`
- `docs(spec-writer): revise handoff protocol — add context fields`

## Rules

- ALWAYS delegate writing to the `spec-writer` agent. The skill orchestrates; the agent writes.
- ALWAYS confirm scope before drafting. A spec without clear boundaries drifts.
- PREFER promoting existing decision records over starting from scratch.
