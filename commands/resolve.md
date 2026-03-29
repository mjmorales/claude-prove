---
description: Show review approval summary and merge readiness
---

# Review Resolution

Show the approval summary for the current review.

`$PLUGIN_DIR` refers to this plugin's root (parent of `commands/`).

## Instructions

1. Find the most recent ACB review file:
   ```bash
   ls -t .prove/reviews/*.acb.json 2>/dev/null | head -1
   ```

2. If no review file exists, tell the user to run `/prove:review` first and stop.

3. Run the resolve summary generator:
   ```bash
   PYTHONPATH="$PLUGIN_DIR" python3 -m tools.acb resolve --acb <path>
   ```

4. Present the summary to the user. If approved, suggest next steps (merge, cleanup).
   If not fully approved, suggest `/prove:fix` or `/prove:discuss`.
