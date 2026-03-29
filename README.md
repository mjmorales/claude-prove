# prove

**P**lan, **R**esearch, **O**rchestrate, **V**alidate, **E**xecute — a Claude Code plugin that provides a complete plan-to-implementation lifecycle for any tech stack.

## What It Does

Takes you from idea to merged code through a structured pipeline:

```
/prove:brainstorm  →  /prove:task-planner  →  /prove:plan-step  →  /prove:orchestrator  →  /prove:review  →  /prove:comprehend  →  /prove:cleanup
      │                        │                         │                        │                        │                        │                        │
.prove/decisions/       .prove/TASK_PLAN.md     .prove/plans/plan_X/    .prove/reports/         .prove/reviews/         .prove/learning/         .prove/archive/
```

1. **Brainstorm** — Explore options, weigh trade-offs, record decisions
2. **Task Planner** — Discover requirements via questionnaires, create incremental plans
3. **Plan Step** — Deep-dive into individual steps: requirements, design decisions, test strategy
4. **Orchestrator** — Autonomous execution with validation gates and git snapshots
5. **Review** — Generate an Agent Change Brief for structured code review
6. **Comprehend** — Socratic quiz on agent-generated diffs to build code comprehension
7. **Cleanup** — Archive artifacts, remove working files, delete branches

## Key Features

- **Auto-scaling orchestrator**: Small tasks (≤3 steps) run sequentially. Larger tasks use parallel git worktrees with mandatory architect review. Three execution modes: `/prove:orchestrator`, `/prove:autopilot`, and `/prove:full-auto`.
- **Structured code review**: Intent-manifest-driven code review. Agents declare *why* they made each change via Claude Code hooks. Changes are grouped by intent for structured review in a browser-based UI. Run `/prove:review` to start.
- **Code quality steward**: Deep line-by-line audits (`/prove:steward`), iterative audit-fix loops (`/prove:steward:auto-steward`), and lightweight session-scoped reviews (`/prove:steward:steward-review`). See [docs/code-quality.md](docs/code-quality.md).
- **Stack-agnostic validation**: Auto-detects your project type (Go, Rust, Python, Node, Godot, Makefile) and runs appropriate build/lint/test checks. Supports LLM-based prompt validators for higher-level checks. Configure with `.claude/.prove.json` or let auto-detection handle it.
- **Session management**: Create handoff prompts (`/prove:handoff`) to preserve context across Claude Code sessions. Resume with `/prove:pickup` in a fresh session.
- **Documentation generation**: Human-readable docs (`/prove:docs`), LLM-optimized agent docs (`/prove:docs:agentic-docs`), or both at once (`/prove:docs:auto-docs`).
- **Git-based rollback**: Every step is committed individually. Revert any step, reset to any point.

## Installation

```bash
claude plugin marketplace add mjmorales/claude-prove
claude plugin install prove@prove
```

If Claude Code is already running, restart it for the plugin to take effect.

## Quick Start

```bash
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

# Review agent-generated code
/prove:review

# Quiz yourself on what the agent wrote
/prove:comprehend

# Clean up when done
/prove:cleanup my-feature
```

## Commands Reference

### Planning & Discovery

| Command | Description |
|---------|-------------|
| `/prove:brainstorm` | Interactive brainstorming — explore options, record decisions to `.prove/decisions/` |
| `/prove:task-planner` | Guided requirements gathering and incremental plan creation |
| `/prove:plan-step [step]` | Deep-dive into a specific plan step: requirements, design, test strategy |
| `/prove:spec [topic]` | Author formal specifications following RFC/IETF conventions |

### Execution

| Command | Description |
|---------|-------------|
| `/prove:orchestrator` | Execute a task plan with validation gates. Auto-scales between simple and full mode |
| `/prove:autopilot [plan]` | Run the orchestrator hands-off on a specific plan |
| `/prove:full-auto` | End-to-end: requirements → plan → parallel execution → merge |
| `/prove:prep-permissions` | Pre-configure Claude Code permissions for smooth orchestrator runs |

### Code Review

| Command | Description |
|---------|-------------|
| `/prove:review` | Assemble intent manifests and launch the review UI |
| `/prove:review:resolve` | Show approval summary — accepted groups and merge readiness |
| `/prove:review:fix` | Generate fix prompts from rejected review groups |
| `/prove:review:discuss` | Surface groups needing discussion from review |

### Code Quality

| Command | Description |
|---------|-------------|
| `/prove:steward` | Deep line-by-line codebase audit with automated fixes |
| `/prove:steward:auto-steward` | Iterative audit-fix loop — runs until clean or cap is hit |
| `/prove:steward:steward-review` | Lightweight review of current branch changes only |

### Documentation

| Command | Description |
|---------|-------------|
| `/prove:docs` | Generate human-readable documentation |
| `/prove:docs:agentic-docs` | Generate LLM-optimized documentation for agents |
| `/prove:docs:auto-docs` | Analyze scope and generate both doc types in one pass |
| `/prove:docs:claude-md` | Generate or update the project's CLAUDE.md |

