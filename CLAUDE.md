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
- `/prove:claude-md` — Regenerate this file
- `/prove:task-planner` — Plan implementation for a task
- `/prove:orchestrator` — Autonomous execution with validation gates
- `/prove:brainstorm` — Explore options and record decisions
- `/prove:comprehend` — Socratic quiz on recent diffs to build code comprehension

<!-- prove:managed:end -->
