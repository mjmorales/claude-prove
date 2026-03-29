---
description: Surface review groups needing discussion
---

# Review Discussion

Read the review state and surface groups that need discussion.

`$PLUGIN_DIR` refers to this plugin's root (parent of `commands/`).

## Instructions

1. Find the most recent ACB review file:
   ```bash
   ls -t .prove/reviews/*.acb.json 2>/dev/null | head -1
   ```

2. If no review file exists, tell the user to run `/prove:review` first and stop.

3. Run the discuss prompt generator:
   ```bash
   PYTHONPATH="$PLUGIN_DIR" python3 -m tools.acb discuss --acb <path>
   ```

4. Present the output and facilitate discussion with the user about the flagged items.
