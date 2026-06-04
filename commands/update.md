---
description: Validate configs, detect schema drift, and apply safe migrations
---

# Update Configuration

Validate `.claude/.prove.json` and `.claude/settings.json` against current schema, detect drift, and apply migrations with user approval. See `UPDATES.md` at the plugin root for the human-readable migration guide.

All schema tool calls use `--file` with an absolute path to the project's config. Run against the user's current working directory, not the plugin directory.

## Step 0: Pre-flight

### 0a: Resolve plugin location

**Dogfooding shortcut:** if `$(pwd)/.claude-plugin/plugin.json` exists, set `PLUGIN_DIR = $(pwd)` and skip the CLI call below. Otherwise:

```bash
claude-prove install latest
```

Apply these rules to the JSON output, in order:

1. **Halt if `local` is null.** Message: "Plugin not installed — run `claude plugin install prove@prove`." Do not proceed.
2. **Set `PLUGIN_DIR = local.installPath`.** This path is referenced as `$PLUGIN_DIR` in later steps; substitute the literal value when issuing commands.
3. **Record `local.version`** for the pinned reference in CLAUDE.md.
4. **Warn on remote mismatch, then continue.** If `remote.version` differs from `local.version`, surface: "Newer release available: `local.version` → `remote.version`. Run `claude plugin update prove@prove` to upgrade, then re-run `/prove:update`." Continue the rest of the skill against the locally installed version — this skill syncs configs against what is on disk, never against an unreleased remote.
5. **Surface `errors.local` / `errors.remote` if present,** but do not abort unless rule 1 triggered.

### 0b: Guard working directory

Verify `$(pwd)` is NOT inside `~/.claude/` — prevents accidentally mutating the plugin cache. If it is (and the dogfooding shortcut above did not fire), halt: "Run `/prove:update` from your project root, not inside the plugin cache."

### 0c: Bootstrap if `.prove.json` is missing

If `$(pwd)/.claude/.prove.json` does not exist, `AskUserQuestion` (header: "Bootstrap"):
- "Create minimal config" — write `{"schema_version": "0"}` to `.claude/.prove.json` and continue to Step 1
- "Run /prove:init instead" — suggest the full init flow and stop
- "Cancel" — stop

On "Create minimal config": write the file and proceed. The v0 -> current migration adds all default fields.

## Step 1: Run validation

```bash
claude-prove schema validate --file "$(pwd)/.claude/.prove.json"
```

Present the output.

## Step 2: Assess migration need

If no migration needed and no validation errors: "Configs are up to date and valid. Nothing to do." Skip to Step 8.

## Step 3: Present migration plan

```bash
claude-prove schema migrate --file "$(pwd)/.claude/.prove.json" --dry-run
```

Present changes, then `AskUserQuestion` (header: "Migration"):
- "Apply All" — apply with backup
- "Review Each" — walk through one at a time
- "Skip" — no changes

## Step 4: Apply migration

**Apply All:**
```bash
claude-prove schema migrate --file "$(pwd)/.claude/.prove.json"
```
Creates `.claude/.prove.<timestamp>.bak` backup.

**Review Each:** Present each change individually. For each, `AskUserQuestion` (header: "Change"): "Apply" / "Skip". Apply only approved changes.

## Step 5: Discover new plugin features

Check for plugin capabilities not yet configured in `.claude/.prove.json`:

1. **External references**: If `claude_md.references` is absent or empty, scan `$PLUGIN_DIR/references/` for bundled `.md` files. Extract labels from first `# Heading` line (fall back to filename sans extension). **Exclude `claude-prove-reference.md`, `design-principles.md`, and `agent-routing.md`** — the composer injects all three as built-in defaults; offering them here would create duplicates the dedup logic silently drops.

   ```
   New plugin feature: External References

   Bundled references available:
     1. references/llm-coding-standards.md — LLM-Optimized Coding Standards
     2. references/interaction-patterns.md — Interaction Patterns
   ```

   `AskUserQuestion` (header: "References"): "Add All" / "Pick individually" / "Skip".

   Write each as `{path, label}` object to `claude_md.references` (schema requires objects, not strings):
   ```json
   {"path": "references/llm-coding-standards.md", "label": "LLM-Optimized Coding Standards"}
   ```
   Paths relative to plugin root. Labels from H1 heading.

