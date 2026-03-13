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
    { "name": "tests", "command": "go test ./...",  "phase": "test" },
    { "name": "doc-quality", "prompt": ".prove/prompts/doc-quality.md", "phase": "llm" }
  ],
  "reporters": [
    { "name": "slack", "command": "./.prove/notify.sh", "events": ["step-complete", "step-halted"] }
  ]
}
```

### Validator Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Human-readable name (appears in run-log) |
| `command` | string | conditional | Shell command to execute. Required if `prompt` is not set |
| `prompt` | string | conditional | Path to markdown file containing the validation prompt (relative to project root). Required if `command` is not set |
| `phase` | string | yes | `build`, `lint`, `test`, `custom`, or `llm` — determines execution order |

Each validator must have exactly one of `command` or `prompt`. Command validators run shell commands; prompt validators run LLM-based evaluation using the `validation-agent`.

### Reporter Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Human-readable name |
| `command` | string | yes | Shell command to execute |
| `events` | string[] | yes | Events that trigger the reporter (see Event Types below) |

The `reporters` key is optional. If omitted, no custom reporters run.

## Execution Sequence

Validators run in phase order after each implementation step:

1. **build** — Does the project still compile?
2. **lint** — No new warnings/errors introduced?
3. **test** — All existing + new tests pass?
4. **custom** — Any user-defined checks
5. **llm** — LLM-based validation against user-supplied prompts

Within the same phase, validators run in array order.

If ANY validator fails, the step enters the retry cycle (one auto-fix attempt, then halt).

## Prompt Validators

Prompt validators delegate evaluation to the `validation-agent`, which runs on the haiku model.

**What the agent receives:**
- The full content of the referenced prompt file
- The diff of all file changes made in the current step
- Read-file access to retrieve additional context from the project

**What the agent returns:**
- A structured PASS or FAIL verdict
- Findings that reference specific files and line numbers

**Behaviour:**
- Same retry semantics as command validators: one auto-fix attempt on failure, then halt
- Prompt files are standard markdown — no special DSL or syntax is required

**Example prompt file** (`.prove/prompts/doc-quality.md`):

```markdown
# Documentation Quality Check

Verify that all new or modified public functions have doc comments that:
1. Explain the purpose (the "why", not just the "what")
2. Document all parameters
3. Document return values
4. Include at least one usage example for non-trivial functions
```

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

LLM validators (`phase: "llm"`) are never auto-detected. They must be explicitly configured in `.prove.json`.

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

## Reporter Event Types

### Lifecycle Events (orchestrator)
| Event | Fires When |
|-------|-----------|
| `step-complete` | A step passes all validators and is committed |
| `step-halted` | A step fails validation after retry and execution stops |
| `wave-complete` | All tasks in a parallel wave are merged (full mode) |
| `execution-complete` | Orchestrator run finishes (success or halted) |

### Agent Events (orchestrator dispatches on behalf of agents)
| Event | Fires When |
|-------|-----------|
| `review-approved` | Principal architect approves a task |
| `review-rejected` | Principal architect requests changes |
| `validation-pass` | LLM validation agent returns PASS |
| `validation-fail` | LLM validation agent returns FAIL |

## Reporter Environment Variables

Reporter commands receive event data via environment variables:
- `PROVE_EVENT`: event name (one of the event types above)
- `PROVE_TASK`: task slug
- `PROVE_STEP`: step number (if applicable)
- `PROVE_STATUS`: current status
- `PROVE_BRANCH`: branch name
- `PROVE_DETAIL`: one-line summary extracted from agent output (e.g., "3 findings in 2 files", "APPROVED after 2 rounds"). Empty for lifecycle events without agent context

## Bootstrapping

Run `/prove:init` to auto-detect your project's tech stack and generate a `.prove.json`. See `commands/init.md`.
