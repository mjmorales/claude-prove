---
name: update
description: Validate configs, detect schema drift, and apply safe migrations
allowed_tools: Bash, Read, Write, Edit, AskUserQuestion

---

# Update Configuration

Validate `.prove.json` and `.claude/settings.json` against the current schema, detect drift, and apply safe migrations with user approval.

## Instructions

### Step 1: Run validation and diff

Run the schema tools to assess current config state:

```bash
python3 -m tools.schema summary
```

Present the output to the user. This shows:
- Validation errors/warnings for both config files
- Migration changes needed (if any)
- Target config after migration

### Step 2: Assess migration need

If no migration is needed and no validation errors exist, inform the user:
> Your configs are up to date and valid. Nothing to do.

If there are changes, continue to Step 3.

### Step 3: Present migration plan

Run the migration planner in dry-run mode:

```bash
python3 -m tools.schema migrate --dry-run
```

Present the changes to the user, then use `AskUserQuestion`:
- Header: "Migration"
- Options:
  - "Apply All" (apply all changes with backup)
  - "Review Each" (walk through changes one at a time)
  - "Skip" (don't modify configs — I'll handle it manually)

### Step 4: Apply migration

If the user chose "Apply All":

```bash
python3 -m tools.schema migrate
```

This creates a `.prove.json.<timestamp>.bak` backup and applies the migration.

If the user chose "Review Each":
- Present each change individually
- For each change, use `AskUserQuestion` with header "Change" and options: "Apply" / "Skip"
- Apply only approved changes

### Step 5: Validate settings.json

Check `.claude/settings.json` separately:

```bash
python3 -m tools.schema validate --file .claude/settings.json
```

If there are issues, present them and offer to fix:
- Missing hook configurations (compared to what prove expects)
- Structural issues in existing hooks

### Step 6: Re-validate

After applying changes, run validation again to confirm:

```bash
python3 -m tools.schema validate
```

Present the final status:
- PASS/FAIL for each config file
- Schema version (current)
- Backup file location (if migration was applied)

### Step 7: Update CLAUDE.md

Regenerate the managed section of CLAUDE.md:

```bash
python3 skills/claude-md/__main__.py generate
```

This only replaces the `<!-- prove:managed:start -->` / `<!-- prove:managed:end -->` block. Any user content outside the markers is preserved.

If this is the first run (no markers exist), the full file is written with the markers in place.

Present the result to the user showing what sections were generated.

### Step 8: Suggest next steps

Based on what changed:
- If `schema_version` was added: "Your config is now tracked. Future updates will migrate incrementally."
- If validation errors remain: "Fix the remaining issues manually, then run `/prove:update` again."
- If everything passed: "All configs are valid and up to date."
- If CLAUDE.md was updated: "CLAUDE.md managed section has been refreshed. Your custom sections are preserved."
