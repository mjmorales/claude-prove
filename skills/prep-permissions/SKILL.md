---
name: prep-permissions
description: >
  Analyze the active task plan and .prove.json validators to recommend and configure
  Claude Code permissions for the upcoming work. Writes .claude/settings.local.json
  with appropriate allow rules so users don't need --dangerously-skip-permissions
  or constant approval prompts. Use before running the orchestrator, autopilot, or
  any implementation phase. Triggers on "prep permissions", "setup permissions",
  "configure permissions", "allow tools", "stop asking me".
---

# Prep Permissions

Analyze the active task and configure `.claude/settings.local.json` with the right tool permissions so the user can work without constant approval prompts or `--dangerously-skip-permissions`.

## Phase 1: Gather Context

Read the following (skip any that don't exist):

1. **Task plan**: `.prove/TASK_PLAN.md` — extract implementation steps, languages, tools mentioned
2. **Detailed plans**: `.prove/plans/plan_*/05_implementation_plan.md` — file paths, commands referenced
3. **Validation config**: `.prove.json` — extract all validator and reporter commands
4. **Existing settings**: `.claude/settings.local.json` — preserve any existing rules
5. **Project indicators**: Check for `go.mod`, `package.json`, `Cargo.toml`, `pyproject.toml`, `Makefile`, `project.godot` to infer toolchain commands

## Phase 2: Build Permission Rules

Generate `permissions.allow` rules based on what the task requires. Use the **most specific patterns possible** — never allow broad patterns when narrow ones suffice.

### Rule Categories

**Always include (baseline for prove workflows):**
- `Bash(git checkout *)` — branch operations
- `Bash(git branch *)` — branch creation
- `Bash(git add *)` — staging
- `Bash(git commit *)` — committing
- `Bash(git merge *)` — merging (orchestrator needs this)
- `Bash(git diff *)` — diffing
- `Bash(git log *)` — history
- `Bash(git status)` — status checks
- `Bash(git stash *)` — stash operations
- `Bash(mkdir *)` — directory creation (plans, reports, etc.)
- `Bash(ls *)` — directory listing
- `Bash(cat *)` — file reading in scripts
- `Edit` — file modifications
- `Write` — file creation

**From .prove.json validators** — add each command as a Bash rule:
- e.g., `"command": "go build ./..."` → `Bash(go build *)`
- e.g., `"command": "npm test"` → `Bash(npm test *)`
- e.g., `"command": "cargo clippy"` → `Bash(cargo clippy *)`

**From .prove.json reporters** — add each reporter command:
- e.g., `"command": "./.prove/notify.sh"` → `Bash(./.prove/notify.sh *)`

**From auto-detected toolchain** (when no .prove.json):

| Indicator | Rules to add |
|-----------|-------------|
| `go.mod` | `Bash(go build *)`, `Bash(go test *)`, `Bash(go vet *)`, `Bash(go mod *)`, `Bash(go run *)` |
| `package.json` | `Bash(npm *)`, `Bash(npx *)` |
| `Cargo.toml` | `Bash(cargo *)` |
| `pyproject.toml` | `Bash(python *)`, `Bash(pip *)`, `Bash(pytest *)`, `Bash(mypy *)`, `Bash(ruff *)` |
| `Makefile` | `Bash(make *)` |
| `project.godot` | `Bash(godot *)` |

**From task plan analysis** — scan for mentioned tools/commands:
- Database migrations → `Bash(migrate *)`, `Bash(goose *)`, etc.
- Docker usage → `Bash(docker *)`, `Bash(docker-compose *)`
- Script references → `Bash(bash scripts/*)`, `Bash(./scripts/*)`
- Any other CLI tools referenced in the plan

**For orchestrator/full-auto mode** — also add:
- `Bash(bash $PLUGIN_DIR/scripts/*)` — prove helper scripts
- `Agent(principal-architect)` — architect review agent
- `Agent(general-purpose)` — worktree implementation agents
- `Agent(Explore)` — codebase exploration
- `Agent(Plan)` — planning agents

### Rules to NEVER add
- `Bash(rm *)` — deletion should always prompt
- `Bash(git push *)` — pushing should always prompt
- `Bash(git reset *)` — destructive git ops should prompt
- `Bash(curl *)` / `Bash(wget *)` — network calls should prompt
- `Bash(sudo *)` — elevated privileges should always prompt
- Anything that touches `.env`, credentials, or secrets

## Phase 3: Present Recommendations

Show the user what you plan to configure, organized by category:

```
## Recommended Permissions for: <task name>

### Git Operations
- Bash(git checkout *) — branch switching
- Bash(git commit *) — committing changes
  ...

### Build & Test (from .prove.json)
- Bash(go build *) — build validation
- Bash(go test *) — test validation
  ...

### File Operations
- Edit — modify existing files
- Write — create new files
  ...

### Orchestrator (if applicable)
- Agent(principal-architect) — code review
  ...

### Still Requires Approval
- git push (explicit user action)
- rm/delete operations
- Network requests
```

Use AskUserQuestion with header "Permissions" and options: "Approve" (write the configuration as shown) / "Modify" (I want to add or remove rules before writing).

## Phase 4: Write Configuration

1. Read existing `.claude/settings.local.json` if present
2. Merge new `permissions.allow` rules with any existing ones (deduplicate)
3. Preserve any existing `permissions.deny` or `permissions.ask` rules
4. Write the updated file:

```json
{
  "permissions": {
    "allow": [
      "Bash(git checkout *)",
      "Bash(git commit *)",
      "..."
    ]
  }
}
```

If `.claude/settings.local.json` doesn't exist, create it with just the permissions block.

If `.claude/` directory doesn't exist, create it first.

## Phase 5: Next Steps

After writing, tell the user:

1. **Restart Claude Code** for the new permissions to take effect
   - Exit with `/exit` or Ctrl+C
   - Relaunch `claude` in the same directory
2. Suggest the next prove workflow step (e.g., `/prove:autopilot`, `/prove:orchestrator`)
3. Remind them that dangerous operations (push, delete, network) still require approval
4. Note that `.claude/settings.local.json` is meant for personal use — add it to `.gitignore` if not already ignored

## Safety Rules

- **Never add overly broad rules** — prefer `Bash(go test *)` over `Bash(*)`
- **Never add deny-worthy tools to allow** — push, delete, sudo, network always prompt
- **Preserve existing settings** — merge, don't overwrite
- **Always confirm with user** before writing — use AskUserQuestion with "Approve" / "Modify" options
- **settings.local.json only** — never modify `.claude/settings.json` (shared team settings)

**Interaction patterns**: See `references/interaction-patterns.md` for when to use `AskUserQuestion` vs free-form discussion.