2. **Core commands**: New `core: true` commands are picked up automatically in Step 8 (CLAUDE.md regeneration). Note "New commands detected, will appear in CLAUDE.md after regeneration."

   **Scrum hooks** (schema v5+): when `tools.scrum.enabled` is true and `.claude/settings.json` is missing scrum-tagged hook entries, add three entries (SessionStart matcher `startup|resume|compact`, SubagentStop no matcher, Stop no matcher — all invoking `claude-prove scrum hook <event>` with `_tool: "scrum"`). Dev-mode installs substitute the shell-interpolated `bun run "${CLAUDE_PROVE_PLUGIN_DIR:-$HOME/.claude/plugins/prove}/packages/cli/bin/run.ts"` prefix via `resolveBinaryPath` — never a machine-absolute checkout path. Idempotent: skip if `_tool: "scrum"` entries already present.

   **Portable hook prefixes**: when any prove-owned hook command in `.claude/settings.json` embeds a machine-absolute dev prefix (`bun run /abs/path/.../packages/cli/bin/run.ts` — the pre-portable emission; `claude-prove install doctor` warns "machine-absolute dev prefix"), offer to regenerate with `claude-prove install init-hooks --force` and to run `/prove:local-env` so this machine's checkout path lands in the gitignored `.claude/settings.local.json` `env` block (`env.CLAUDE_PROVE_PLUGIN_DIR`). `AskUserQuestion` (header: "Hooks"): "Regenerate" / "Skip".

3. **Methodology config knobs** (config schema v9/v10): the `.claude/.prove.json` schema gains optional config blocks. The version stamp is migrated in by Step 4's `schema migrate` — there is nothing to add by hand — but surface the tunables so the operator knows they exist:

   - `brief.single_pass_token_threshold` (default `8000`), `brief.max_synthesis_retries` (default `2`), `brief.prose_judge_on` (default `true`) — reasoning Review Brief synthesis tunables (multipass split, retry budget, whether the non-blocking prose judge runs).
   - `memory.stale_threshold_days` (default `90`) — age past which `scrum decision review-stale` flags a decision.
   - `decomposition.auto_accept_through` (default `none`; one of `none|epic|story|task`) — the decompose layer through which children auto-promote `proposed → accepted` without a human accept gate.
   - `triggers` (v9; absent = no bindings) — an **opt-in** trigger table: a list of `{ on, workflow, description? }` mapping a task status to a bound next-action the scrum reconciler surfaces in its session-start digest. Unlike the tunables above it has no default — populate it only to use trigger bindings.
   - `artifacts.html_open` (v10; absent = platform default opener) — an **opt-in** shell command template the `--open` flag (`report`, `intake render`) uses to launch written HTML artifacts; `{file}` is replaced with the quoted artifact path. Populate it to route intake forms / previews / briefs into a specific surface, e.g. `"cursor {file}"` for an editor's embedded preview or `"open -a Safari {file}"` for a specific browser.

   ```
   New plugin feature: Methodology config knobs (schema v9/v10)

   Optional tunables now available in .claude/.prove.json (defaults applied by migration):
     brief.single_pass_token_threshold, brief.max_synthesis_retries, brief.prose_judge_on
     memory.stale_threshold_days
     decomposition.auto_accept_through
   Opt-in (no default — populate to use): triggers, artifacts.html_open
   ```

   Note "These knobs are optional — defaults are migrated in; edit `.claude/.prove.json` only to override (or to populate the opt-in `triggers` table / `artifacts.html_open` opener)." Do not prompt to write them.

