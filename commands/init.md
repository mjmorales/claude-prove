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

2. If `.prove.json` already exists, show its contents and ask the user if they want to overwrite.

3. Present the detected configuration to the user for review before writing.

4. Write the approved configuration to `.prove.json` in the project root.

5. If `.prove/` is not already in `.gitignore`, add it:
   ```bash
   grep -qxF '.prove/' .gitignore 2>/dev/null || echo '.prove/' >> .gitignore
   ```

6. Confirm creation and suggest next steps:
   - Review and customize the generated validators
   - Commit `.prove.json` and `.gitignore` to version control
   - Run `/prove:task-planner` or `/prove:orchestrator` to use it
