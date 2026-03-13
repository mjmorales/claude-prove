---
name: init
description: Detect project tech stack and generate .prove.json configuration file
allowed_tools: Bash, Read, Write, Glob

---

# Initialize .prove.json

Detect the current project's tech stack and generate or update a `.prove.json` configuration file.
Operates section-by-section — never overwrites user-configured sections like `reporters`, `scopes`, or `index`.

## Instructions

### Step 1: Detect tech stack

If `.prove.json` already exists, use `--merge` to preserve existing sections:

```bash
# Existing config — merge detected validators, keep everything else
bash "$PLUGIN_DIR/scripts/init-config.sh" --merge "$(pwd)"

# No existing config — generate fresh
bash "$PLUGIN_DIR/scripts/init-config.sh" "$(pwd)"
```

where `$PLUGIN_DIR` is the directory containing this plugin (the parent of `commands/`).

### Step 2: Show existing config context

If `.prove.json` already exists, show the user what sections are currently configured:

```
Existing .prove.json sections:
  - validators: 3 entries (will be updated with detected config)
  - scopes: 6 entries (preserved)
  - reporters: 1 entry (preserved)
  - index: configured (preserved)
```

Only the `validators` section is updated by detection. All other sections are preserved as-is.

### Step 3: Confirm detected validators

Present the detected validators to the user, then use `AskUserQuestion`:
- Header: "Validators"
- Options: "Approve" (write detected validators) / "Modify" (let user request changes first) / "Keep Current" (skip validator update — only shown when `.prove.json` already has validators)

### Step 4: Write configuration

Write the approved configuration to `.prove.json` in the project root.

- If merging: the output from `init-config.sh --merge` already contains all existing sections with updated validators
- If fresh: write the detection output directly

### Step 5: Update .gitignore

If `.prove/` is not already in `.gitignore`, add it:

```bash
grep -qxF '.prove/' .gitignore 2>/dev/null || echo '.prove/' >> .gitignore
```

### Step 6: Set up plugin tools

List available tools:
```bash
bash "$PLUGIN_DIR/scripts/setup-tools.sh" --list --project-root "$(pwd)" --plugin-dir "$PLUGIN_DIR"
```

If any tools are "not configured", use `AskUserQuestion` with header "Tools" and options: "Setup" (configure hooks and .prove.json for detected tools) / "Skip" (skip for now).

On "Setup", run:
```bash
bash "$PLUGIN_DIR/scripts/setup-tools.sh" --project-root "$(pwd)" --plugin-dir "$PLUGIN_DIR"
```

This adds tool config sections to `.prove.json` without touching existing sections.

### Step 7: Generate CLAUDE.md

```bash
python3 "$PLUGIN_DIR/skills/claude-md/__main__.py" generate --project-root "$(pwd)" --plugin-dir "$PLUGIN_DIR"
```

Show the user a summary of what was generated (section count, file path).

If `CLAUDE.md` already exists, use `AskUserQuestion` with header "CLAUDE.md" and options: "Regenerate" (overwrite with freshly scanned content) / "Keep Existing" (skip CLAUDE.md generation).

### Step 8: Install community skills

```bash
bash "$PLUGIN_DIR/scripts/install-skills.sh" --list
```

Use `AskUserQuestion` with header "Skills" and options: "Install" (install recommended skills to ~/.claude/skills/) / "Skip" (skip for now, can run `/prove:install-skills` later).

On "Install", run:
```bash
bash "$PLUGIN_DIR/scripts/install-skills.sh"
```

### Step 9: Summary

Confirm what was created or updated and suggest next steps:
- Review and customize the generated validators
- Commit `.prove.json` and `.gitignore` to version control
- Run `/prove:task-planner` or `/prove:orchestrator` to use it
