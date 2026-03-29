---
description: Detect project tech stack and generate .claude/.prove.json configuration
---

# Initialize .claude/.prove.json

Detect tech stack, generate or update `.claude/.prove.json`. Operates section-by-section — only `validators` is updated; `reporters`, `scopes`, and `index` are preserved.

## Step 0: Guard

1. Verify `$PLUGIN_DIR` is set. If not, error: "Cannot resolve plugin directory."
2. Verify `$(pwd)` is NOT inside `~/.claude/`. If it is, error: "You are inside the plugin directory. Run this command from your project root."

Stop on any failure.

## Step 1: Detect tech stack

```bash
# Existing config — merge detected validators, preserve everything else
bash "$PLUGIN_DIR/scripts/init-config.sh" --merge "$(pwd)"

# No config — generate fresh
bash "$PLUGIN_DIR/scripts/init-config.sh" "$(pwd)"
```

## Step 2: Show existing config context

If `.claude/.prove.json` exists, summarize current sections:

```
Existing .claude/.prove.json sections:
  - validators: 3 entries (updated with detected config)
  - scopes: 6 entries (preserved)
  - reporters: 1 entry (preserved)
  - index: configured (preserved)
```

## Step 3: Confirm detected validators

Present detected validators, then `AskUserQuestion` (header: "Validators"):
- "Approve" / "Modify" / "Keep Current" (last option only when existing validators present)

## Step 4: Write configuration

Write approved config to `.claude/.prove.json`.

- Merge mode: output from `--merge` already contains all sections with updated validators
- Fresh mode: write detection output directly
- Run `PYTHONPATH="$PLUGIN_DIR" python3 -m tools.schema migrate --file "$(pwd)/.claude/.prove.json"` after writing to ensure `schema_version` is set

## Step 5: Update .gitignore

```bash
grep -qxF '.prove/' .gitignore 2>/dev/null || echo '.prove/' >> .gitignore
```

## Step 6: Set up plugin tools

```bash
bash "$PLUGIN_DIR/scripts/setup-tools.sh" --list --project-root "$(pwd)" --plugin-dir "$PLUGIN_DIR"
```

If any tools are "not configured", `AskUserQuestion` (header: "Tools"): "Setup" / "Skip".

On "Setup":
```bash
bash "$PLUGIN_DIR/scripts/setup-tools.sh" --project-root "$(pwd)" --plugin-dir "$PLUGIN_DIR"
```

## Step 7: External references for CLAUDE.md

Collect candidate references from two sources.

#### Source 1: Bundled references

Scan `$PLUGIN_DIR/references/` for `.md` files. Use `$PLUGIN_DIR` as path variable so references resolve regardless of install location.

#### Source 2: User's global CLAUDE.md

Read `~/.claude/CLAUDE.md` (skip if missing). Parse lines starting with `@` — extract the file path. Derive labels from filenames: strip extension, replace hyphens/underscores with spaces, title-case.

**Deduplication**: if a global reference matches a bundled filename, prefer the bundled version (`$PLUGIN_DIR` path is portable).

#### Present candidates

```
Bundled references (ship with plugin):
  1. $PLUGIN_DIR/references/llm-coding-standards.md — LLM Coding Standards

Global references (from ~/.claude/CLAUDE.md):
  (none after deduplication)

Already configured: (none)
```

`AskUserQuestion` (header: "External References"): "Include All (Recommended)" / "Select" / "Add Custom" / "Skip".

- **Include All**: add all candidates to `claude_md.references`
- **Select**: user picks which to include
- **Add Custom**: user types additional paths, then confirm
- **Skip**: no changes

Write to `.claude/.prove.json` under `claude_md.references`. Use `$PLUGIN_DIR` prefix for bundled, literal paths for user-specified:
```json
{
  "claude_md": {
    "references": [
      {"path": "$PLUGIN_DIR/references/llm-coding-standards.md", "label": "LLM Coding Standards"}
    ]
  }
}
```

Merge into existing config — preserve all other sections.

## Step 8: Generate CLAUDE.md

If `CLAUDE.md` exists, `AskUserQuestion` (header: "CLAUDE.md"): "Regenerate" / "Keep Existing". Skip generation on "Keep Existing".

```bash
python3 "$PLUGIN_DIR/skills/claude-md/__main__.py" generate --project-root "$(pwd)" --plugin-dir "$PLUGIN_DIR"
```

Show summary of generated sections.

## Step 9: Install community skills

```bash
bash "$PLUGIN_DIR/scripts/install-skills.sh" --list
```

`AskUserQuestion` (header: "Skills"): "Install" / "Skip".

On "Install":
```bash
bash "$PLUGIN_DIR/scripts/install-skills.sh"
```

## Step 10: Summary

Report what was created/updated. Suggest next steps:
- Review and customize validators
- Commit `.claude/.prove.json` and `.gitignore`
- Run `/prove:task-planner` or `/prove:orchestrator`
