---
name: update
description: >
  Validate configs, detect schema drift, and apply safe migrations.
  Checks .prove.json and .claude/settings.json against the current schema,
  shows migration changes needed, and applies them with user approval.
---

# Update Configuration

Validate `.prove.json` and `.claude/settings.json` against the current schema, detect drift, and apply safe migrations with user approval.

## Behavior

1. Determine the absolute path to this plugin's `tools/schema` module — use the directory this SKILL.md was loaded from to resolve it (e.g., if this skill is at `/path/to/prove/skills/update/SKILL.md`, the module is at `/path/to/prove/tools/schema`)
2. Run all commands from the **user's current working directory** (the project being updated, NOT the plugin directory)

## Steps

### Step 1: Run validation and diff

```bash
python3 -m tools.schema summary
```

Run from the plugin directory with `PYTHONPATH` set, or use the absolute module path. Present the output to the user showing:
- Validation errors/warnings for both config files
- Migration changes needed (if any)
- Target config after migration

### Step 2: Assess migration need

If no migration is needed and no validation errors exist:
> Your configs are up to date and valid. Nothing to do.

If there are changes, continue to Step 3.

### Step 3: Present migration plan

```bash
python3 -m tools.schema migrate --dry-run
```

Present the changes to the user, then ask:
- **Apply All** — apply all changes with backup
- **Review Each** — walk through changes one at a time
- **Skip** — don't modify configs

### Step 4: Apply migration

If "Apply All":
```bash
python3 -m tools.schema migrate
```

This creates a `.prove.json.<timestamp>.bak` backup and applies the migration.

If "Review Each": present each change individually and apply only approved changes.

### Step 5: Validate settings.json

```bash
python3 -m tools.schema validate --file .claude/settings.json
```

If there are issues, present them and offer to fix.

### Step 6: Re-validate

```bash
python3 -m tools.schema validate
```

Present final status: PASS/FAIL for each config, schema version, backup location.

### Step 7: Update CLAUDE.md

Determine the absolute path to the `skills/claude-md/__main__.py` script from this plugin:

```bash
python3 $PLUGIN/skills/claude-md/__main__.py generate
```

This only replaces the `<!-- prove:managed:start -->` / `<!-- prove:managed:end -->` block. User content outside markers is preserved.

### Step 8: Suggest next steps

Based on what changed:
- Schema version added: "Your config is now tracked. Future updates will migrate incrementally."
- Validation errors remain: "Fix remaining issues, then run `/prove:update` again."
- Everything passed: "All configs are valid and up to date."
- CLAUDE.md updated: "CLAUDE.md managed section has been refreshed."
