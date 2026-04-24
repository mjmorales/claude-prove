<!-- prove:managed:start -->
# claude-prove

<!-- prove:plugin-version:2.5.0 -->
**Prove plugin v2.5.0** — if `claude-prove --version` does not match v2.5.0, run `/prove:update` to sync.

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

@/Users/manuelmorales/dev/claude-prove/references/claude-prove-reference.md

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

## Release Tracking

- **UPDATES.md mandatory for user-facing changes**: new commands, config fields, references, behavior changes get a `## vX.Y.Z` section before PR merge. Include: what changed, migration steps (manual + `/prove:update`), auto-adoption status.
- **Feature discovery in sync**: new discoverable features (references, config fields) require `commands/update.md` Step 5 update. Auto-detected features (`core: true` commands) documented in UPDATES.md entry.
- **Schema version bump on config shape changes**: field changes in `PROVE_SCHEMA`/`SETTINGS_SCHEMA` require `CURRENT_SCHEMA_VERSION` increment + migration path.
- **CHANGELOG.md is auto-generated** -- NEVER edit manually. Conventional commits are the only input.
- **Release checklist** (verify before tagging):
  - `UPDATES.md` section for new version (if user-facing)
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
7. Add `## vX.Y.Z` entry in `UPDATES.md` with migration instructions

## Tool vs Pack Boundary

- **Infrastructure tools** (CAFI, ACB, PCD): `kind: "tool"` (default); skills/agents/commands live at plugin top level. Do NOT refactor these to pack model. CLI topics (e.g., `schema`) live in `packages/cli/src/topics/`, not `tools/`.
- **Workflow packs**: `kind: "pack"` in `tool.json`; bundle skills/agents/commands/assets inside `tools/<name>/`. Registry symlinks on install.
- Decision record: `.prove/decisions/2026-03-29-optional-packs-via-tools.md`

## CLI Invocation in User-Facing Output

- **Always** invoke the CLI as `claude-prove <topic> <args>` in all user-facing markdown, generated CLAUDE.md content, docs, and codegen output. Assume `claude-prove` is on `PATH`.
- **Never** emit `bun run` prefixes or absolute paths (e.g., `bun run /path/to/packages/cli/bin/run.ts`) in user-facing output; instead, emit the bare `claude-prove` command.
- **Never** thread `pluginDir` (or equivalent path args) through codegen functions that render user-facing strings; instead, drop the parameter and render path-free commands.
