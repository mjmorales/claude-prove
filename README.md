# workflow

A Claude Code plugin that provides a complete plan-to-implementation lifecycle for any tech stack.

## What It Does

Takes you from idea to merged code through a structured pipeline:

```
/workflow:brainstorm  →  /workflow:task-planner  →  /workflow:plan-step  →  /workflow:orchestrator  →  /workflow:cleanup
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
- **Stack-agnostic validation**: Auto-detects your project type (Go, Rust, Python, Node, Godot, Makefile) and runs appropriate build/lint/test checks. Override with `.workflow-validators.json`.
- **Extensible reporting**: Progress tracked in markdown. Add custom reporters (Slack, metrics) via `.workflow-reporters.json`.
- **Git-based rollback**: Every step is committed individually. Revert any step, reset to any point.

## Installation

```bash
# Clone the plugin
git clone https://github.com/your-user/manny-claude-helpers ~/dev/manny-claude-helpers

# Tell Claude Code about it (add to your project or global settings)
# In .claude/settings.json or ~/.claude/settings.json:
{
  "plugins": ["~/dev/manny-claude-helpers"]
}
```

## Usage

```
# Start brainstorming a feature
/workflow:brainstorm

# Plan the implementation
/workflow:task-planner

# Deep-dive into a specific step
/workflow:plan-step 1.2.3

# Execute autonomously
/workflow:orchestrator

# Clean up when done
/workflow:cleanup my-feature
```

## Project Structure

```
.claude-plugin/
└── plugin.json              # Plugin metadata
skills/
├── brainstorm/              # Interactive brainstorming → decisions/
├── task-planner/            # Discovery & planning → TASK_PLAN.md
├── plan-step/               # Step-level requirements → plans/
├── orchestrator/            # Autonomous execution
│   ├── references/
│   │   ├── handoff-protocol.md    # Inter-agent context passing
│   │   ├── validator-protocol.md  # Build/lint/test detection
│   │   └── reporter-protocol.md   # Progress & reporting format
│   └── scripts/
└── cleanup/                 # Archive & remove artifacts
agents/
└── principal-architect.md   # Code review for orchestrator's full mode
```

## Protocols

The orchestrator is built on three protocols that make it extensible:

- **Handoff Protocol** — How agents pass context between steps. See `skills/orchestrator/references/handoff-protocol.md`
- **Validator Protocol** — How project-specific checks are detected and run. See `skills/orchestrator/references/validator-protocol.md`
- **Reporter Protocol** — How progress is tracked and reported. See `skills/orchestrator/references/reporter-protocol.md`

## License

MIT
