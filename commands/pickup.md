---
description: Resume work from a handoff prompt file (.prove/handoff.md). Run this in a fresh session after /prove:handoff.
argument-hint: ""
---

# Pickup Handoff

Resume work from a prior session's handoff context.

## Step 1: Locate Handoff

Check if `.prove/handoff.md` exists in the project root.

- **If it exists**: Read it in full. This is your context — it tells you what to do, what files to read, and where to resume.
- **If it does not exist**: Inform the user: "No handoff file found at `.prove/handoff.md`. Run `/prove:handoff` in your previous session first to create one."  Then stop.

## Step 2: Load Context

1. Read `.prove/handoff.md` completely
2. Follow the **"Files to Read First"** section — read each listed file in order
3. Read any prove artifacts referenced (TASK_PLAN.md, decision records, etc.)

## Step 3: Confirm & Clean Up

Tell the user:
- What you picked up (brief summary of the pickup note)
- What you're about to work on
- The branch you're on

Then delete the handoff file:
```bash
rm .prove/handoff.md
```

## Step 4: Begin Work

Follow the **"Instructions"** section from the handoff file. Start working on whatever the pickup note describes — do not ask the user to repeat what needs to be done.

## Rules

- **Read everything before acting** — load all referenced files before making any changes
- **Delete the handoff file after loading** — it's ephemeral, a relay baton
- **Don't ask the user what to do** — the handoff file already tells you
- **If the handoff recommends a specific agent**, inform the user: "This handoff was written for the `<agent>` agent. Consider restarting with: `claude --agent agents/<name>.md --prompt-file .prove/handoff.md`"
