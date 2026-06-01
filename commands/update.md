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

1. **External references**: If `claude_md.references` is absent or empty, scan `$PLUGIN_DIR/references/` for bundled `.md` files. Extract labels from first `# Heading` line (fall back to filename sans extension). **Exclude `claude-prove-reference.md` and `design-principles.md`** — the composer injects both as built-in defaults; offering them here would create duplicates the dedup logic silently drops.

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

   **Scrum hooks** (schema v5+): when `tools.scrum.enabled` is true and `.claude/settings.json` is missing scrum-tagged hook entries, add three entries (SessionStart matcher `startup|resume|compact`, SubagentStop no matcher, Stop no matcher — all invoking `claude-prove scrum hook <event>` with `_tool: "scrum"`). Dev-mode installs substitute the resolved `bun run <plugin>/packages/cli/bin/run.ts` prefix via `resolveBinaryPath`. Idempotent: skip if `_tool: "scrum"` entries already present.

3. **Methodology config knobs** (config schema v8): the `.claude/.prove.json` schema gains three optional config blocks. They are migrated in (with their defaults) by Step 4's `schema migrate` — there is nothing to add by hand — but surface them so the operator knows the tunables exist:

   - `brief.single_pass_token_threshold` (default `8000`), `brief.max_synthesis_retries` (default `2`), `brief.prose_judge_on` (default `true`) — reasoning Review Brief synthesis tunables (multipass split, retry budget, whether the non-blocking prose judge runs).
   - `memory.stale_threshold_days` (default `90`) — age past which `scrum decision review-stale` flags a decision.
   - `decomposition.auto_accept_through` (default `none`; one of `none|epic|story|task`) — the decompose layer through which children auto-promote `backlog → ready` without a human accept gate.

   ```
   New plugin feature: Methodology config knobs (schema v8)

   Optional tunables now available in .claude/.prove.json (defaults applied by migration):
     brief.single_pass_token_threshold, brief.max_synthesis_retries, brief.prose_judge_on
     memory.stale_threshold_days
     decomposition.auto_accept_through
   ```

   Note "These knobs are optional — defaults are migrated in; edit `.claude/.prove.json` only to override." Do not prompt to write them.

4. **New methodology skills + CLI surfaces**: these are discovered automatically on plugin load (skills/agents) or ship in the CLI — there is no `.claude/.prove.json` change. Note them so the operator knows the capabilities are live:

   - **`reasoning-brief`** skill + **`brief-judge`** agent — synthesize the 7-section risk-forward Review Brief from a run's reasoning log, gated by `acb brief render|validate` (mechanical preservation check) and a non-blocking prose judge.
   - **`curate`** skill — milestone-close pass that lifts durable reasoning-log findings into `scrum_decisions`.
   - **`run-migrate`** skill + **`run-state migrate-runs`** — on-demand, operator-invoked migration for CONTENT reshaping of stored run artifacts beyond column moves: the CLI mechanically detects which artifacts are behind the current schema and emits a plan (target artifacts + per-hop instruction file), and the skill applies the model-driven reshaping behind an operator gate. Composes with the deterministic `run-state migrate`/`schema migrate` (structure first, content second); never a background loop.
   - **`acb milestone-brief render|validate --milestone <id>`** — stakeholder rollup aggregating a milestone's per-story briefs.
   - **`scrum decision record --kind <adr|glossary|pattern>`** and **`scrum decision list --kind <k>`** — the decision subtype taxonomy.
   - **`scrum decision review-stale [--days N]`**, **`scrum task cancel [--cascade]`**, **`scrum milestone create|list --initiative <label>`**, tree-aware `scrum status`, and typed-escalation ranking in `scrum next-ready` / `scrum alerts`.

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
