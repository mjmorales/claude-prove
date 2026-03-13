# prove

**P**lan, **R**esearch, **O**rchestrate, **V**alidate, **E**xecute — a Claude Code plugin that provides a complete plan-to-implementation lifecycle for any tech stack.

## What It Does

Takes you from idea to merged code through a structured pipeline:

```
/prove:brainstorm  →  /prove:task-planner  →  /prove:plan-step  →  /prove:orchestrator  →  /prove:cleanup
      │                        │                         │                        │                        │
.prove/decisions/       .prove/TASK_PLAN.md     .prove/plans/plan_X/    .prove/reports/         .prove/archive/
```

1. **Brainstorm** — Explore options, weigh trade-offs, record decisions
2. **Task Planner** — Discover requirements via questionnaires, create incremental plans
3. **Plan Step** — Deep-dive into individual steps: requirements, design decisions, test strategy
4. **Orchestrator** — Autonomous execution with validation gates and git snapshots
5. **Cleanup** — Archive artifacts, remove working files, delete branches

## Key Features

- **Auto-scaling orchestrator**: Small tasks (≤3 steps) run sequentially. Larger tasks use parallel git worktrees with mandatory architect review.
- **Inter-agent handoff**: Agents pass context between steps via a task-scoped directory (`.prove/context/`). Simple log by default, structured files (API contracts, discoveries, gotchas) when needed.
- **Stack-agnostic validation**: Auto-detects your project type (Go, Rust, Python, Node, Godot, Makefile) and runs appropriate build/lint/test checks. Configure with `.prove.json` or let auto-detection handle it. Bootstrap with `/prove:init`.
- **Extensible reporting**: Progress tracked in markdown. Add custom reporters (Slack, metrics) via the `reporters` key in `.prove.json`.
- **Git-based rollback**: Every step is committed individually. Revert any step, reset to any point.

## Installation

```bash
# Clone the plugin
git clone https://github.com/your-user/claude-prove ~/dev/claude-prove

# Run claude with plugin
./run-claude.sh

# Tell Claude Code about it (add to your project or global settings)
# In .claude/settings.json or ~/.claude/settings.json:
{
  "plugins": ["~/dev/claude-prove"]
}
```

## Usage

```
# Initialize validation config for your project
/prove:init

# Start brainstorming a feature
/prove:brainstorm

# Plan the implementation
/prove:task-planner

# Deep-dive into a specific step
/prove:plan-step 1.2.3

# Execute autonomously
/prove:orchestrator

# Clean up when done
/prove:cleanup my-feature
```

## Project Structure

```
.claude-plugin/
└── plugin.json              # Plugin metadata
references/
└── validation-config.md        # Canonical validation spec (.prove.json schema, auto-detection)
skills/
├── brainstorm/              # Interactive brainstorming → .prove/decisions/
├── task-planner/            # Discovery & planning → .prove/TASK_PLAN.md
├── plan-step/               # Step-level requirements → .prove/plans/
├── orchestrator/            # Autonomous execution
│   ├── references/
│   │   ├── handoff-protocol.md    # Inter-agent context passing
│   │   └── reporter-protocol.md   # Progress & reporting format
│   └── scripts/
└── cleanup/                 # Archive & remove artifacts
scripts/
├── init-config.sh              # Tech stack detection → .prove.json
└── setup-tools.sh              # Auto-configure tools (config)
tools/
└── cafi/                       # Content-addressable file index
    ├── tool.json               # Tool manifest (config, requirements)
    ├── hasher.py               # SHA256 hashing + cache diffing
    ├── describer.py            # Claude CLI routing-hint generation
    ├── indexer.py              # Orchestrates hash→diff→describe→save
    └── __main__.py             # CLI: index, status, get, clear, context
agents/
├── principal-architect.md   # Code review for orchestrator's full mode
└── validation-agent.md      # LLM-based validation for prompt validators
```

## Working Directory

All prove artifacts are stored under `.prove/` in your project:

```
.prove/
├── decisions/          # Brainstorm decision records
├── plans/              # Step-level planning docs
│   └── plan_X.Y.Z/
├── reports/            # Orchestrator run logs and reports
│   └── <task-slug>/
├── context/            # Inter-agent handoff context
│   └── <task-slug>/
├── archive/            # Archived completed tasks
├── TASK_PLAN.md        # Active task plan
├── PROGRESS.md         # Live progress (full mode)
└── PRD.md              # Product requirements (full-auto)
```

Add `.prove/` to your `.gitignore` to keep artifacts out of version control:

```bash
echo '.prove/' >> .gitignore
```

The `.prove.json` config file stays at the repo root — it's project configuration, not a working artifact.

## LLM Validators

In addition to shell-command validators (build, lint, test), prove supports **prompt-based LLM validators** for higher-level checks that can't be captured in a script — such as documentation quality, naming conventions, or domain-specific patterns.

Configure them in `.prove.json`:

```json
{
  "validators": [
    { "name": "build", "command": "go build ./...", "phase": "build" },
    { "name": "doc-quality", "prompt": ".prove/prompts/doc-quality.md", "phase": "llm" }
  ]
}
```

- **Prompt file**: A standard markdown file describing what to check. No special DSL — just write what you'd tell a reviewer.
- **Phase**: LLM validators run in the `llm` phase, after all command-based validators (build → lint → test → custom → llm).
- **Agent**: Uses the `validation-agent` (haiku model) for fast, cost-efficient evaluation. Read-only — it can inspect code but never modifies it.
- **Verdict**: Returns PASS or FAIL with specific findings referencing files and lines.
- **Retry**: Same semantics as command validators — one auto-fix attempt on failure, then halt.

## Tools

Tools are standalone utilities that live in `tools/` and are auto-configured by `/prove:init`. Each tool has a `tool.json` manifest declaring its hooks, config, and requirements.

### CAFI — Content-Addressable File Index

Hashes all project files, generates routing-hint descriptions via Claude CLI ("Read this file when doing X"). Run `/prove:index` to build or update the index.

```bash
# Manual usage
/prove:index              # Build/update index (incremental)
/prove:index --force      # Re-describe all files
/prove:index status       # Check what's changed
```

Setup happens automatically during `/prove:init`, or manually:
```bash
bash scripts/setup-tools.sh --project-root . --plugin-dir /path/to/claude-prove
```

### Creating New Tools

1. Create a directory under `tools/<name>/`
2. Add a `tool.json` manifest:
   ```json
   {
     "name": "my-tool",
     "description": "What this tool does",
     "config_key": "my_tool",
     "config_defaults": {"option": "default_value"},
     "requires": ["python3"]
   }
   ```
3. Add the tool to `MANIFEST` as `tool | my-tool | tools/my-tool/ | Description`
4. `setup-tools.sh` will auto-detect it and configure `.prove.json` during init

**Manifest fields:**
- `config_key` — Key added to `.prove.json` for tool-specific settings.
- `config_defaults` — Default values for the config section.
- `requires` — List of CLI commands that must be available (checked before setup).

## Protocols

The orchestrator is built on three protocols that make it extensible:

- **Handoff Protocol** — How agents pass context between steps. See `skills/orchestrator/references/handoff-protocol.md`
- **Validation Config** — How project-specific checks are configured and run. See `references/validation-config.md`
- **Reporter Protocol** — How progress is tracked and reported. See `skills/orchestrator/references/reporter-protocol.md`

## License

MIT
