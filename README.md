# prove

A Claude Code plugin that adds a complete plan-to-implementation lifecycle: layered decomposition (charter → epic → story → task) with acceptance-gated closes, autonomous task execution with validation gates, structured code review, and agentic task management. Designed for engineering teams that want Claude to do real work — not just answer questions.

## Installation

```bash
claude plugin marketplace add mjmorales/claude-prove
claude plugin install prove@prove
```

Restart Claude Code after installation for the plugin to take effect.

## Quick Start

```bash
# Detect tech stack and generate .claude/.prove.json
/prove:init

# Explore approaches and record the decision
/prove:brainstorm

# Create a PRD + task plan
/prove:plan --task "add rate limiting to the API gateway"

# Execute the plan autonomously with validation gates
/prove:orchestrator

# Or run a whole milestone's task tree as parallel waves
/prove:workflow <milestone-id>

# Inspect agent-generated diffs and record verdicts
/prove:review-ui
```

## Core Subsystems

| Subsystem | Entry Point | What It Does |
|-----------|-------------|--------------|
| **Orchestrator** | `/prove:orchestrator` | Executes a task plan step-by-step. Runs build/lint/test validators after each step. Auto-scales: 1-3 steps run sequentially; 4+ steps use parallel git worktrees with mandatory principal-architect review before merge. |
| **Scrum** | `/prove:scrum` | Agentic task management backed by `.prove/prove.db`. Tasks, milestones, tags, dependency graph, a layered containment tree (epic/story/task), and first-class acceptance criteria. SessionStart/SubagentStop/Stop hooks reconcile state at task boundaries; orchestrator runs link via `task_id` in `plan.json`. |
| **Methodology** | `/prove:decompose` | Top-down decompose ladder (charter/milestone → epic → story → task) with a human gate per layer, AC-gated story close (each acceptance criterion dispatched by kind: bash / assert / gate / agent), risk-forward review briefs synthesized from the run's reasoning log, and milestone-close curation that promotes findings into the durable decision store. Intake forms (`/prove:intake`) and self-contained HTML report surfaces (`claude-prove report`) render the same data for operators. |
| **ACB** (Agent Change Brief) | `/prove:review-ui` | Every feature-branch commit carries an ACB v0.2 intent manifest written by a PostToolUse hook at commit time. The review UI (React + Fastify, Docker) surfaces intent-grouped diffs for structured review with verdicts: accepted / rejected / needs_discussion / rework. |

## Command Reference

### Planning & Execution

| Command | Description |
|---------|-------------|
| `/prove:orchestrator [--autopilot \| --full]` | Unified orchestrator entry point. `--autopilot` runs an existing plan hands-off; `--full` starts from a description (PRD-first); no flag auto-detects. |
| `/prove:workflow <milestone-id \| plan.json>` | Execute a whole milestone or task tree as parallel waves through orchestrator full-mode machinery (worktrees, validators, review, sequential merge), mirroring status back to scrum. |
| `/prove:plan [--task <desc> \| --step <id>]` | Plan a task (produces `prd.json` + `plan.json`) or drill into a numbered step from the active plan. No args prompts interactively. |
| `/prove:task <handoff\|pickup\|progress\|complete\|cleanup> [slug]` | Task lifecycle dispatcher. `handoff` captures context before ending a session; `pickup` resumes in a fresh session. |
| `/prove:brainstorm` | Explore options, weigh trade-offs, record decisions to `.prove/decisions/`. |

### Methodology

| Command | Description |
|---------|-------------|
| `/prove:decompose [target]` | Drive the decompose ladder: a planning subagent proposes each layer's children, a human gate promotes them, and the ladder recurses charter → epic → story → task. Also runs AC-gated story close. |
| `/prove:intake [charter \| team \| decompose]` | Gather charter/team/decomposition answers through a self-contained HTML form; the validated payload drives the same writer the conversational interview drives. |
| `/prove:reasoning-brief` | Synthesize the 7-section risk-forward Review Brief from a run's reasoning log, with mechanical preservation checks and a prose-quality judge. |
| `/prove:curate` | Milestone-close curation pass: classify reasoning-log findings (ADR / glossary / pattern) and promote them into the durable scrum decision store behind a human gate. |
| `/prove:run-migrate` | Operator-invoked content migration for stored run artifacts that sit behind the current schema (the deterministic structural chain is `claude-prove run-state migrate`). |

### Review & Quality

