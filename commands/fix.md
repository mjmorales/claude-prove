---
description: Generate fix prompts from rejected review groups
---

# Fix Rejected Review Groups

Read the review state and generate fix instructions for rejected intent groups.

`$PLUGIN_DIR` refers to this plugin's root (parent of `commands/`).

## Instructions

1. Find the most recent ACB review file:
   ```bash
   ls -t .prove/reviews/*.acb.json 2>/dev/null | head -1
   ```

2. If no review file exists, tell the user to run `/prove:review` first and stop.

3. Run the fix prompt generator:
   ```bash
   PYTHONPATH="$PLUGIN_DIR" python3 -m tools.acb fix --acb <path>
   ```

4. Present the output to the user. The prompt describes:
   - Rejected groups with reviewer comments
   - Groups needing discussion
   - Pending groups
   - Accepted groups (do not modify)
   - Unanswered open questions

5. Ask the user if they want you to start fixing the rejected groups.
