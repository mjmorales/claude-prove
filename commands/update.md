---
description: Validate configs, detect schema drift, and apply safe migrations
---

# Update Configuration

Validate `.prove.json` and `.claude/settings.json` against current schema, detect drift, and apply migrations with user approval. See `UPDATES.md` at the plugin root for the human-readable migration guide.

## Instructions

### Step 1: Run validation

```bash
python3 -m tools.schema summary
```

Present the output. Shows validation errors/warnings, migration changes needed, and target config.

### Step 2: Assess migration need

If no migration needed and no validation errors: report "Configs are up to date and valid. Nothing to do." and skip to Step 7.

### Step 3: Present migration plan

```bash
python3 -m tools.schema migrate --dry-run
```

Present changes, then `AskUserQuestion` with header "Migration" and options:
- "Apply All" — apply with backup
- "Review Each" — walk through one at a time
- "Skip" — no changes

### Step 4: Apply migration

**Apply All:**
```bash
python3 -m tools.schema migrate
```
Creates `.prove.json.<timestamp>.bak` backup.

**Review Each:** Present each change individually. For each, `AskUserQuestion` with header "Change" and options: "Apply" / "Skip". Apply only approved changes.

### Step 5: Discover new plugin features

Check for plugin capabilities not yet configured in `.prove.json`:

1. **External references**: If `claude_md.references` is absent or empty in `.prove.json`, scan `$PLUGIN_DIR/references/` for bundled `.md` files. If found, present them:

```
New plugin feature: External References

Bundled references available:
  1. $PLUGIN_DIR/references/llm-coding-standards.md — LLM Coding Standards
```

`AskUserQuestion` with header "New Features" and options: "Configure" / "Skip".

On "Configure": follow the same flow as init Step 7 — offer bundled + global candidates, write to `claude_md.references` in `.prove.json`.

2. **Core commands**: If new commands with `core: true` have been added since the last CLAUDE.md generation, they'll be picked up automatically in Step 8 (CLAUDE.md regeneration). No user action needed — just note "New commands detected, will appear in CLAUDE.md after regeneration."

Skip this step entirely if all features are already configured.

### Step 6: Validate settings.json

```bash
python3 -m tools.schema validate --file .claude/settings.json
```

If issues found, present and offer to fix (missing hooks, structural problems).

### Step 7: Re-validate

```bash
python3 -m tools.schema validate
```

Report: PASS/FAIL per config file, schema version, backup location (if applicable).

### Step 8: Update CLAUDE.md

```bash
python3 skills/claude-md/__main__.py generate
```

Replaces only the `<!-- prove:managed:start -->` / `<!-- prove:managed:end -->` block. Content outside markers is preserved. On first run, writes the full file with markers.

Show generated sections summary.

### Step 9: Next steps

- Schema version added: "Config is now tracked. Future updates migrate incrementally."
- Errors remain: "Fix remaining issues, then run `/prove:update` again."
- All passed: "All configs valid and up to date."
- CLAUDE.md updated: "Managed section refreshed. Custom sections preserved."