| Command | Description |
|---------|-------------|
| `/prove:review-ui [--port N] [--stop] [--restart]` | Launch the review UI through the in-process daemon (`claude-prove review-ui serve`) — a detached loopback server reading the repo directly from disk. Opens `http://localhost:5174`. |
| `/prove:steward [--review \| --full \| --auto]` | Code quality audit. `--review` (default) scans current branch changes; `--full` runs a deep line-by-line audit; `--auto` iterates until clean or the pass cap is hit. |
| `/prove:comprehend [commit SHA or range]` | Socratic quiz on recent diffs to build comprehension of agent-generated code. Defaults to the most recent diff. |
| `/prove:bug-fix [symptom]` | Structured debugging protocol — sequential hypothesis testing with backtracking. |

### Scrum

| Command | Description |
|---------|-------------|
| `/prove:scrum init` | One-shot importer to seed scrum tables from legacy planning artifacts. |
| `/prove:scrum status` | Compact text overview of current task state. |
| `/prove:scrum next` | Ranked list of next-ready tasks. |
| `/prove:scrum task` | Interactive task lifecycle via `scrum-master` agent (create, update, transition). |
| `/prove:scrum milestone` | Milestone lifecycle via `scrum-master` agent. |
| `/prove:scrum tag` | Tag taxonomy edits via `scrum-master` agent. |
| `/prove:scrum link` | Link orchestrator runs to scrum tasks. |
| `/prove:scrum alerts` | Review stalled WIP and orphaned tasks. |

### Utilities

| Command | Description |
|---------|-------------|
| `/prove:docs <human\|agent\|both\|claude-md>` | Generate documentation. `human` for READMEs and guides; `agent` for LLM-optimized docs; `both` for both audiences; `claude-md` to generate or update `CLAUDE.md`. |
| `/prove:create <skill\|command\|agent\|spec>` | Scaffold a new Claude Code skill, slash command, subagent, or technical spec. |
| `/prove:prompting <craft\|cache\|token-count>` | Prompt engineering toolkit. Optimize prompts, manage the research cache, or count tokens. |
| `/prove:notify <setup\|test>` | Configure notification reporters (Slack, Discord, MCP, custom) and send test events. |
| `/prove:index [--force]` | Build or update the content-addressable file index. Run after significant structural changes. |
| `/prove:init` | Detect tech stack and generate `.claude/.prove.json`. |
| `/prove:doctor` | Diagnose installation health: config validity, tooling, schema drift, stale worktrees. |
| `/prove:update` | Validate configs, detect schema drift, and apply migrations with approval. |
| `/prove:install-skills` | Install recommended community skills from external repos into `~/.claude/skills/`. |
| `/prove:report-issue [description]` | File a bug report or feature request against the prove plugin via `gh` CLI. |
| `/prove:remember <directive>` | Append or update a directive in `CLAUDE.md` outside the prove-managed section. |
| `/prove:commit` | Semantic commit assistant: groups changes into logical units and creates conventional commits using the scopes in `.claude/.prove.json`. |
| `/prove:prep-permissions` | Analyze the active plan and config to scope `.claude/settings.local.json` permission rules before an autonomous run. |

## Configuration

Run `/prove:init` to auto-detect your tech stack and generate `.claude/.prove.json`. The file controls which validators run after each orchestrator step and which reporters fire on lifecycle events.

```json
{
  "schema_version": "9",
  "validators": [
    { "name": "build", "command": "go build ./...", "phase": "build" },
    { "name": "lint",  "command": "go vet ./...",   "phase": "lint" },
    { "name": "tests", "command": "go test ./...",  "phase": "test" },
    { "name": "doc-quality", "prompt": ".prove/prompts/doc-quality.md", "phase": "llm" }
  ],
  "reporters": [
    { "name": "slack", "command": "./.prove/notify-slack.sh", "events": ["step-complete", "step-halted"] }
  ]
}
```

Auto-detection covers Go, Rust, Python, Node/TypeScript, Godot, and Makefile projects. LLM validators (`phase: "llm"`) are never auto-detected — configure them explicitly. Full schema reference: [`references/validation-config.md`](references/validation-config.md).

## Monorepo Layout

```
packages/
├── cli/        # Bun-native TypeScript CLI — ships as prebuilt binaries for darwin-arm64/x64 and linux-arm64/x64
├── shared/     # Cross-package types, logger, and utilities
├── store/      # Unified SQLite connection via bun:sqlite — schema registry and domain migrations for .prove/prove.db
├── installer/  # Binary distribution helpers and Claude-side wiring (hooks + settings)
└── review-ui/  # React + Fastify + Tailwind — runs in-process under the native daemon (claude-prove review-ui serve)
```

## Deep Dives

- [Orchestrator](docs/orchestrator.md) — execution modes, validation gates, worktrees, and reporting
- [Code Quality](docs/code-quality.md) — steward, auto-steward, and session-scoped review
- [Session Management](docs/session-management.md) — handoff/pickup workflow for context preservation

## License

MIT
