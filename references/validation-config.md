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
    { "name": "doc-quality", "prompt": ".prove/prompts/doc-quality.md", "phase": "llm" },
    { "name": "comment-audit", "skill": "claude-skills:comment-audit", "phase": "llm" }
  ],
  "reporters": [
    { "name": "slack", "command": "./.prove/notify.sh", "events": ["step-complete", "step-halted"] }
  ]
}
```

### Complete Example (every key)

A fully-featured `.claude/.prove.json` exercising every top-level key the schema defines. All keys except `schema_version` are optional — start minimal and add blocks as you adopt features.

```json
{
  "schema_version": "10",
  "dev_mode": false,
  "artifacts": {
    "html_open": "cursor {file}"
  },
  "scopes": {
    "api": "src/api/",
    "auth": "src/auth/",
    "db": "src/models/",
    "docs": "docs/"
  },
  "validators": [
    { "name": "build", "command": "go build ./...", "phase": "build" },
    { "name": "lint", "command": "go vet ./...", "phase": "lint" },
    { "name": "tests", "command": "go test ./...", "phase": "test" },
    { "name": "migrations", "command": "./scripts/check-migrations.sh", "phase": "custom" },
    { "name": "doc-quality", "prompt": ".prove/prompts/doc-quality.md", "phase": "llm" },
    { "name": "comment-audit", "skill": "claude-skills:comment-audit", "phase": "llm" }
  ],
  "reporters": [
    { "name": "slack", "command": "./.prove/notify-slack.sh", "events": ["step-complete", "step-halted", "execution-complete"] },
    { "name": "discord", "command": "./.prove/notify-discord.sh", "events": ["review-approved", "review-rejected"] }
  ],
  "triggers": [
    { "on": "accepted", "workflow": "decompose", "description": "fire the next-layer decompose" },
    { "on": "blocked", "workflow": "re-plan", "description": "surface re-decomposition on a discovered dependency" }
  ],
  "claude_md": {
    "references": [
      { "path": "references/llm-coding-standards.md", "label": "LLM-Optimized Coding Standards" },
      { "path": "~/team/conventions.md", "label": "Team Conventions" }
    ]
  },
  "tools": {
    "cafi": {
      "enabled": true,
      "scope": "user",
      "config": { "excludes": ["vendor/", "generated/"], "max_file_size": 102400, "concurrency": 3 }
    },
    "acb": {
      "enabled": true,
      "scope": "user",
      "config": { "base_branch": "main", "review_ui_port": 5174, "review_ui_image": "ghcr.io/mjmorales/claude-prove/review-ui", "review_ui_tag": "latest" }
    },
    "pcd": { "enabled": true },
    "run_state": { "enabled": true, "scope": "user" },
    "scrum": { "enabled": true, "scope": "user", "config": {} }
  },
  "brief": {
    "single_pass_token_threshold": 8000,
    "max_synthesis_retries": 2,
    "prose_judge_on": true
  },
  "memory": {
    "stale_threshold_days": 90
  },
  "decomposition": {
    "auto_accept_through": "none"
  }
}
```

| Key | Purpose | Default |
|-----|---------|---------|
| `schema_version` | Config format version for migration tracking (`schema migrate` owns transitions) | current version |
| `dev_mode` | `true` makes codegen emit `bun run <pluginDir>/packages/cli/bin/run.ts` instead of bare `claude-prove` — plugin developers working from a checkout only | `false` |
| `artifacts.html_open` | Shell command template `--open` uses to launch a written HTML artifact (`report`, `intake render`); `{file}` is replaced with the quoted path (no placeholder → path appended). Examples: `"cursor {file}"`, `"open -a Safari {file}"`, `"xdg-open {file}"` | platform opener |
| `scopes` | Commit scope name → directory prefix; consumed by the commit skill and conventional-commit validation | — |
| `validators` | Ordered checks run after each orchestrator step (see Validator Fields) | — |
| `reporters` | Shell commands fired on lifecycle events (see Reporter Fields) | — |
| `triggers` | Status-transition → bound next-action table the scrum reconciler surfaces (see Trigger Bindings) | — |
| `claude_md.references` | Files included in generated `CLAUDE.md` via `@` references (`~` expands) | `[]` |
| `tools` | Per-tool activation, each `{ enabled, scope?, config? }`; `enabled: false` omits the tool's hooks at install time | enabled |
| `brief.single_pass_token_threshold` | Episode-token budget splitting single-pass from chunked multipass brief synthesis | `8000` |
| `brief.max_synthesis_retries` | Retry budget for the brief synthesis stage | `2` |
| `brief.prose_judge_on` | Run the advisory (non-blocking) prose-quality judge on synthesized briefs | `true` |
| `memory.stale_threshold_days` | Age past which `scrum decision review-stale` reports a decision (report-only, never prunes) | `90` |
| `decomposition.auto_accept_through` | Decompose layer (`epic`/`story`/`task`) through which children auto-promote without the human accept gate; `none` gates every layer | `"none"` |

### Schema Version

Tracks config format for migration. Missing field = v0 (pre-schema). Run `/prove:update` to migrate.

| Version | Changes |
|---------|---------|
| `"1"` | Initial versioned schema |
| ... | (see `migrate.ts` for intermediate versions) |
| `"7"` | Validators gain an optional `skill` field (skill-invoked gates) |
| `"10"` | Optional `artifacts` block (`html_open` opener command template for `--open`) |

### Validator Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Human-readable name (appears in run-log) |
| `command` | string | conditional | Shell command |
| `prompt` | string | conditional | Path to validation prompt markdown (relative to project root) |
| `skill` | string | conditional | Skill to invoke as the gate (e.g. `claude-skills:comment-audit`) |
| `phase` | string | yes | `build`, `lint`, `test`, `custom`, or `llm` -- determines execution order |

Each validator has exactly one of `command`, `prompt`, or `skill` (conditional = required when the other two are unset).

### Reporter Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Human-readable name |
| `command` | string | yes | Shell command to execute |
| `events` | string[] | yes | Events that trigger the reporter |

The `reporters` key is optional.

### Trigger Bindings (`triggers`)

The optional `triggers` key declares a **status-transition → bound next-action** table the scrum reconciler consults on session transitions. A task entering a binding's `on` status surfaces its `workflow` as a pending next-action in the session-start digest (alongside `scrum next-ready` / `scrum alerts`). There is no resident evaluator — bindings fire only when a session reconciles. Unattended firing requires an explicit opt-in driver (a `/loop` while a session is open, or a scheduled remote agent that drains `scrum next-ready` on a cron); without one, a bound next-action simply waits in the digest until an interactive session picks it up.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `on` | string | yes | Task status whose entry fires the binding (closed enum: `backlog`, `proposed`, `accepted`, `ready`, `in_progress`, `review`, `blocked`, `done`, `cancelled`) |
| `workflow` | string | yes | Bound next-action the reconciler surfaces (a workflow name or short label) |
| `description` | string | no | Human-readable note on the binding's purpose |

```json
"triggers": [
  { "on": "accepted", "workflow": "decompose", "description": "fire the next-layer decompose" }
]
```

The `triggers` key is optional; absent = no bindings.

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

## Skill Validators

The driver session (orchestrator / workflow) invokes the named skill via the Skill tool, scoped to the current step diff. The `skill` value must resolve through the Skill tool (built-in, plugin-namespaced `plugin:skill`, or user skill).

**Skill receives:** the step diff as target scope, plus read access to project context.

**Skill returns:** PASS when clean, FAIL on actionable findings (each referencing `file:line`). Same one-retry-then-halt semantics as command and prompt validators.

A skill that performs edits behind a human gate (e.g. `claude-skills:comment-audit`) runs **audit-only** here -- the driver consumes findings as the PASS/FAIL signal and does not auto-apply edits inside the gate.

**Example**: `{ "name": "comment-audit", "skill": "claude-skills:comment-audit", "phase": "llm" }` -- runs comment-audit against each step's diff, halts on unresolved comment smell.

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
