<!-- prove:managed:start -->
# claude-prove


## Structure

- `agents/` — Agent definitions
- `commands/` — Slash commands
- `scripts/` — Build/utility scripts
- `skills/` — Plugin skills
- `tools/` — Development tools

## Conventions

- File naming: snake_case
- Test files: test_*.ext (prefix)

## Validation

Run before committing:

- **lint**: `docker run --rm -v "$PWD":/project prove-validators ruff check .`
- **lint**: `docker run --rm -v "$PWD":/project prove-validators mypy --ignore-missing-imports tools/`
- **test**: `docker run --rm -v "$PWD":/project prove-validators python -m pytest tools/cafi/ -v`

## Discovery Protocol

Before using Glob or Grep for broad codebase exploration:

1. Check the file index first — it has routing hints for every file
2. Run `python3 tools/cafi/__main__.py context` for the full index
3. Run `python3 tools/cafi/__main__.py lookup <keyword>` to search by keyword
4. Only fall back to Glob/Grep when the index doesn't cover what you need

The index describes *when* to read each file, not just what it contains.

## Prove Commands

- `/prove:index` — Update the file index (run after significant changes)
- `/prove:docs:claude-md` — Regenerate this file
- `/prove:task-planner` — Plan implementation for a task
- `/prove:orchestrator` — Autonomous execution with validation gates
- `/prove:brainstorm` — Explore options and record decisions
- `/prove:comprehend` — Socratic quiz on recent diffs to build code comprehension

## Scripts

- **Worktree cleanup**: `bash scripts/cleanup-worktrees.sh` — removes all stale worktrees under `.claude/worktrees/`. Use `--dry-run` to preview.
- **Task cleanup**: `PROJECT_ROOT="." bash scripts/cleanup.sh --auto <task-slug>` — archives `.prove/` artifacts for a completed task.

## Completing a Task Branch

After merging an orchestrator branch to main, sync with origin before pushing:

1. `git checkout main`
2. `git merge --no-ff orchestrator/<slug> -m "merge: <slug>"`
3. If origin/main has diverged, `git merge origin/main` (avoid rebase — too many conflicts across long branch histories)
4. `git push origin main`
5. `bash scripts/cleanup-worktrees.sh` to remove any leftover worktrees

<!-- prove:managed:end -->

## Release Tracking

- **UPDATES.md is mandatory for user-facing features**: any new command, config field, reference, or behavior change that requires user action gets a `## vX.Y.Z` section in `UPDATES.md` before the PR merges. Include: what changed, migration steps (manual + `/prove:update` path), and whether new projects get it automatically.
- **Feature discovery stays in sync**: when adding a discoverable feature (new bundled reference in `references/`, new config field in `tools/schema/schemas.py`), update `commands/update.md` Step 5 to detect and offer it. If the feature is auto-detected (like `core: true` commands), document that explicitly in the UPDATES.md entry.
- **Schema version bump on config shape changes**: adding/removing/renaming fields in `PROVE_SCHEMA` or `SETTINGS_SCHEMA` requires incrementing `CURRENT_SCHEMA_VERSION` in `tools/schema/schemas.py` and adding a migration path.
- **CHANGELOG.md is auto-generated** — NEVER edit it manually. Conventional commit messages are the only input.
- **Release artifact checklist** (verify before tagging):
  - `UPDATES.md` has a section for the new version (if user-facing changes exist)
  - `CURRENT_SCHEMA_VERSION` matches if schema changed
  - `commands/update.md` Step 5 covers any new discoverable features
  - New `core: true` commands have `summary:` frontmatter

## Prompt Quality Gate

- **NEVER ship new or modified LLM-fed text without review by `llm-prompt-engineer`**: this includes `agents/*.md`, `commands/*.md`, `skills/*/SKILL.md`, CLAUDE.md directives, and any other content consumed by a model
- **Workflow**: finish drafting the text, then invoke the `llm-prompt-engineer` agent on the file before committing. Apply its recommendations or explicitly document why you rejected them.
- **Applies to edits too** — changing even a single directive in an existing prompt triggers the gate

## Schema Migration Checklist

When adding/removing/renaming fields in `PROVE_SCHEMA`:

1. Add the field to `PROVE_SCHEMA` in `tools/schema/schemas.py` with `description` and `default`
2. Increment `CURRENT_SCHEMA_VERSION` (integer string: `"2"` -> `"3"`, etc.)
3. Add `_migrate_vN_to_vM(config)` in `tools/schema/migrate.py` — hardcode the target version string, NEVER reference `CURRENT_SCHEMA_VERSION`
4. Register it in `MIGRATIONS` dict as `"N_to_M": _migrate_vN_to_vM`
5. Add tests in `tools/schema/test_migrate.py`: version bump, default values, preserves existing data, full chain from v0
6. Update `.claude/.prove.json` at repo root to the new version
7. Add `## vX.Y.Z` entry in `UPDATES.md` with migration instructions
