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

### Step 7: External references for CLAUDE.md

Collect candidate references from two sources: bundled plugin references and user's global CLAUDE.md.

#### Source 1: Bundled references (from the plugin)

Scan `$PLUGIN_DIR/references/` for `.md` files. These ship with the plugin and are available to all projects. Use `$PLUGIN_DIR` as a path variable so the reference resolves to the correct location regardless of where the plugin is installed.

Bundled references found:
```
$PLUGIN_DIR/references/llm-coding-standards.md — LLM Coding Standards
```

#### Source 2: User's global CLAUDE.md

Read `~/.claude/CLAUDE.md` — if the file does not exist, skip this source. Parse for lines starting with `@` — extract the file path after `@`.

For each found reference, derive a label from the filename: strip extension, replace hyphens/underscores with spaces, title-case (e.g., `llm-coding-standards.md` -> "Llm Coding Standards" -> user confirms/edits).

**Deduplication**: if a global reference points to the same filename as a bundled reference, prefer the bundled version (uses `$PLUGIN_DIR` — portable across machines).

#### Present candidates

```
Bundled references (ship with plugin):
  1. $PLUGIN_DIR/references/llm-coding-standards.md — LLM Coding Standards

Global references (from ~/.claude/CLAUDE.md):
  (none after deduplication)

Already configured: (none)
```

`AskUserQuestion` with header "External References" and options: "Include All (Recommended)" / "Select" / "Add Custom" / "Skip".

- **Include All**: add all candidates to `.prove.json` under `claude_md.references`
- **Select**: let user pick which to include
- **Add Custom**: let user type additional paths (then confirm)
- **Skip**: no changes

Write selected references to `.prove.json` under `claude_md.references`. Use `$PLUGIN_DIR` prefix for bundled references, literal paths for user-specified ones:
```json
{
  "claude_md": {
    "references": [
      {"path": "$PLUGIN_DIR/references/llm-coding-standards.md", "label": "LLM Coding Standards"}
    ]
  }
}
```

Merge into existing `.prove.json` — preserve all other sections.

### Step 8: Generate CLAUDE.md

If `CLAUDE.md` exists, `AskUserQuestion` with header "CLAUDE.md" and options: "Regenerate" / "Keep Existing". Skip generation on "Keep Existing".

```bash
python3 "$PLUGIN_DIR/skills/claude-md/__main__.py" generate --project-root "$(pwd)" --plugin-dir "$PLUGIN_DIR"
```

Show summary of generated sections.

### Step 9: Install community skills

```bash
bash "$PLUGIN_DIR/scripts/install-skills.sh" --list
```

`AskUserQuestion` with header "Skills" and options: "Install" / "Skip".

On "Install":
```bash
bash "$PLUGIN_DIR/scripts/install-skills.sh"
```

### Step 10: Summary

Report what was created/updated. Suggest next steps:
- Review and customize validators
- Commit `.prove.json` and `.gitignore`
- Run `/prove:task-planner` or `/prove:orchestrator`
