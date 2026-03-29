---
name: prep-permissions
description: >
  Analyze the active task plan and .claude/.prove.json to configure .claude/settings.local.json
  with scoped permission rules. Use before orchestrator, autopilot, or implementation.
  Triggers on "prep permissions", "setup permissions", "configure permissions",
  "allow tools", "stop asking me".
---

# Prep Permissions

Configure `.claude/settings.local.json` with scoped tool permissions so the user can work without constant approval prompts or `--dangerously-skip-permissions`.

## Phase 1: Gather Context

Read these files (skip missing ones):

1. `.prove/TASK_PLAN.md` — extract implementation steps, languages, tools
2. `.prove/plans/plan_*/05_implementation_plan.md` — file paths, commands
3. `.claude/.prove.json` — validator and reporter commands
4. `.claude/settings.local.json` — preserve existing rules
5. Project root — check for `go.mod`, `package.json`, `Cargo.toml`, `pyproject.toml`, `Makefile`, `project.godot`

## Phase 2: Build Permission Rules

Generate `permissions.allow` rules. Use the **most specific patterns possible**.

### Baseline (always include)

```
Bash(git *)
Bash(mkdir *)
Edit
Write
```

### From .claude/.prove.json

Add each validator/reporter command as a Bash rule:
- `"command": "go build ./..."` -> `Bash(go build *)`
- `"command": "./.prove/notify.sh"` -> `Bash(./.prove/notify.sh *)`

### From auto-detected toolchain (when no .claude/.prove.json)

| Indicator | Rules to add |
|-----------|-------------|
| `go.mod` | `Bash(go build *)`, `Bash(go test *)`, `Bash(go vet *)`, `Bash(go mod *)`, `Bash(go run *)` |
| `package.json` | `Bash(npm *)`, `Bash(npx *)` |
| `Cargo.toml` | `Bash(cargo *)` |
| `pyproject.toml` | `Bash(python *)`, `Bash(pip *)`, `Bash(pytest *)`, `Bash(mypy *)`, `Bash(ruff *)` |
| `Makefile` | `Bash(make *)` |
| `project.godot` | `Bash(godot *)` |

### From task plan

Scan for mentioned tools and add specific rules:
- Database migrations -> `Bash(migrate *)`, `Bash(goose *)`, etc.
- Docker usage -> `Bash(docker *)`, `Bash(docker-compose *)`
- Script references -> `Bash(bash scripts/*)`, `Bash(./scripts/*)`

### Orchestrator/full-auto mode (additional)

- `Bash(bash $PLUGIN_DIR/scripts/*)` — prove helper scripts
- `Agent(principal-architect)`, `Agent(general-purpose)`, `Agent(Explore)`, `Agent(Plan)`

### Never allow

These must always require user approval:
- `Bash(rm *)`, `Bash(git push *)`, `Bash(git reset *)` — destructive operations
- `Bash(curl *)`, `Bash(wget *)` — network calls
- `Bash(sudo *)` — elevated privileges
- Anything touching `.env`, credentials, or secrets

## Phase 3: Confirm with User

Present rules grouped by category (git, build/test, file ops, orchestrator, still-requires-approval). Use `AskUserQuestion` with header "Permissions" and options: "Approve" / "Modify".

## Phase 4: Write Configuration

1. Read existing `.claude/settings.local.json` if present
2. Merge new `permissions.allow` with existing rules (deduplicate)
3. Preserve any existing `permissions.deny` or `permissions.ask` rules
4. Write the file. Create `.claude/` directory if needed.
5. **Never modify `.claude/settings.json`** — that file is shared team settings.

After writing, remind the user to restart Claude Code and note that `.claude/settings.local.json` should be in `.gitignore`.
