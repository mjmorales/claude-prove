---
description: Detect project tech stack and generate .prove.json configuration
---

# Initialize .prove.json

Detect the project tech stack and generate or update `.prove.json`. Operates section-by-section — never overwrites `reporters`, `scopes`, or `index`.

`$PLUGIN_DIR` refers to this plugin's root (parent of `commands/`).

## Instructions

### Step 1: Detect tech stack

```bash
# If .prove.json exists — merge detected validators, preserve everything else
bash "$PLUGIN_DIR/scripts/init-config.sh" --merge "$(pwd)"

# If no .prove.json — generate fresh
bash "$PLUGIN_DIR/scripts/init-config.sh" "$(pwd)"
```

### Step 2: Show existing config context

If `.prove.json` exists, summarize current sections:

```
Existing .prove.json sections:
  - validators: 3 entries (updated with detected config)
  - scopes: 6 entries (preserved)
  - reporters: 1 entry (preserved)
  - index: configured (preserved)
```

Only `validators` is updated. All other sections are preserved.

### Step 3: Confirm detected validators

Present detected validators, then `AskUserQuestion`:
- Header: "Validators"
- Options: "Approve" / "Modify" / "Keep Current" (only when existing validators present)

### Step 4: Write configuration

Write approved config to `.prove.json`.

- Merge mode: output from `--merge` already contains all sections with updated validators
- Fresh mode: write detection output directly
- Run `python3 -m tools.schema migrate` after writing to ensure `schema_version` is set

### Step 5: Update .gitignore

```bash
grep -qxF '.prove/' .gitignore 2>/dev/null || echo '.prove/' >> .gitignore
```

### Step 6: Set up plugin tools

```bash
bash "$PLUGIN_DIR/scripts/setup-tools.sh" --list --project-root "$(pwd)" --plugin-dir "$PLUGIN_DIR"
```

If any tools are "not configured", `AskUserQuestion` with header "Tools" and options: "Setup" / "Skip".

On "Setup":
```bash
bash "$PLUGIN_DIR/scripts/setup-tools.sh" --project-root "$(pwd)" --plugin-dir "$PLUGIN_DIR"
```

### Step 7: Generate CLAUDE.md

If `CLAUDE.md` exists, `AskUserQuestion` with header "CLAUDE.md" and options: "Regenerate" / "Keep Existing". Skip generation on "Keep Existing".

```bash
python3 "$PLUGIN_DIR/skills/claude-md/__main__.py" generate --project-root "$(pwd)" --plugin-dir "$PLUGIN_DIR"
```

Show summary of generated sections.

### Step 8: Install community skills

```bash
bash "$PLUGIN_DIR/scripts/install-skills.sh" --list
```

`AskUserQuestion` with header "Skills" and options: "Install" / "Skip".

On "Install":
```bash
bash "$PLUGIN_DIR/scripts/install-skills.sh"
```

### Step 9: Summary

Report what was created/updated. Suggest next steps:
- Review and customize validators
- Commit `.prove.json` and `.gitignore`
- Run `/prove:task-planner` or `/prove:orchestrator`
