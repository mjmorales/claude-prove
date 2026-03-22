---
description: Install recommended community skills from external repos into ~/.claude/skills/
---

# Install Recommended Skills

1. Show available skills and install status:
   ```bash
   bash "$PLUGIN_DIR/scripts/install-skills.sh" --list
   ```

2. Use `AskUserQuestion` to confirm — header: "Install", options: "Install All" / "Skip"

3. On approval, run:
   ```bash
   bash "$PLUGIN_DIR/scripts/install-skills.sh"
   ```

4. Tell the user to restart Claude Code for new skills to take effect.
