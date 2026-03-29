# Validation Configuration

Canonical specification for project validation. All skills that produce, plan, or execute code reference this document.

## Configuration: `.claude/.prove.json`

Source of truth for validators and reporters. If present, auto-detection is skipped.

### Schema

```json
{
  "schema_version": "1",
  "validators": [
    { "name": "build", "command": "go build ./...", "phase": "build" },
    { "name": "lint",  "command": "go vet ./...",   "phase": "lint" },
    { "name": "tests", "command": "go test ./...",  "phase": "test" },
    { "name": "doc-quality", "prompt": ".prove/prompts/doc-quality.md", "phase": "llm" }
  ],
  "reporters": [
    { "name": "slack", "command": "./.prove/notify.sh", "events": ["step-complete", "step-halted"] }
  ]
}
```

### Schema Version

Tracks config format for migration. Missing field = v0 (pre-schema). Run `/prove:update` to migrate.

| Version | Changes |
|---------|---------|
| `"1"` | Initial versioned schema |

### Validator Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Human-readable name (appears in run-log) |
| `command` | string | conditional | Shell command. Required if `prompt` is not set |
| `prompt` | string | conditional | Path to validation prompt markdown (relative to project root). Required if `command` is not set |
| `phase` | string | yes | `build`, `lint`, `test`, `custom`, or `llm` -- determines execution order |

Each validator has exactly one of `command` or `prompt`.

### Reporter Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Human-readable name |
| `command` | string | yes | Shell command to execute |
| `events` | string[] | yes | Events that trigger the reporter |

The `reporters` key is optional.

## Execution Sequence

Validators run in phase order after each implementation step:

1. **build** -- compiles?
2. **lint** -- no new warnings?
3. **test** -- all tests pass?
4. **custom** -- user-defined checks
5. **llm** -- LLM validation against prompts

Within a phase, validators run in array order. Any failure triggers one auto-fix attempt, then halt.

## Prompt Validators

Prompt validators delegate to the `validation-agent` (haiku model).

**Agent receives:** prompt file content, step diff, read-file access for project context.

**Agent returns:** structured PASS/FAIL verdict with findings referencing files and line numbers.

Same retry semantics as command validators. Prompt files are standard markdown -- no special DSL.

**Example** (`.prove/prompts/doc-quality.md`):

```markdown
# Documentation Quality Check

Verify that all new or modified public functions have doc comments that:
1. Explain the purpose (the "why", not just the "what")
2. Document all parameters
3. Document return values
4. Include at least one usage example for non-trivial functions
```

## Auto-Detection Fallback

When no `.claude/.prove.json` exists, the orchestrator scans the project root:

| Detector | Files Checked | Validators Added |
|----------|--------------|-----------------|
| Godot/GDScript | `project.godot` | GUT tests (`godot --headless -s addons/gut/gut_cmdln.gd`), gdscript-validate |
| Go | `go.mod` | `go build ./...` (build), `go vet ./...` (lint), `go test ./...` (test) |
| Rust | `Cargo.toml` | `cargo check` (build), `cargo clippy` (lint), `cargo test` (test) |
| Python | `pyproject.toml`, `setup.py`, `requirements.txt` | `pytest` (test), `mypy` (lint, if installed), `ruff` (lint, if installed) |
| Node/TypeScript | `package.json` | `npm test` (test), `tsc --noEmit` (build, if tsconfig exists), `eslint` (lint, if config exists) |
| Makefile | `Makefile` | `make test` (test), `make lint` (lint) — if targets exist |

LLM validators (`phase: "llm"`) are never auto-detected -- must be configured in `.claude/.prove.json`.

## Validator Output Format

Appended to the run-log per validator:

```markdown
### <Validator Name>
**Status**: PASS | FAIL
**Duration**: Xs
**Output** (on failure):
\`\`\`
<stderr/stdout>
\`\`\`
```

## Reporter Event Types

| Event | Fires When |
|-------|-----------|
| `step-complete` | Step passes all validators and is committed |
| `step-halted` | Step fails validation after retry, execution stops |
| `wave-complete` | All tasks in a parallel wave merged (full mode) |
| `execution-complete` | Orchestrator run finishes (success or halted) |
| `review-approved` | Principal architect approves a task |
| `review-rejected` | Principal architect requests changes |
| `validation-pass` | LLM validation agent returns PASS |
| `validation-fail` | LLM validation agent returns FAIL |

## Reporter Environment Variables

- `PROVE_EVENT`: event name
- `PROVE_TASK`: task slug
- `PROVE_STEP`: step number (if applicable)
- `PROVE_STATUS`: current status
- `PROVE_BRANCH`: branch name
- `PROVE_DETAIL`: one-line summary from agent output (e.g., "3 findings in 2 files"). Empty for lifecycle events without agent context.

## Bootstrapping

Run `/prove:init` to auto-detect and generate `.claude/.prove.json`.
