<!-- prove:managed:start -->
# claude-prove

<!-- prove:plugin-version:3.13.1 -->
**Prove plugin v3.13.1** — if `bun run "${CLAUDE_PROVE_PLUGIN_DIR:-$HOME/.claude/plugins/prove}/packages/cli/bin/run.ts" --version` does not match v3.13.1, run `/prove:update` to sync.

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

## Discovery Protocol

Before broad Glob/Grep searches, check the file index first:

- `bun run "${CLAUDE_PROVE_PLUGIN_DIR:-$HOME/.claude/plugins/prove}/packages/cli/bin/run.ts" cafi context` — full index with routing hints
- `bun run "${CLAUDE_PROVE_PLUGIN_DIR:-$HOME/.claude/plugins/prove}/packages/cli/bin/run.ts" cafi lookup <keyword>` — search by keyword

Only fall back to Glob/Grep when the index doesn't cover what you need.
## Team Agents

Role-bound team agents registered in `.claude/agents/`:

- **discovery**: `team-discovery-tech_lead`, `team-discovery-engineer`, `team-discovery-implementer`
- **engine**: `team-engine-tech_lead`, `team-engine-engineer`, `team-engine-implementer`
- **methodology**: `team-methodology-tech_lead`, `team-methodology-engineer`, `team-methodology-implementer`

Dispatch and memory protocol:

- For subagent work that falls inside a team's scope, dispatch that team's role agent — never a general-purpose agent. Resolve scope from each team's bundle `teams/<slug>.md`; use a general-purpose agent only when no team's bundle scope covers the task.
- Every dispatched team agent must honor its memory protocol: read its team bundle `teams/<slug>.md` (scope, roster, recent Lore) before acting, and record what it learns:
  - seat notes with `bun run "${CLAUDE_PROVE_PLUGIN_DIR:-$HOME/.claude/plugins/prove}/packages/cli/bin/run.ts" scrum annotation add --target-kind team`
  - team Lore with `bun run "${CLAUDE_PROVE_PLUGIN_DIR:-$HOME/.claude/plugins/prove}/packages/cli/bin/run.ts" scrum lore record` (tech_lead seat; non-lead seats route journal-worthy findings to a seat annotation instead)
  - durable decisions with `bun run "${CLAUDE_PROVE_PLUGIN_DIR:-$HOME/.claude/plugins/prove}/packages/cli/bin/run.ts" scrum decision record`

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

## Release Tracking

- **UPDATES.md mandatory for user-facing changes**: new commands, config fields, references, behavior changes get a `## Unreleased — <title>` section at the top of UPDATES.md before PR merge. NEVER hand-write a version heading — the release workflow stamps every `## Unreleased` heading with the cut version. Include: what changed, migration steps (manual + `/prove:update`), auto-adoption status.
- **Feature discovery in sync**: new discoverable features (references, config fields) require `commands/update.md` Step 5 update. Auto-detected features (`core: true` commands) documented in UPDATES.md entry.
- **Schema version bump on config shape changes**: field changes in `PROVE_SCHEMA`/`SETTINGS_SCHEMA` require `CURRENT_SCHEMA_VERSION` increment + migration path.
- **CHANGELOG.md is auto-generated** -- NEVER edit manually. Conventional commits are the only input.
- **Release checklist** (verify before tagging):
  - `UPDATES.md` has an `## Unreleased` section covering the change (if user-facing) — the release workflow stamps the version
  - `CURRENT_SCHEMA_VERSION` matches if schema changed
  - `commands/update.md` Step 5 covers new discoverable features
  - New `core: true` commands have `summary:` frontmatter

## Prompt Quality Gate

- **All LLM-fed text requires `llm-prompt-engineer` review before commit**: `agents/*.md`, `commands/*.md`, `skills/*/SKILL.md`, CLAUDE.md, any model-consumed content.
- **Workflow**: draft -> invoke `llm-prompt-engineer` -> apply or document rejections.
- **Applies to edits** -- any directive change triggers the gate.

## Schema Migration Checklist

When adding/removing/renaming `PROVE_SCHEMA` fields:

