# Creator Conventions

Shared workflow patterns for all creator skills (commands, agents, skills). Each creator follows this skeleton and adds domain-specific steps.

## Standard Workflow

### 1. Gather Requirements

Use `AskUserQuestion` for discrete choices, free-form for open-ended questions. See `references/interaction-patterns.md` for the full pattern reference.

**Common gather fields** (all creators):
- Purpose (free-form)
- Location (`AskUserQuestion` — Project / User Global / Plugin)
- Review gate before writing (`AskUserQuestion` — Create / Revise)

Each creator adds domain-specific fields (tool permissions, model selection, arguments, etc.).

### 2. Generate

Apply prompting best practices from `references/prompt-engineering-guide.md` when generating any LLM-consumed text. Commands, agent definitions, and skill definitions are all prompts — treat them accordingly.

### 3. Quality Self-Check

Before presenting the generated output, verify these heuristics:

- **Primacy positioning**: Are critical directives early in the prompt body?
- **Constraint pairing**: Does every "never X" have an "instead, do Y"?
- **No preamble bloat**: No "I want you to carefully..." — just state the task.
- **No redundant re-statement**: Each instruction said once, clearly.
- **Model calibration**: Is verbosity appropriate for the target model? Opus needs less scaffolding than Haiku.
- **Token budget**: Is the prompt lean enough for its consumption context?

If any check fails, fix the generated output before presenting it.

### 4. Validate

Domain-specific validation checklist. Each creator defines its own items. Common checks:

- [ ] Filename is lowercase, hyphen-delimited
- [ ] Required frontmatter fields are present
- [ ] Content follows the plugin's structural patterns

### 5. Review Gate

Use `AskUserQuestion` with header "Review" and options:
- "Create" — write the file
- "Revise" — make changes first

### 6. Commit Delegation

When the user asks to commit, delegate to the `commit` skill. Do not create ad-hoc commits.

## Plugin Scope Registration

When adding to a plugin, ensure the relevant scope exists in `.claude/.prove.json`:

```json
"scopes": { "commands": "commands/", "agents": "agents/", "skills": "skills/" }
```

## Prompt Quality Standard

The project's CLAUDE.md mandates all LLM-fed text be reviewed by the `llm-prompt-engineer` agent before shipping. Creator skills apply a lightweight self-check (step 3 above) during generation. For high-stakes prompts, recommend the user run `/prove:prompting craft` for full optimization after creation.
