---
description: Show review approval summary and merge readiness
---

# Review Resolution

Show the approval summary for the current review.

`$PLUGIN_DIR` refers to this plugin's root (parent of `commands/`).

## Instructions

1. Get the current branch:
   ```bash
   git rev-parse --abbrev-ref HEAD
   ```

2. Run the resolve summary generator:
   ```bash
   PYTHONPATH="$PLUGIN_DIR" python3 -m tools.acb resolve --branch <branch>
   ```

3. If no ACB document exists, tell the user to run `/prove:review` first and stop.

4. Present the summary to the user. If approved, suggest next steps (merge, cleanup).
   If not fully approved, suggest `/prove:review:fix` or `/prove:review:discuss`.