1. Add field to `PROVE_SCHEMA` in `packages/cli/src/topics/schema/schemas.ts` with `description` and `default`
2. Increment `CURRENT_SCHEMA_VERSION` in the same file (string: `'4'` -> `'5'`)
3. Add `_migrate_vN_to_vM(config)` in `packages/cli/src/topics/schema/migrate.ts` -- hardcode target version, NEVER reference `CURRENT_SCHEMA_VERSION`
4. Register in the `MIGRATIONS` map as `'N_to_M': _migrate_vN_to_vM`
5. Add tests in `packages/cli/src/topics/schema/migrate.test.ts`: version bump, defaults, data preservation, full chain from v0
6. Run `claude-prove schema migrate --file .claude/.prove.json` at the repo root; commit the updated file and delete the generated `.bak`
7. Add an `## Unreleased — <title>` entry in `UPDATES.md` with migration instructions (the release workflow stamps the version)

## Tool vs Pack Boundary

- **Infrastructure tools** (CAFI, ACB, PCD): `kind: "tool"` (default); skills/agents/commands live at plugin top level. Do NOT refactor these to pack model. CLI topics (e.g., `schema`) live in `packages/cli/src/topics/`, not `tools/`.
- **Workflow packs**: `kind: "pack"` in `tool.json`; bundle skills/agents/commands/assets inside `tools/<name>/`. Registry symlinks on install.
- Decision record: `.prove/decisions/2026-03-29-optional-packs-via-tools.md`

## CLI Invocation in User-Facing Output

- **Hand-written markdown** (agent defs, commands, skills, references, docs): always invoke as bare `claude-prove <topic> <args>`. Assume the CLI is on `PATH`. Never emit `bun run` prefixes or absolute paths; instead, emit the bare command.
- **Codegen output** (composer.ts renderers, settings hook blocks, ACB hook template, etc.): route the invocation prefix through `.claude/.prove.json::dev_mode`. Installed-binary mode (`dev_mode: false`, the default) emits bare `claude-prove`; plugin-developer mode (`dev_mode: true`) emits the shell-interpolated `bun run "${CLAUDE_PROVE_PLUGIN_DIR:-$HOME/.claude/plugins/prove}/packages/cli/bin/run.ts"` (`DEV_INVOCATION_PREFIX` in `@claude-prove/installer`). NEVER emit a machine-absolute checkout path into a generated artifact; instead emit the interpolated prefix — the per-machine value lives in the gitignored `.claude/settings.local.json` `env` block, written by `claude-prove install local-env` (driven by `/prove:local-env`).
- **Runtime agent prompts** (Claude Code hook `decision: block` payloads): read `dev_mode` at fire time (e.g., `readDevMode(workspaceRoot)` in `acb/hook.ts`) so the emitted command resolves correctly on the user's machine regardless of install shape.
- **CLAUDE.md `@`-references**: the importer loads ONLY project-relative paths (env vars never expand; `~/...` and absolute imports outside the project silently fail) but follows symlinks. Plugin built-ins therefore render the constant `@.claude/prove-plugin/references/<file>.md`, resolved through the gitignored chain `.claude/prove-plugin → ~/.claude-prove/latest → plugin dir` (`ensureProjectLink`/`ensureStableRoot` in `@claude-prove/installer`, refreshed by `install init`/`local-env` and `claude-md generate`). NEVER emit a `~/...` or absolute plugin path into an `@`-reference; instead emit the project-link form.

## Self-Contained Artifact Rule

All user-facing code and markdown -- every `skills/*/SKILL.md`, `agents/*.md`, `commands/*.md`, `references/*.md`, and all code comments -- must be self-contained and durable. State each rule, rationale, or concept directly and timelessly, so the artifact stands alone with no external or time-bound dependency.

Ban these four reference classes in those artifacts:

- **Temporal anchors** -- dates, "now", "previously", "as of this change", "this session". Instead, state the rule or concept as a standing fact with no time reference.
- **Decision-record links or mentions** -- wiki-links to a decision, "per decision X", decision filename citations. Instead, restate the decision's content and rationale inline.
- **Spec/section links** -- "§8.3", "audit §5.1", "09 §10.5-10.6". Instead, reproduce the referenced rule or concept directly in the text.
- **"onleash" mentions** -- the heritage framework name. Instead, describe the relevant concept on its own terms without naming its origin.

**Exempt:** internal artifacts under `.prove/` (decision records) may use all four reference classes -- the ban applies only to user-facing code and markdown.
