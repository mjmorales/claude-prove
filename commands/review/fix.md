---
description: Generate fix prompts from rejected review groups
---

# Fix Rejected Review Groups

Read the review state and generate fix instructions for rejected intent groups.

`$PLUGIN_DIR` refers to this plugin's root (parent of `commands/`).

## Instructions

1. Get the current branch:
   ```bash
   git rev-parse --abbrev-ref HEAD
   ```

2. Run the fix prompt generator:
   ```bash
   PYTHONPATH="$PLUGIN_DIR" python3 -m tools.acb fix --branch <branch>
   ```

3. If no ACB document exists, tell the user to run `/prove:review` first and stop.

4. Present the output to the user. The prompt describes:
   - Rejected groups with reviewer comments
   - Groups needing discussion
   - Pending groups
   - Accepted groups (do not modify)
   - Unanswered open questions

5. Ask the user if they want you to start fixing the rejected groups.
