# Validator Protocol

Defines how the orchestrator detects and runs project-specific validation checks.

## Overview

Validators are checks that run after each implementation step to ensure the step
didn't break anything. The orchestrator auto-detects available validators based
on project files, but users can override via configuration.

## Auto-Detection Rules

The orchestrator scans the project root and detects validators in priority order:

| Detector | Files Checked | Validators Added |
|----------|--------------|-----------------|
| Godot/GDScript | `project.godot` | GUT tests (`godot --headless -s addons/gut/gut_cmdln.gd`), gdscript-validate skill |
| Go | `go.mod` | `go build ./...`, `go test ./...`, `go vet ./...` |
| Rust | `Cargo.toml` | `cargo check`, `cargo test`, `cargo clippy` |
| Python | `pyproject.toml`, `setup.py`, `requirements.txt` | `pytest`, `mypy` (if installed), `ruff` (if installed) |
| Node/TypeScript | `package.json` | `npm test`, `tsc --noEmit` (if tsconfig exists), `eslint` (if config exists) |
| Makefile | `Makefile` | `make test`, `make lint` (if targets exist) |

## Validation Sequence

For each step, validators run in this order:

1. **Build/Parse** — Does the project still compile? (e.g., `go build`, `cargo check`, `tsc`)
2. **Lint** — No new warnings/errors? (e.g., `go vet`, `clippy`, `eslint`)
3. **Test** — All tests pass? (e.g., `go test`, `pytest`, `npm test`)
4. **Custom** — Any user-defined validators (see Configuration)

If ANY validator fails, the step enters the retry cycle (see orchestrator SKILL.md).

## Validator Output Format

Each validator reports:

```markdown
### <Validator Name>
**Status**: PASS | FAIL
**Duration**: Xs
**Output** (on failure):
\`\`\`
<stderr/stdout>
\`\`\`
```

This is appended to the run-log for the step.

## Configuration Override

Users can create a `.workflow-validators.json` in the project root to override
auto-detection:

```json
{
  "validators": [
    {
      "name": "build",
      "command": "make build",
      "phase": "build"
    },
    {
      "name": "unit-tests",
      "command": "make test-unit",
      "phase": "test"
    },
    {
      "name": "integration-tests",
      "command": "make test-integration",
      "phase": "test"
    },
    {
      "name": "custom-lint",
      "command": "./scripts/lint.sh",
      "phase": "lint"
    }
  ]
}
```

### Fields
- **name**: Human-readable name (appears in run-log)
- **command**: Shell command to run
- **phase**: `build`, `lint`, `test`, or `custom` (determines execution order)

## Extending Validators

To add validators for a new tech stack:

1. Add detection logic to the orchestrator's Phase 0
2. Map detected files → validator commands
3. Assign each validator a phase (build/lint/test)

Or simply create `.workflow-validators.json` — no code changes needed.
