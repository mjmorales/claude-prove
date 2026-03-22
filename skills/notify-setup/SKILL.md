---
name: notify-setup
description: >
  Configure orchestrator notification reporters (Slack, Discord, MCP, custom).
  Generates bash scripts and updates .prove.json. Triggers on "notify setup",
  "set up notifications", "configure alerts".
---

# Notify Setup

Set up notification reporters so the orchestrator can report progress, failures, and permission needs to external platforms.

**Interaction patterns**: See `references/interaction-patterns.md` for `AskUserQuestion` usage.

## Workflow

### Phase 1: Discovery

Scan for existing integrations before asking the user to configure anything.

1. Read `.claude/settings.json` and `~/.claude/settings.json` for MCP servers with messaging capabilities (Slack MCP, Discord MCP, etc.)
2. Check the environment for `SLACK_WEBHOOK_URL`, `DISCORD_WEBHOOK_URL`
3. Check `.prove.json` for existing reporters
4. Report findings. If an existing reporter covers the user's needs, say so and confirm before proceeding.

### Phase 2: Platform Selection

Use `AskUserQuestion` with header "Platform". When presenting 3 or fewer choices, include a "Research & proceed" option per `references/interaction-patterns.md`:

- "Slack (Webhook)" — posts via `SLACK_WEBHOOK_URL` and curl
- "Discord (Webhook)" — posts via `DISCORD_WEBHOOK_URL` and curl
- "MCP Integration" — reuses a detected MCP server's messaging tool
- "Custom Command" — user-provided notification command

Annotate options with discovery results (e.g., "Slack (Webhook) -- SLACK_WEBHOOK_URL detected").

### Phase 3: Configuration

**Scope** — `AskUserQuestion`, header "Scope":
- "Project" — scripts in `./.prove/`, config in `.prove.json`
- "Global" — scripts in `~/.claude/scripts/`

**Events** — `AskUserQuestion`, header "Events" (multiSelect: true):
- "Step Complete" — orchestrator step finishes successfully
- "Step Halted" — step fails or gets stuck
- "Wave Complete" — parallel wave finishes (full mode only)
- "Execution Complete" — full run finishes
- "Review Approved" — principal architect approves
- "Review Rejected" — principal architect requests changes
- "Validation Pass" — LLM validation passes
- "Validation Fail" — LLM validation fails

**Platform-specific details** (free-form):
- **Slack**: Webhook URL env var name (default `SLACK_WEBHOOK_URL`), channel override, mention preferences
- **Discord**: Webhook URL env var name (default `DISCORD_WEBHOOK_URL`), mention role
- **MCP**: Which MCP server and tool, channel/recipient
- **Custom**: Command to run, any env vars it needs

### Phase 4: Script Generation

Generate a bash notification script tailored to the user's platform and preferences. Do NOT use static templates.

Requirements:
- `#!/usr/bin/env bash`, POSIX-compatible
- Read `PROVE_EVENT`, `PROVE_TASK`, `PROVE_STEP`, `PROVE_STATUS`, `PROVE_BRANCH`, `PROVE_DETAIL` from the environment (see `references/reporter-protocol.md` for full variable documentation)
- Format a human-readable message from those vars
- Support `--test` flag with dummy data
- Handle errors gracefully — never crash the orchestrator (`|| true`, trap)
- Reference env vars for secrets — NEVER embed webhook URLs or tokens

See `references/platforms.md` for platform-specific payload formats, curl patterns, and MCP invocation guidance.

After generation:
1. Write to `./.prove/notify-<platform>.sh` (project) or `~/.claude/scripts/notify-<platform>.sh` (global)
2. `chmod +x` the script

### Phase 5: .prove.json Update

1. Read `.prove.json` (create if missing)
2. Add or update entry in the `reporters` array — preserve all other config:
   ```json
   {
     "name": "<platform>-notify",
     "command": "./.prove/notify-<platform>.sh",
     "events": ["step-complete", "step-halted", "execution-complete"]
   }
   ```
3. Convert event selections to kebab-case slugs for the `events` array (e.g., "Step Complete" becomes `step-complete`)

### Phase 6: Verification

1. Run the script with `--test`
2. Report success or failure
3. Summarize: platform, scope, script path, subscribed events, `.prove.json` entry

## Committing

Delegate to the `commit` skill. Do not create ad-hoc commits.

Example: `feat(notify-setup): add Slack webhook notification script`
