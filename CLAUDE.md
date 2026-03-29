<!-- prove:managed:start -->
# claude-prove

<!-- prove:plugin-version:0.22.0 -->
**Prove plugin v0.22.0** — if the installed plugin version (`cat /Users/manuelmorales/dev/claude-prove/.claude-plugin/plugin.json | grep version`) does not match v0.22.0, run `/prove:update` to sync.

JavaScript/TypeScript (npm)

## Structure

- `agents/` — Agent definitions
- `commands/` — Slash commands
- `docs/` — Documentation
- `scripts/` — Build/utility scripts
- `skills/` — Plugin skills
- `tools/` — Development tools

## Conventions

- File naming: snake_case
- Test files: test_*.ext (prefix)

## Discovery Protocol

Before broad Glob/Grep searches, check the file index first:

- `python3 /Users/manuelmorales/dev/claude-prove/tools/cafi/__main__.py context` — full index with routing hints
- `python3 /Users/manuelmorales/dev/claude-prove/tools/cafi/__main__.py lookup <keyword>` — search by keyword

Only fall back to Glob/Grep when the index doesn't cover what you need.
## References

@references/llm-coding-standards.md
@references/interaction-patterns.md
@references/validation-config.md

## Prove Commands

- `/prove:autopilot` — Autonomous execution with validation gates
- `/prove:brainstorm` — Explore options and record decisions
- `/prove:comprehend` — Socratic quiz on recent diffs to build code comprehension
- `/prove:index` — Update the file index (run after significant changes)
- `/prove:plan-task` — Plan implementation for a task
- `/prove:tools` — Manage prove tools — list, install, remove, status

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

1. Add field to `PROVE_SCHEMA` in `tools/schema/schemas.py` with `description` and `default`
2. Increment `CURRENT_SCHEMA_VERSION` (integer string: `"2"` -> `"3"`)
3. Add `_migrate_vN_to_vM(config)` in `tools/schema/migrate.py` -- hardcode target version, NEVER reference `CURRENT_SCHEMA_VERSION`
4. Register in `MIGRATIONS` dict as `"N_to_M": _migrate_vN_to_vM`
5. Add tests in `tools/schema/test_migrate.py`: version bump, defaults, data preservation, full chain from v0
6. Update `.claude/.prove.json` at repo root
7. Add `## vX.Y.Z` entry in `UPDATES.md` with migration instructions

## Tool vs Pack Boundary

- **Infrastructure tools** (CAFI, ACB, PCD, schema): `kind: "tool"` (default); skills/agents/commands live at plugin top level. Do NOT refactor these to pack model.
- **Workflow packs** (project-manager, etc.): `kind: "pack"` in `tool.json`; bundle skills/agents/commands/assets inside `tools/<name>/`. Registry symlinks on install.
- Decision record: `.prove/decisions/2026-03-29-optional-packs-via-tools.md`
