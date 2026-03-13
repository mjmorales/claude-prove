# prove

**P**lan, **R**esearch, **O**rchestrate, **V**alidate, **E**xecute — a Claude Code plugin that provides a complete plan-to-implementation lifecycle for any tech stack.

## What It Does

Takes you from idea to merged code through a structured pipeline:

```
/prove:brainstorm  →  /prove:task-planner  →  /prove:plan-step  →  /prove:orchestrator  →  /prove:cleanup
      │                        │                         │                        │                        │
  decisions/              TASK_PLAN.md             plans/plan_X/          workflow-reports/          docs/archive/
```

1. **Brainstorm** — Explore options, weigh trade-offs, record decisions
2. **Task Planner** — Discover requirements via questionnaires, create incremental plans
3. **Plan Step** — Deep-dive into individual steps: requirements, design decisions, test strategy
4. **Orchestrator** — Autonomous execution with validation gates and git snapshots
5. **Cleanup** — Archive artifacts, remove working files, delete branches

## Key Features

- **Auto-scaling orchestrator**: Small tasks (≤3 steps) run sequentially. Larger tasks use parallel git worktrees with mandatory architect review.
- **Inter-agent handoff**: Agents pass context between steps via a task-scoped directory (`.task-context/`). Simple log by default, structured files (API contracts, discoveries, gotchas) when needed.
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
├── brainstorm/              # Interactive brainstorming → decisions/
├── task-planner/            # Discovery & planning → TASK_PLAN.md
├── plan-step/               # Step-level requirements → plans/
├── orchestrator/            # Autonomous execution
│   ├── references/
│   │   ├── handoff-protocol.md    # Inter-agent context passing
│   │   └── reporter-protocol.md   # Progress & reporting format
│   └── scripts/
└── cleanup/                 # Archive & remove artifacts
scripts/
└── init-config.sh              # Tech stack detection → .prove.json
agents/
└── principal-architect.md   # Code review for orchestrator's full mode
```

## Protocols

The orchestrator is built on three protocols that make it extensible:

- **Handoff Protocol** — How agents pass context between steps. See `skills/orchestrator/references/handoff-protocol.md`
- **Validation Config** — How project-specific checks are configured and run. See `references/validation-config.md`
- **Reporter Protocol** — How progress is tracked and reported. See `skills/orchestrator/references/reporter-protocol.md`

## License

MIT