### Session & Lifecycle

| Command | Description |
|---------|-------------|
| `/prove:handoff` | Create a handoff prompt for clean context transfer between sessions |
| `/prove:pickup` | Resume work from a handoff prompt in a fresh session |
| `/prove:comprehend` | Socratic quiz on agent-generated diffs to build code comprehension |
| `/prove:commit` | Semantic commit assistant — reads `.claude/.prove.json` scopes for valid scopes |
| `/prove:cleanup [task]` | Archive artifacts, remove working files, delete branches |
| `/prove:complete-task` | Merge a task branch to main and run cleanup |

### Utilities

| Command | Description |
|---------|-------------|
| `/prove:init` | Detect tech stack and generate `.claude/.prove.json` |
| `/prove:doctor` | Diagnose installation health — configs, tooling, drift |
| `/prove:update` | Validate configs, detect schema drift, apply migrations |
| `/prove:index` | Build or update the content-addressable file index |
| `/prove:progress` | Show orchestrator execution status and blockers |
| `/prove:notify:notify-setup` | Configure notification integrations (Slack, Discord, custom) |
| `/prove:notify:notify-test` | Send a test notification through configured reporters |

## Deep Dives

Detailed documentation for major feature areas:

- **[Code Review](docs/code-review.md)** — Intent-manifest-driven code review with browser-based UI
- **[Orchestrator](docs/orchestrator.md)** — Execution modes, validation gates, worktrees, and reporting
- **[Code Quality](docs/code-quality.md)** — Steward, auto-steward, and steward-review audit system
- **[Session Management](docs/session-management.md)** — Handoff/pickup workflow for context preservation

## Project Structure

```
.claude-plugin/
└── plugin.json                 # Plugin metadata (v0.14.1)
specs/
└── ...                         # Protocol specifications
references/
├── validation-config.md        # Canonical validation spec (.claude/.prove.json schema)
└── interaction-patterns.md     # UX interaction patterns
skills/
├── brainstorm/                 # Interactive brainstorming → .prove/decisions/
├── task-planner/               # Discovery & planning → .prove/TASK_PLAN.md
├── plan-step/                  # Step-level requirements → .prove/plans/
├── orchestrator/               # Autonomous execution with validation gates
├── review/                     # Intent-based code review
├── steward/                    # Deep codebase quality audit
├── auto-steward/               # Iterative audit-fix loop
├── steward-review/             # Session-scoped quality review
├── comprehend/                 # Socratic quiz for code comprehension
├── handoff/                    # Session handoff prompt generation
├── commit/                     # Semantic commit assistant
├── cleanup/                    # Archive & remove artifacts
├── docs-writer/                # Human-readable documentation
├── agentic-doc-writer/         # LLM-optimized documentation
├── auto-docs/                  # Orchestrates both doc types
├── claude-md/                  # CLAUDE.md generation
├── spec-writer/                # RFC/IETF-style spec authoring
├── notify-setup/               # Notification integrations
├── prep-permissions/           # Permission pre-configuration
├── slash-command-creator/      # Slash command scaffolding
└── subagent-creator/           # Subagent scaffolding
scripts/
├── init-config.sh              # Tech stack detection → .claude/.prove.json
├── setup-tools.sh              # Auto-configure tools
├── cleanup.sh                  # Task artifact cleanup
├── cleanup-worktrees.sh        # Stale worktree removal
└── hooks/                      # Git hook templates
tools/
├── acb/                        # Intent-based code review (assembler, server, hook)
└── cafi/                       # Content-addressable file index
agents/
├── principal-architect.md      # Architect review for orchestrator full mode
├── code_steward.md             # Deep code quality auditor
├── validation-agent.md         # LLM-based validation (haiku)
├── spec-writer.md              # Specification author
└── technical-writer.md         # Documentation writer
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
├── learning/           # Comprehension session logs
├── archive/            # Archived completed tasks
├── TASK_PLAN.md        # Active task plan
├── PROGRESS.md         # Live progress (full mode)
└── PRD.md              # Product requirements (full-auto)
```

Add `.prove/` to your `.gitignore` to keep artifacts out of version control:

```bash
echo '.prove/' >> .gitignore
```

The `.claude/.prove.json` config file lives under `.claude/` alongside other Claude Code configuration.

## LLM Validators

In addition to shell-command validators (build, lint, test), prove supports **prompt-based LLM validators** for higher-level checks that can't be captured in a script — such as documentation quality, naming conventions, or domain-specific patterns.

Configure them in `.claude/.prove.json`:

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

## Protocols

The system is built on extensible protocols:

- **Handoff Protocol** — How agents pass context between steps. See `skills/orchestrator/references/handoff-protocol.md`
- **Validation Config** — How project-specific checks are configured and run. See `references/validation-config.md`
- **Reporter Protocol** — How progress is tracked and reported. See `skills/orchestrator/references/reporter-protocol.md`

## License

MIT
