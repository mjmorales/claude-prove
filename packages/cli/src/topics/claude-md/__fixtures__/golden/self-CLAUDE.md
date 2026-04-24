<!-- prove:managed:start -->
# claude-prove

<!-- prove:plugin-version:__PLUGIN_VERSION__ -->
**Prove plugin v__PLUGIN_VERSION__** — if `claude-prove --version` does not match v__PLUGIN_VERSION__, run `/prove:update` to sync.

JavaScript/TypeScript (npm)

## Structure

- `agents/` — Agent definitions
- `commands/` — Slash commands
- `docs/` — Documentation
- `scripts/` — Build/utility scripts
- `skills/` — Plugin skills

## Conventions

- File naming: kebab-case
- Test files: *.test.ext (dot)

## References

### claude-prove CLI Reference

@__PLUGIN_DIR__/references/claude-prove-reference.md

### LLM-Optimized Coding Standards

@references/llm-coding-standards.md

### Interaction Patterns

@references/interaction-patterns.md

### Validation Configuration

@references/validation-config.md

### Creator Conventions

@references/creator-conventions.md

### Prompt Engineering Guide

@references/prompt-engineering-guide.md

## Prove Commands

- `/prove:brainstorm` — Explore options and record decisions
- `/prove:comprehend` — Socratic quiz on recent diffs to build code comprehension
- `/prove:index` — Update the file index (run after significant changes)
- `/prove:orchestrator` — Unified entry point for orchestrator, autopilot, and full-auto execution
- `/prove:plan` — Plan a task or a specific step from the active plan.json
- `/prove:review-ui` — Docker-based review UI for inspecting prove runs, ACB intent groups, and verdicts
- `/prove:scrum` — Operate the scrum store backed by `.prove/prove.db` (tasks, milestones, tags, run-links)

<!-- prove:managed:end -->
