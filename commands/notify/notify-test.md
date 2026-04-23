---
description: Send a test notification through configured reporters in .claude/.prove.json
argument-hint: "[event-type]"
---

# Notify Test

Run the test pipeline for configured reporters:

```bash
bun run "$PLUGIN_DIR/packages/cli/bin/run.ts" notify test $ARGUMENTS
```

If `$ARGUMENTS` is empty, defaults to `step-complete`.

If `.claude/.prove.json` has no `reporters` entries, inform the user and suggest `/prove:notify:notify-setup`. Do not run the script.

Reporter scripts live in `.prove/` (project scope) or `~/.claude/scripts/` (global scope).
