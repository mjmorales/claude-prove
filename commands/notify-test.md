---
description: Send a test notification through configured reporters
argument-hint: "[event-type]"
---

# Notify Test

Send a test notification through the reporter pipeline configured in `.prove.json`.

## Input

$ARGUMENTS

## Instructions

1. Read `.prove.json` from the project root
2. Check if `reporters` array exists and has entries
3. If no reporters configured, inform the user and suggest running `/prove:notify-setup`
4. For each configured reporter:
   - Set the reporter environment variables with test values
   - Run the reporter's command
   - Report success or failure
5. If `$ARGUMENTS` specifies an event type (e.g., "step-complete"), only test that event
6. Otherwise, test with a "step-complete" event by default

Use the test script at `scripts/notify-test.sh` to execute the test:
```bash
bash "$PLUGIN_DIR/scripts/notify-test.sh" [event-type]
```
