---
name: init
description: Detect project tech stack and generate .prove.json configuration file
allowed_tools: Bash, Read, Write, Glob

---

# Initialize .prove.json

Detect the current project's tech stack and generate a `.prove.json` configuration file.

## Instructions

1. Run the detection script from the plugin's scripts directory:
   ```bash
   bash "$PLUGIN_DIR/scripts/init-config.sh" "$(pwd)"
   ```
   where `$PLUGIN_DIR` is the directory containing this plugin (the parent of `commands/`).

2. If `.prove.json` already exists, show its contents and use `AskUserQuestion` to ask:
   - Header: "Overwrite"
   - Options: "Overwrite" (replace with new detected config) / "Keep Existing" (abort and keep current config)

3. Present the detected configuration to the user, then use `AskUserQuestion` to confirm:
   - Header: "Config"
   - Options: "Approve" (write to .prove.json) / "Modify" (let user request changes first)

4. Write the approved configuration to `.prove.json` in the project root.

5. If `.prove/` is not already in `.gitignore`, add it:
   ```bash
   grep -qxF '.prove/' .gitignore 2>/dev/null || echo '.prove/' >> .gitignore
   ```

6. Confirm creation and suggest next steps:
   - Review and customize the generated validators
   - Commit `.prove.json` and `.gitignore` to version control
   - Run `/prove:task-planner` or `/prove:orchestrator` to use it

7. Set up plugin tools (e.g., CAFI file index). List available tools:
   ```bash
   bash "$PLUGIN_DIR/scripts/setup-tools.sh" --list --project-root "$(pwd)" --plugin-dir "$PLUGIN_DIR"
   ```
   If any tools are "not configured", use `AskUserQuestion` with header "Tools" and options: "Setup" (configure hooks and .prove.json for detected tools) / "Skip" (skip for now).
   On "Setup", run:
   ```bash
   bash "$PLUGIN_DIR/scripts/setup-tools.sh" --project-root "$(pwd)" --plugin-dir "$PLUGIN_DIR"
   ```
   This adds tool config sections to `.prove.json`.

8. Generate CLAUDE.md for the project:
   ```bash
   python3 "$PLUGIN_DIR/skills/claude-md/__main__.py" generate --project-root "$(pwd)" --plugin-dir "$PLUGIN_DIR"
   ```
   Show the user a summary of what was generated (section count, file path).
   If `CLAUDE.md` already exists, use `AskUserQuestion` with header "CLAUDE.md" and options: "Regenerate" (overwrite with freshly scanned content) / "Keep Existing" (skip CLAUDE.md generation).

9. Offer to install recommended community skills:
   ```bash
   bash "$PLUGIN_DIR/scripts/install-skills.sh" --list
   ```
   Use `AskUserQuestion` with header "Skills" and options: "Install" (install recommended skills to ~/.claude/skills/) / "Skip" (skip for now, can run `/prove:install-skills` later).
   On "Install", run:
   ```bash
   bash "$PLUGIN_DIR/scripts/install-skills.sh"
   ```
