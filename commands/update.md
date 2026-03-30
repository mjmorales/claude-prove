---
description: Validate configs, detect schema drift, and apply safe migrations
---

# Update Configuration

Validate `.claude/.prove.json` and `.claude/settings.json` against current schema, detect drift, and apply migrations with user approval. See `UPDATES.md` at the plugin root for the human-readable migration guide.

All schema tool calls use `--file` with an absolute path to the project's config. Run against the user's current working directory, not the plugin directory.

## Step 0: Guard

1. Verify `$PLUGIN_DIR` is set. If not, error: "Cannot resolve plugin directory."
2. Verify `$(pwd)` is NOT inside `~/.claude/`. **Exception:** if `$(pwd)` equals `$PLUGIN_DIR` and `$(pwd)/.claude/.prove.json` exists, this is dogfooding mode — allow it and set both `$PLUGIN_DIR` and project root to `$(pwd)`.
3. If `$(pwd)/.claude/.prove.json` does not exist, go to Step 0b instead of failing.

### Step 0b: Bootstrap (if .prove.json missing)

`AskUserQuestion` (header: "Bootstrap"):
- "Create minimal config" — write `{"schema_version": "0"}` to `.claude/.prove.json` and continue to Step 1
- "Run /prove:init instead" — suggest the full init flow and stop
- "Cancel" — stop

On "Create minimal config": write the file and proceed. The v0 -> current migration adds all default fields.

## Step 1: Run validation

```bash
PYTHONPATH="$PLUGIN_DIR" python3 -m tools.schema validate --file "$(pwd)/.claude/.prove.json"
```

Present the output.

## Step 2: Assess migration need

If no migration needed and no validation errors: "Configs are up to date and valid. Nothing to do." Skip to Step 8.

## Step 3: Present migration plan

```bash
PYTHONPATH="$PLUGIN_DIR" python3 -m tools.schema migrate --file "$(pwd)/.claude/.prove.json" --dry-run
```

Present changes, then `AskUserQuestion` (header: "Migration"):
- "Apply All" — apply with backup
- "Review Each" — walk through one at a time
- "Skip" — no changes

## Step 4: Apply migration

**Apply All:**
```bash
PYTHONPATH="$PLUGIN_DIR" python3 -m tools.schema migrate --file "$(pwd)/.claude/.prove.json"
```
Creates `.claude/.prove.json.<timestamp>.bak` backup.

**Review Each:** Present each change individually. For each, `AskUserQuestion` (header: "Change"): "Apply" / "Skip". Apply only approved changes.

## Step 5: Discover new plugin features

Check for plugin capabilities not yet configured in `.claude/.prove.json`:

1. **External references**: If `claude_md.references` is absent or empty, scan `$PLUGIN_DIR/references/` for bundled `.md` files. Extract labels from first `# Heading` line (fall back to filename sans extension).

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

3. **New tools**:
   ```bash
   PYTHONPATH="$PLUGIN_DIR" python3 "$PLUGIN_DIR/tools/registry.py" \
     --plugin-root "$PLUGIN_DIR" --project-root "$(pwd)" available
   ```
   If tools are available but not enabled, present each with description. `AskUserQuestion` (header: "New Tool"): "Install" / "Skip" per tool.

   On "Install" for packs (`kind: "pack"`): if `$PLUGIN_DIR` != `$(pwd)` (not dogfooding), ask install scope via `AskUserQuestion` (header: "Scope"):
   - "User (Recommended)" — symlinks in plugin dir, available to all projects
   - "Project" — symlinks in project dir, this project only

   If dogfooding (`$PLUGIN_DIR` == `$(pwd)`), default to `--scope user` without asking.

   On "Install": `python3 "$PLUGIN_DIR/tools/registry.py" --plugin-root "$PLUGIN_DIR" --project-root "$(pwd)" install <tool> --scope <user|project>`.

   Infrastructure tools (`kind: "tool"`) always use `--scope user` — no scope question needed.

Skip this step entirely if all features are already configured.

## Step 6: Validate settings.json

```bash
PYTHONPATH="$PLUGIN_DIR" python3 -m tools.schema validate --file "$(pwd)/.claude/settings.json"
```

Skip if file does not exist. If issues found, present and offer to fix.

## Step 7: Re-validate

```bash
PYTHONPATH="$PLUGIN_DIR" python3 -m tools.schema validate --file "$(pwd)/.claude/.prove.json"
```

Report: PASS/FAIL per config file, schema version, backup location (if applicable).

## Step 8: Update CLAUDE.md

```bash
python3 "$PLUGIN_DIR/skills/claude-md/__main__.py" generate --project-root "$(pwd)" --plugin-dir "$PLUGIN_DIR"
```

Replaces only the `<!-- prove:managed:start -->` / `<!-- prove:managed:end -->` block. Content outside markers is preserved.

Show generated sections summary.

## Step 9: Next steps

- Schema version added: "Config is now tracked. Future updates migrate incrementally."
- Errors remain: "Fix remaining issues, then run `/prove:update` again."
- All passed: "All configs valid and up to date."
- CLAUDE.md updated: "Managed section refreshed. Custom sections preserved."
