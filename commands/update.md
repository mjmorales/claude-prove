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

1. **External references**: If `claude_md.references` is absent or empty, scan `$PLUGIN_DIR/references/` for bundled `.md` files. Extract labels from first `# Heading` line (fall back to filename sans extension). **Exclude `claude-prove-reference.md`** — the composer injects it as a built-in default; offering it here would create a duplicate the dedup logic silently drops.

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

   **Scrum hooks** (schema v5+): when `tools.scrum.enabled` is true and `.claude/settings.json` is missing scrum-tagged hook entries, add three entries (SessionStart matcher `startup|resume|compact`, SubagentStop no matcher, Stop no matcher — all invoking `bun run <plugin>/packages/cli/bin/run.ts scrum hook <event>` with `_tool: "scrum"`). Idempotent: skip if `_tool: "scrum"` entries already present.

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

Substitute `$PLUGIN_DIR` with the path resolved in Step 0a. Pick one branch:

**Compiled mode** — if `$PLUGIN_DIR/packages/cli/` does NOT exist (standard install under `~/.claude/plugins/cache/`):

```bash
claude-prove claude-md generate --project-root "$(pwd)" --plugin-dir "$PLUGIN_DIR"
```

**Dogfooding mode** — if `$PLUGIN_DIR/packages/cli/bin/run.ts` exists (running from the plugin checkout):

```bash
bun run "$PLUGIN_DIR/packages/cli/bin/run.ts" claude-md generate --project-root "$(pwd)" --plugin-dir "$PLUGIN_DIR"
```

Only the `<!-- prove:managed:start -->` / `<!-- prove:managed:end -->` block is replaced. Content outside the markers is preserved.

Show the generated sections summary.

## Step 9: Next steps

- Schema version added: "Config is now tracked. Future updates migrate incrementally."
- Errors remain: "Fix remaining issues, then run `/prove:update` again."
- All passed: "All configs valid and up to date."
- CLAUDE.md updated: "Managed section refreshed. Custom sections preserved."
