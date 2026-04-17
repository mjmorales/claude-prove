---
name: prep-permissions
description: >
  Analyze the active task plan and .claude/.prove.json to configure .claude/settings.local.json
  with scoped permission rules. Use before orchestrator, autopilot, or implementation.
  Triggers on "prep permissions", "setup permissions", "configure permissions",
  "allow tools", "stop asking me".
---

# Prep Permissions

Configure `.claude/settings.local.json` with scoped tool permissions for the active task.

## Phase 1: Gather Context

Read these files (skip missing ones):

1. Active run's `plan.json` under `.prove/runs/<branch>/<slug>/` — task/step list, deps. Use:
   `python3 -m tools.run_state show --kind plan --format json`
2. `.prove/plans/plan_*/05_implementation_plan.md` — file paths, commands
3. `.claude/.prove.json` — validator and reporter commands
4. `.claude/settings.local.json` — existing rules to preserve
5. Project root — check for `go.mod`, `package.json`, `Cargo.toml`, `pyproject.toml`, `Makefile`, `project.godot`

## Phase 2: Build Permission Rules

Generate `permissions.allow` rules with the most specific patterns possible.

### Baseline

```
Bash(git *)
Bash(mkdir *)
Edit
Write
```

### From .claude/.prove.json

Each validator/reporter command becomes a Bash rule:
- `"command": "go build ./..."` -> `Bash(go build *)`
- `"command": "./.prove/notify.sh"` -> `Bash(./.prove/notify.sh *)`

### From auto-detected toolchain (when no .prove.json)

| Indicator | Rules |
|-----------|-------|
| `go.mod` | `Bash(go build *)`, `Bash(go test *)`, `Bash(go vet *)`, `Bash(go mod *)`, `Bash(go run *)` |
| `package.json` | `Bash(npm *)`, `Bash(npx *)` |
| `Cargo.toml` | `Bash(cargo *)` |
| `pyproject.toml` | `Bash(python *)`, `Bash(pip *)`, `Bash(pytest *)`, `Bash(mypy *)`, `Bash(ruff *)` |
| `Makefile` | `Bash(make *)` |
| `project.godot` | `Bash(godot *)` |

### From task plan

Scan for mentioned tools:
- Database migrations -> `Bash(migrate *)`, `Bash(goose *)`, etc.
- Docker -> `Bash(docker *)`, `Bash(docker-compose *)`
- Scripts -> `Bash(bash scripts/*)`, `Bash(./scripts/*)`

### Orchestrator/full-auto mode

- `Bash(bash $PLUGIN_DIR/scripts/*)` — prove helper scripts
- `Agent(principal-architect)`, `Agent(general-purpose)`, `Agent(Explore)`, `Agent(Plan)`

### Require user approval (do not add to allow)

- `Bash(rm *)`, `Bash(git push *)`, `Bash(git reset *)` — destructive ops
- `Bash(curl *)`, `Bash(wget *)` — network calls
- `Bash(sudo *)` — elevated privileges
- Anything touching `.env`, credentials, or secrets

## Phase 3: Confirm with User

Present rules grouped by category (git, build/test, file ops, orchestrator, still-requires-approval). Use AskUserQuestion with header "Permissions": "Approve" / "Modify".

## Phase 4: Write Configuration

1. Read existing `.claude/settings.local.json` if present
2. Merge new `permissions.allow` with existing rules (deduplicate)
3. Preserve existing `permissions.deny` or `permissions.ask` rules
4. Write the file (create `.claude/` if needed). Only modify `settings.local.json`, not the shared `settings.json`.
5. Remind the user to restart Claude Code and confirm `.claude/settings.local.json` is in `.gitignore`
