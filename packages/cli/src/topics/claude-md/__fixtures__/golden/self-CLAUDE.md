<!-- prove:managed:start -->
# claude-prove

<!-- prove:plugin-version:__PLUGIN_VERSION__ -->
**Prove plugin v__PLUGIN_VERSION__** — if `bun run "${CLAUDE_PROVE_PLUGIN_DIR:-$HOME/.claude/plugins/prove}/packages/cli/bin/run.ts" --version` does not match v__PLUGIN_VERSION__, run `/prove:update` to sync.

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

## Validation

Run before committing:

- **llm**: `skill claude-skills:comment-audit`

## Team Agents

Role-bound team agents registered in `.claude/agents/`:

- **discovery**: `team-discovery-tech_lead`, `team-discovery-engineer`, `team-discovery-implementer`
- **engine**: `team-engine-tech_lead`, `team-engine-engineer`, `team-engine-implementer`
- **methodology**: `team-methodology-tech_lead`, `team-methodology-engineer`, `team-methodology-implementer`

Dispatch and memory protocol:

- For subagent work that falls inside a team's scope, dispatch that team's role agent — never a general-purpose agent. Resolve scope from each team's bundle `teams/<slug>.md`; use a general-purpose agent only when no team's bundle scope covers the task.
- Every dispatched team agent must honor its memory protocol: read its team bundle `teams/<slug>.md` (scope, roster, recent Lore) before acting, and record what it learns:
  - seat notes with `bun run "${CLAUDE_PROVE_PLUGIN_DIR:-$HOME/.claude/plugins/prove}/packages/cli/bin/run.ts" scrum annotation add --target-kind team --target <team-slug> --body <text> --author <CT-UUID>`
  - team Lore with `bun run "${CLAUDE_PROVE_PLUGIN_DIR:-$HOME/.claude/plugins/prove}/packages/cli/bin/run.ts" scrum lore record <team-slug> --body <text> --author <CT-UUID>` (tech_lead seat; non-lead seats route journal-worthy findings to a seat annotation instead)
  - durable decisions with `bun run "${CLAUDE_PROVE_PLUGIN_DIR:-$HOME/.claude/plugins/prove}/packages/cli/bin/run.ts" scrum decision record <path> --kind adr`

## References

### claude-prove CLI Reference

@.claude/prove-plugin/references/claude-prove-reference.md

### Design Principles

@.claude/prove-plugin/references/design-principles.md

### Agent Routing Map

@.claude/prove-plugin/references/agent-routing.md

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
- `/prove:compact` — Anchor session context into prove primitives pre-compact and rehydrate post-compact
- `/prove:comprehend` — Socratic quiz on recent diffs to build code comprehension
- `/prove:index` — Update the file index (run after significant changes)
- `/prove:intake` — Render a charter/team/decompose HTML intake form, validate the pasted-back payload, and drive the one writer
- `/prove:orchestrator` — Unified entry point for orchestrator, autopilot, and full-auto execution
- `/prove:plan` — Plan a task or a specific step from the active plan.json
- `/prove:review-ui` — Loopback review UI for inspecting prove runs, ACB intent groups, and verdicts
- `/prove:scrum` — Operate the scrum store backed by `.prove/prove.db` (tasks, milestones, tags, run-links)
- `/prove:workflow` — Run a milestone/task tree as parallel waves via orchestrator full-mode, mirroring status to scrum

<!-- prove:managed:end -->
