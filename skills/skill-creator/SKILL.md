---
name: skill-creator
description: Create Claude Code skills with best practices for description tuning, resource bundling, and interaction patterns. Use when the user wants to create a new skill, asks about skill structure, or needs help with skill descriptions and trigger phrases.
---

# Skill Creator

Create Claude Code skills following best practices for structure, description tuning, and resource bundling.

**Shared conventions**: See `references/creator-conventions.md` for the standard creator workflow (gather, generate, quality self-check, validate, review gate, commit).

**Prompting best practices**: See `references/prompt-engineering-guide.md` for optimization techniques to apply when generating the skill body.

## Workflow

### 1. Gather Requirements

Use `AskUserQuestion` for discrete choices, free-form for open-ended questions.

**Skill purpose** (free-form):
- What task does this skill automate?
- When should Claude invoke it? What trigger phrases would a user naturally say?

**Skill location** — `AskUserQuestion` with header "Location":
- "Project" (`.claude/skills/<name>/` — versioned with the repo)
- "User Global" (`~/.claude/skills/<name>/` — available across all projects)
- "Plugin" (`skills/` — if adding to a prove-style plugin)

**Interaction pattern** — `AskUserQuestion` with header "Interaction":
- "Autonomous" — skill runs without user input
- "Interactive" — skill uses AskUserQuestion gates
- "Delegating" — thin wrapper that delegates to an agent

**Resources needed** — `AskUserQuestion` with header "Resources" (multiSelect):
- "Reference docs" — bundled best practices or domain knowledge
- "Templates/assets" — output templates with placeholders
- "Scripts" — executable Python or shell scripts
- "None"

### 2. Generate the Skill

**Skill name** — derive a hyphen-case name from the purpose (e.g., `code-reviewer`, `deploy-checker`, `migration-planner`).

Create the directory structure based on gathered requirements:
- Always: `skills/<name>/SKILL.md`
- If references: `skills/<name>/references/<topic>.md`
- If assets: `skills/<name>/assets/<template>.md`

**Description tuning** — the description is the highest-leverage field. Refer to `references/skills-best-practices.md` for the structure:
- Front-load the primary action
- Include 2-3 trigger scenarios
- List natural trigger phrases

**Body structure** — match the interaction pattern:
- Autonomous: numbered workflow steps
- Interactive: gather → execute → validate → review gate
- Delegating: before delegating → delegation instructions → after delegation

Apply the quality self-check from `references/creator-conventions.md` before presenting.

### 3. Validate

Before writing, verify:

- [ ] Directory name matches the `name` frontmatter field convention
- [ ] `name` and `description` frontmatter fields are present
- [ ] Description front-loads the action and includes trigger scenarios
- [ ] Body uses numbered steps for workflows
- [ ] Interactive skills follow `references/interaction-patterns.md` patterns
- [ ] Token budget is appropriate (see `references/skills-best-practices.md`)
- [ ] Referenced resources exist or will be created
- [ ] If plugin: `skills` scope exists in `.claude/.prove.json`

Use `AskUserQuestion` with header "Review" to confirm: "Create Skill" / "Revise".

### 4. Create Associated Command (Optional)

If the skill should be user-invocable via `/prove:<name>`, offer to create a thin command wrapper:

```markdown
---
description: <same as skill description, shortened>
argument-hint: "[input]"
---

# Command Name: $ARGUMENTS

Load and follow the <name> skill (`skills/<name>/SKILL.md` from the workflow plugin).
```

## Committing

Delegate to the `commit` skill. Example: `feat(skills): add migration-planner skill`

## Resources

- `references/skills-best-practices.md` — skill structure, description tuning, resource bundling, token budgets
- `references/creator-conventions.md` — shared creator workflow patterns
- `references/prompt-engineering-guide.md` — prompting techniques for the skill body
