---
description: Send a test notification through configured reporters in .prove.json
argument-hint: "[event-type]"
---

# Notify Test

Run the test script for configured reporters:

```bash
bash "$PLUGIN_DIR/scripts/notify-test.sh" $ARGUMENTS
```

If `$ARGUMENTS` is empty, defaults to `step-complete`.

If `.prove.json` has no `reporters` entries, inform the user and suggest `/prove:notify:notify-setup`. Do not run the script.

Reporter scripts live in `.prove/` (project scope) or `~/.claude/scripts/` (global scope).
