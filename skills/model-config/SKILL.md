---
name: model-config
description: >
  Recommend and declare a project's Claude Code model configuration — the
  `models` block (opusplan hybrid, advisor pairing, fallback chain, effort) —
  and materialize it per machine. Triggers on "model config", "models preset",
  "set up the advisor", "advisor model", "opusplan", "which model should this
  project use", "recommend a model config", "configure models", "model
  optimization". You are the driver: the CLI owns every read and write
  (`claude-prove models`), the `model-config-advisor` agent owns the
  workload-to-pairing judgment, and a human gate owns every declaration and
  every materialization.
---

# Model-Config Skill

You are the **driver**. The split follows the engine boundary: `claude-prove models` owns state (the committed `models` block in `.claude/.prove.json`, its materialization into the gitignored `.claude/settings.local.json`); the `model-config-advisor` agent owns judgment (which pairing fits this project's workload); the operator owns approval. Two hard floors:

- **Every write goes through the CLI** — `models set` for the committed declaration, `models apply` for the per-machine settings. Never edit `.claude/.prove.json` or `.claude/settings.local.json` by hand for model keys.
- **Both writes are human-gated.** The declaration commits a recommendation to the repo; the materialization changes what model the operator's sessions run and bill. Neither happens unprompted.

## Phase 0 — Read state (mechanical)

```bash
claude-prove models status          # declared block + materialization state
claude-prove models presets         # the closed preset table
```

A `NOT materialized` status on an already-declared block is a shortcut: offer `models apply` directly (Phase 3's second gate) and skip the recommendation phases unless the operator wants the declaration revisited.

`models status` exits 1 when `.claude/.prove.json` is missing or unparseable. Stop and route the operator to `/prove:init` (or `claude-prove install init-config`) rather than creating or repairing the file by hand — a hand-written block bypasses the schema validation `models set` performs.

## Phase 1 — Gather workload context

One free-form question when the answer is not already known from the conversation: "What do sessions in this project mostly do — mixed feature work, high-stakes correctness work, routine high-volume changes, unattended/overnight driving?" Collect any constraints the operator volunteers (provider: the advisor requires the Anthropic API; billing sensitivity; context-window pressure).

## Phase 2 — Advisor recommendation (judgment)

Dispatch the `model-config-advisor` agent with: the Phase 0 command outputs verbatim, the workload answer, and the project root path (the agent reads repo signals itself) — the agent has no Bash, so anything it needs from the CLI must be pasted into its prompt; the project root must be absolute. The agent returns a single JSON block — a preset name or a custom block, with rationale and caveats.

- `"status": "blocked"` → relay the agent's question to the operator, then re-dispatch with the answer.
- Never modify the agent's recommendation silently; disagreement is a reason to re-dispatch with the missing context, not to substitute your own pairing.

## Phase 3 — Gate and execute

Present the recommendation: the block, the rationale, and every caveat verbatim. `AskUserQuestion` (header: "Models"):

- "Accept (Recommended)" — declare it:
  - Preset: `claude-prove models set --preset <name>` — replaces the whole block, so no stale field from a prior declaration survives, including a previously declared `planning`; re-declare it with `--planning` when the operator wants the non-default route.
  - Custom block: pass every field the recommendation names — `--main`, `--advisor`, `--fallback` (comma-separated, not a JSON array), `--effort`, `--planning`. Field flags AMEND the existing block rather than replacing it, so any field the recommendation drops must be cleared explicitly with `""` (e.g. `--advisor ""` when the recommendation drops the advisor). Never leave a dropped field to chance.
- "Adjust" — take the operator's changes, re-run them past the pairing rules (re-dispatch the agent when the change alters the pairing), then declare
- "Skip" — no write; note that `claude-prove models set` can declare one later

After a declaration, offer the per-machine half. `AskUserQuestion` (header: "Apply"):

- "Apply on this machine" — `claude-prove models apply` (takes effect next session)
- "Declare only" — each operator materializes their own; `install doctor` surfaces the pending apply as the warn-level `models-drift` check

Relay CLI output verbatim, and branch on which verb produced it:

- `models apply` / `models status` print the advisory pairing warnings (Haiku advisor, Fable main, chain longer than three). They are advisory — Claude Code enforces the rules at session start — so they inform the operator rather than block the flow; `apply` still writes.
- `models set` prints no pairing warning. It prints the written block, the "run `models apply`" note, or — on a schema-invalid field — an error and exit 1 with nothing written. On exit 1, fix the field and re-run `set`; never hand-edit `.claude/.prove.json` to work around it.
- Run `models status` after any custom-block declaration, since that is the first point the pairing warnings can surface.

## Phase 4 — Confirm

Re-run `claude-prove models status` and report the end state in one line: declared block, materialized or pending, and — when materialized — that a session restart picks it up.

When the block includes an advisor, set the expectation for runtime verification: prove verifies **materialization**, not consultation. Advisor activations are visible only in Claude Code's own surfaces — the session-start "Advisor Tool is on" notification, the `Advising` transcript line during a consultation (Ctrl+O expands the guidance), and `/usage` session totals. No hook event fires for advisor calls (server-side tools bypass the hook machinery), so there is no prove-side telemetry to configure.
