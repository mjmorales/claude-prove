---
description: Validate configs, detect schema drift, and apply safe migrations
---

# Update Configuration

Validate `.prove.json` and `.claude/settings.json` against current schema, detect drift, and apply migrations with user approval.

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

### Step 5: Validate settings.json

```bash
python3 -m tools.schema validate --file .claude/settings.json
```

If issues found, present and offer to fix (missing hooks, structural problems).

### Step 6: Re-validate

```bash
python3 -m tools.schema validate
```

Report: PASS/FAIL per config file, schema version, backup location (if applicable).

### Step 7: Update CLAUDE.md

```bash
python3 skills/claude-md/__main__.py generate
```

Replaces only the `<!-- prove:managed:start -->` / `<!-- prove:managed:end -->` block. Content outside markers is preserved. On first run, writes the full file with markers.

Show generated sections summary.

### Step 8: Next steps

- Schema version added: "Config is now tracked. Future updates migrate incrementally."
- Errors remain: "Fix remaining issues, then run `/prove:update` again."
- All passed: "All configs valid and up to date."
- CLAUDE.md updated: "Managed section refreshed. Custom sections preserved."
