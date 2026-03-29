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
2. Verify `$(pwd)` is NOT inside `~/.claude/` (e.g., `~/.claude/plugins/prove`, `~/.claude/extensions/*/prove`). If it is, error: "You are inside the plugin directory. Run this command from your project root, not the plugin installation."
3. Verify `$(pwd)/.claude/.prove.json` exists. If not, inform the user and suggest `/prove:init`.

Do NOT proceed if any check fails.

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

1. **External references**: If `claude_md.references` is absent or empty, scan `$PLUGIN_DIR/references/` for bundled `.md` files. If found, present them:

```
New plugin feature: External References

Bundled references available:
  1. $PLUGIN_DIR/references/llm-coding-standards.md — LLM Coding Standards
```

`AskUserQuestion` with header "New Features" and options: "Configure" / "Skip".

On "Configure": follow the same flow as init Step 7 — offer bundled + global candidates, write to `claude_md.references` in the project's `.claude/.prove.json`.

2. **Core commands**: If new commands with `core: true` have been added since the last CLAUDE.md generation, they'll be picked up automatically in Step 8 (CLAUDE.md regeneration). No user action needed — just note "New commands detected, will appear in CLAUDE.md after regeneration."

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
