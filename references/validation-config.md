# Validation Configuration

Canonical specification for project validation in prove. All skills that produce, plan, or execute code reference this document.

## Configuration File: `.prove.json`

A single JSON file in the project root that defines validators and reporters. If present, it is the **source of truth** — auto-detection is skipped entirely.

### Schema

```json
{
  "validators": [
    { "name": "build", "command": "go build ./...", "phase": "build" },
    { "name": "lint",  "command": "go vet ./...",   "phase": "lint" },
    { "name": "tests", "command": "go test ./...",  "phase": "test" }
  ],
  "reporters": [
    { "name": "slack", "command": "./scripts/notify.sh", "events": ["step-complete", "step-halted"] }
  ]
}
```

### Validator Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Human-readable name (appears in run-log) |
| `command` | string | yes | Shell command to execute |
| `phase` | string | yes | `build`, `lint`, `test`, or `custom` — determines execution order |

### Reporter Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Human-readable name |
| `command` | string | yes | Shell command to execute |
| `events` | string[] | yes | Events that trigger the reporter: `step-complete`, `step-halted`, `execution-complete`, `wave-complete` |

The `reporters` key is optional. If omitted, no custom reporters run.

## Execution Sequence

Validators run in phase order after each implementation step:

1. **build** — Does the project still compile?
2. **lint** — No new warnings/errors introduced?
3. **test** — All existing + new tests pass?
4. **custom** — Any user-defined checks

Within the same phase, validators run in array order.

If ANY validator fails, the step enters the retry cycle (one auto-fix attempt, then halt).

## Resolution Order

1. **`.prove.json`** — If present in project root, use it exclusively
2. **Auto-detection** — If no config file, detect from project files (see table below)

## Auto-Detection Fallback

When no `.prove.json` exists, the orchestrator scans the project root:

| Detector | Files Checked | Validators Added |
|----------|--------------|-----------------|
| Godot/GDScript | `project.godot` | GUT tests (`godot --headless -s addons/gut/gut_cmdln.gd`), gdscript-validate |
| Go | `go.mod` | `go build ./...` (build), `go vet ./...` (lint), `go test ./...` (test) |
| Rust | `Cargo.toml` | `cargo check` (build), `cargo clippy` (lint), `cargo test` (test) |
| Python | `pyproject.toml`, `setup.py`, `requirements.txt` | `pytest` (test), `mypy` (lint, if installed), `ruff` (lint, if installed) |
| Node/TypeScript | `package.json` | `npm test` (test), `tsc --noEmit` (build, if tsconfig exists), `eslint` (lint, if config exists) |
| Makefile | `Makefile` | `make test` (test), `make lint` (lint) — if targets exist |

## Validator Output Format

Each validator reports results in this format, appended to the run-log:

```markdown
### <Validator Name>
**Status**: PASS | FAIL
**Duration**: Xs
**Output** (on failure):
\`\`\`
<stderr/stdout>
\`\`\`
```

## Reporter Environment Variables

Reporter commands receive event data via environment variables:
- `PROVE_EVENT`: event name
- `PROVE_TASK`: task slug
- `PROVE_STEP`: step number (if applicable)
- `PROVE_STATUS`: current status
- `PROVE_BRANCH`: branch name

## Bootstrapping

Run `/prove:init` to auto-detect your project's tech stack and generate a `.prove.json`. See `commands/init.md`.
