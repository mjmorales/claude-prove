---
description: Resume work from a handoff prompt (.prove/handoff.md) created by /prove:handoff
---

# Pickup Handoff

## Step 1: Locate

Read `.prove/handoff.md`. If missing, tell the user to run `/prove:handoff` first, then stop.

## Step 2: Load Context

1. Read the handoff file completely
2. Read each file listed in "Files to Read First" in order
3. Read referenced prove artifacts: `scripts/prove-run show state` / `show plan` / `show prd` for the active run, plus decision records

## Step 3: Confirm and Clean Up

Tell the user: what you picked up, what you will work on, which branch you are on.

Delete the handoff file:
```bash
rm .prove/handoff.md
```

## Step 4: Begin Work

Follow the "Instructions" section from the handoff file. Start immediately — do not ask the user to repeat the task.

## Rules

- Load all referenced files before making changes
- Delete the handoff file after loading — it is ephemeral
- The handoff file tells you what to do — do not ask the user to repeat it
- If the handoff recommends a specific agent, inform the user: "This handoff targets the `<agent>` agent. Consider: `claude --agent agents/<name>.md --prompt-file .prove/handoff.md`"
