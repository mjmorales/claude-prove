---
description: Validate configs, detect schema drift, and apply safe migrations
---

# Update Configuration

Validate `.claude/.prove.json` and `.claude/settings.json` against current schema, detect drift, and apply migrations with user approval. See `UPDATES.md` at the plugin root for the human-readable migration guide.

`$PLUGIN_DIR` refers to this plugin's root (parent of `commands/`).

**CRITICAL**: All commands run against the **user's current working directory** (the project being updated), NOT the plugin directory. Every schema tool call MUST use `--file` with an absolute path to the project's config. Never rely on cwd resolution.

## Instructions

### Step 0: Guard — verify target project

**MUST check before proceeding:**

1. Verify `$PLUGIN_DIR` is set (resolved from this plugin's root). If not, error: "Cannot resolve plugin directory."
2. Verify `$(pwd)` is NOT inside `~/.claude/` (e.g., `~/.claude/plugins/prove`, `~/.claude/extensions/*/prove`). **Exception:** if `$(pwd)` equals `$PLUGIN_DIR` and `$(pwd)/.claude/.prove.json` exists, this is dogfooding mode — allow it and set both `$PLUGIN_DIR` and project root to `$(pwd)`.
3. Verify `$(pwd)/.claude/.prove.json` exists. If not, proceed to Step 0b (bootstrap) instead of failing.

### Step 0b: Bootstrap (if .prove.json missing)

If `$(pwd)/.claude/.prove.json` does not exist, offer to create a minimal config so the migration chain can run:

`AskUserQuestion` with header "Bootstrap" and options:
- "Create minimal config" — write `{"schema_version": "0"}` to `.claude/.prove.json` and continue to Step 1
- "Run /prove:init instead" — suggest the full init flow and stop
- "Cancel" — stop

On "Create minimal config": write the file and proceed. The v0 → current migration will add all default fields.

### Step 1: Run validation

```bash
PYTHONPATH="$PLUGIN_DIR" python3 -m tools.schema validate --file "$(pwd)/.claude/.prove.json"
```

Present the output. Shows validation errors/warnings, migration changes needed, and target config.

### Step 2: Assess migration need

If no migration needed and no validation errors: report "Configs are up to date and valid. Nothing to do." and skip to Step 8.

### Step 3: Present migration plan

```bash
PYTHONPATH="$PLUGIN_DIR" python3 -m tools.schema migrate --file "$(pwd)/.claude/.prove.json" --dry-run
```

Present changes, then `AskUserQuestion` with header "Migration" and options:
- "Apply All" — apply with backup
- "Review Each" — walk through one at a time
- "Skip" — no changes

### Step 4: Apply migration

**Apply All:**
```bash
PYTHONPATH="$PLUGIN_DIR" python3 -m tools.schema migrate --file "$(pwd)/.claude/.prove.json"
```
Creates `.claude/.prove.json.<timestamp>.bak` backup.

**Review Each:** Present each change individually. For each, `AskUserQuestion` with header "Change" and options: "Apply" / "Skip". Apply only approved changes.

### Step 5: Discover new plugin features

Check for plugin capabilities not yet configured in the project's `.claude/.prove.json`:

1. **External references**: If `claude_md.references` is absent or empty, scan `$PLUGIN_DIR/references/` for bundled `.md` files. For each `.md` file, extract the label from the first `# Heading` line (fall back to the filename without extension if no heading found). Present them:

```
New plugin feature: External References

Bundled references available:
  1. references/llm-coding-standards.md — LLM-Optimized Coding Standards
  2. references/interaction-patterns.md — Interaction Patterns
```

`AskUserQuestion` with header "References" and options: "Add All" / "Pick individually" / "Skip".

On "Add All" or per-item approval: write each as a `{path, label}` object to `claude_md.references`. The schema requires objects, NOT plain strings:

```json
{"path": "references/llm-coding-standards.md", "label": "LLM-Optimized Coding Standards"}
```

Paths are relative to the plugin root. Labels come from the H1 heading in the file.

2. **Core commands**: If new commands with `core: true` have been added since the last CLAUDE.md generation, they'll be picked up automatically in Step 8 (CLAUDE.md regeneration). No user action needed — just note "New commands detected, will appear in CLAUDE.md after regeneration."

3. **New tools**: Run the registry to detect tools not yet enabled:

```bash
PYTHONPATH="$PLUGIN_DIR" python3 "$PLUGIN_DIR/tools/registry.py" \
  --plugin-root "$PLUGIN_DIR" --project-root "$(pwd)" available
```

If any tools are available but not enabled, present each with its description. `AskUserQuestion` with header "New Tool" and options: "Install" / "Skip" for each.

On "Install": run `python3 "$PLUGIN_DIR/tools/registry.py" --plugin-root "$PLUGIN_DIR" --project-root "$(pwd)" install <tool>`.

Skip this step entirely if all features are already configured.

### Step 6: Validate settings.json

```bash
PYTHONPATH="$PLUGIN_DIR" python3 -m tools.schema validate --file "$(pwd)/.claude/settings.json"
```

If the file does not exist, skip. If issues found, present and offer to fix.

### Step 7: Re-validate

```bash
PYTHONPATH="$PLUGIN_DIR" python3 -m tools.schema validate --file "$(pwd)/.claude/.prove.json"
```

Report: PASS/FAIL per config file, schema version, backup location (if applicable).

### Step 8: Update CLAUDE.md

```bash
python3 "$PLUGIN_DIR/skills/claude-md/__main__.py" generate --project-root "$(pwd)" --plugin-dir "$PLUGIN_DIR"
```

Replaces only the `<!-- prove:managed:start -->` / `<!-- prove:managed:end -->` block. Content outside markers is preserved. On first run, writes the full file with markers.

Show generated sections summary.

### Step 9: Next steps

- Schema version added: "Config is now tracked. Future updates migrate incrementally."
- Errors remain: "Fix remaining issues, then run `/prove:update` again."
- All passed: "All configs valid and up to date."
- CLAUDE.md updated: "Managed section refreshed. Custom sections preserved."
