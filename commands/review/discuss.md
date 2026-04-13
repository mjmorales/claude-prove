---
description: Surface review groups needing discussion
---

# Review Discussion

Read the review state and surface groups that need discussion.

`$PLUGIN_DIR` refers to this plugin's root (parent of `commands/`).

## Instructions

1. Get the current branch:
   ```bash
   git rev-parse --abbrev-ref HEAD
   ```

2. Run the discuss prompt generator:
   ```bash
   PYTHONPATH="$PLUGIN_DIR" python3 -m tools.acb discuss --branch <branch>
   ```

3. If no ACB document exists, tell the user to run `/prove:review` first and stop.

4. Present the output and facilitate discussion with the user about the flagged items.
