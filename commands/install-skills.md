---
name: install-skills
description: Install recommended community skills (skill-creator, mcp-builder) from external repos
allowed_tools: Bash, Read, AskUserQuestion
---

# Install Recommended Skills

Install recommended skills from external repositories into `~/.claude/skills/`.

## Instructions

1. Run the list command to show available skills and their install status:
   ```bash
   bash "$PLUGIN_DIR/scripts/install-skills.sh" --list
   ```

2. Present the list and use `AskUserQuestion` to confirm:
   - Header: "Install"
   - Options: "Install All" (install/update all recommended skills) / "Skip" (don't install any skills)

3. On approval, run the install:
   ```bash
   bash "$PLUGIN_DIR/scripts/install-skills.sh"
   ```

4. Tell the user to restart Claude Code for the new skills to take effect.