4. **New methodology skills + CLI surfaces**: these are discovered automatically on plugin load (skills/agents) or ship in the CLI — there is no `.claude/.prove.json` change. Note them so the operator knows the capabilities are live:

   - **`reasoning-brief`** skill + **`brief-judge`** agent — synthesize the 7-section risk-forward Review Brief from a run's reasoning log, gated by `acb brief render|validate` (mechanical preservation check) and a non-blocking prose judge.
   - **`curate`** skill — milestone-close pass that lifts durable reasoning-log findings into `scrum_decisions`.
   - **`run-migrate`** skill + **`run-state migrate-runs`** — on-demand, operator-invoked migration for CONTENT reshaping of stored run artifacts beyond column moves: the CLI mechanically detects which artifacts are behind the current schema and emits a plan (target artifacts + per-hop instruction file), and the skill applies the model-driven reshaping behind an operator gate. Composes with the deterministic `run-state migrate`/`schema migrate` (structure first, content second); never a background loop.
   - **`acb milestone-brief render|validate --milestone <id>`** — stakeholder rollup aggregating a milestone's per-story briefs.
   - **`scrum decision record --kind <adr|glossary|pattern>`** and **`scrum decision list --kind <k>`** — the decision subtype taxonomy.
   - **`scrum decision review-stale [--days N]`**, **`scrum task cancel [--cascade]`**, **`scrum milestone create|list --initiative <label>`**, tree-aware `scrum status`, and typed-escalation ranking in `scrum next-ready` / `scrum alerts`.
   - **`scrum task acceptance verify <task> --verdict verified|failed [--criterion ID] [--by WHO]`** — records the verification verdict the story-close floor reads for `assert`/`bash`/`agent` criteria (the out-of-turn counterpart to `scrum gate respond`).
   - **`proposed` / `accepted` task states** — `scrum task status <id> proposed|accepted` drives the decomposition-review lifecycle (`backlog → proposed → accepted → ready`); the per-layer `decompose` ladder fires the next tier on `accepted`.
   - **`plan.json tasks[].execution` block** (run-state schema v4) — optional durable run-record directives (`retry` / `loop` / `fanout` / `on_fail` / `concurrency`) the workflow/orchestrator driver honors; advance on-disk run artifacts with `claude-prove run-state migrate`.
   - **Bound next-actions in the session-start digest** — when `.claude/.prove.json` carries a `triggers` table, the scrum reconciler surfaces each task sitting in a triggering status as a pending next-action (automatic; no config edit beyond populating `triggers`).
   - **HTML rendering surfaces** — **`report <action>`** (`render`/`validate`/`brief`/`milestone-brief`/`timeline`/`status`/`decompose-preview`) compiles a closed report/v1 block-document model to a self-contained HTML page, and **`intake <action>`** (`render`/`validate`/`spec`/`list`) plus the **`intake`** skill render the charter/team/decompose Q&A as an interactive form whose pasted-back payload validates against the same form and drives the same writer the conversational interview drives (`secret`/`file` field types rejected).
   - **Native review UI daemon (schema v11)** — **`review-ui serve <start|stop|status|restart>`** runs the review UI as a detached loopback daemon (pidfile + log under `~/.claude-prove/review-ui/`, binds `127.0.0.1` only); there is no Docker image to pull. It serves every project in the machine-global `~/.claude-prove/projects.json` registry (auto-populated on CLI use), managed by **`review-ui project <list|hide|remove|add>`**. The listen port is now machine-global: set `~/.claude-prove/config.json::review_ui_port` (top-level key, default `5174`) — a per-project `tools.acb.config.review_ui_port` is informational only, and the v10→v11 migration drops the retired `review_ui_image`/`review_ui_tag` keys. If an earlier Docker-based version left a `prove-review` container, note it can be removed once with `docker rm -f prove-review`.

   Note "New skills, agent, and CLI surfaces detected — live after this update; no config edit required."

Skip this step entirely if all features are already configured.

## Step 6: Validate settings.json

```bash
claude-prove schema validate --file "$(pwd)/.claude/settings.json"
```

Skip if file does not exist. If issues found, present and offer to fix.

## Step 7: Re-validate

```bash
claude-prove schema validate --file "$(pwd)/.claude/.prove.json"
```

Report: PASS/FAIL per config file, schema version, backup location (if applicable).

## Step 8: Update CLAUDE.md

Substitute `$PLUGIN_DIR` with the path resolved in Step 0a.

```bash
claude-prove claude-md generate --project-root "$(pwd)" --plugin-dir "$PLUGIN_DIR"
```

Only the `<!-- prove:managed:start -->` / `<!-- prove:managed:end -->` block is replaced. Content outside the markers is preserved.

Show the generated sections summary.

## Step 9: Next steps

- Schema version added: "Config is now tracked. Future updates migrate incrementally."
- Errors remain: "Fix remaining issues, then run `/prove:update` again."
- All passed: "All configs valid and up to date."
- CLAUDE.md updated: "Managed section refreshed. Custom sections preserved."
