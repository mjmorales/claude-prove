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

**Operator-invoked only.** This skill is run by hand before a session; it is NOT auto-wired into orchestrator or workflow dispatch. The orchestrator does not call it, and subagents do not re-derive per-agent scoping — the git worktree wall plus this one workspace `settings.local.json` are the enforcement surfaces.

## Phase 1: Gather Context

Read these files (skip missing ones):

1. Active run's `plan.json` under `.prove/runs/<branch>/<slug>/` — task list, deps, and per-task `bounds`. Use:
   `claude-prove run-state show --kind plan --format json --branch <branch> --slug <slug>`
2. `.prove/plans/plan_*/05_implementation_plan.md` — file paths, commands
3. `.claude/.prove.json` — validator and reporter commands
4. `.claude/settings.local.json` — existing rules to preserve
5. Project root — check for `go.mod`, `package.json`, `Cargo.toml`, `pyproject.toml`, `Makefile`, `project.godot`

## Phase 2: Build Permission Rules

Generate `permissions.allow` and `permissions.deny` rules with the most specific patterns possible.

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

### From declared task bounds (`plan.json tasks[].bounds`)

Each task MAY declare `bounds`. All sub-fields are optional; absent = unbounded (skip). When present, translate each sub-field to native permissions or prompt guidance per this table:

| `bounds` sub-field | Translation |
|--------------------|-------------|
| `tools.allow[]` | Append each pattern verbatim to `permissions.allow` |
| `tools.deny[]` | Append each pattern verbatim to `permissions.deny` |
| `write[]` (path globs) | ADVISORY. Permission deny rules block what they *match* — there is no "deny everything outside X" form — so write scope cannot be a permission rule. The git **worktree is the write wall**; render the allowed write paths into the task-prompt guidance (Phase 3). Emit NO permission rule. (A hard native per-path wall would need a `PreToolUse` hook — out of scope.) |
| `read[]` (path globs) | ADVISORY. There is no native read-deny surface — render the allowed read paths into the task-prompt guidance (Phase 3), do not emit a permission rule. |
| `budgets.{tokens,tool_calls,wall_clock_s}` | ADVISORY ONLY. No daemon enforces these. Render them into the task-prompt guidance as soft ceilings; the native subagent timeout is the only hard floor. Emit NO permission rule. |

Example — task with `bounds: { write: ["src/auth/**"], tools: { allow: ["Bash(go test *)"], deny: ["Bash(git push *)"] }, budgets: { tokens: 200000 } }`:
- `permissions.allow` gains `Bash(go test *)`
- `permissions.deny` gains `Bash(git push *)`
- Prompt guidance gains: "write scope (worktree wall): src/auth/**; read scope advisory; soft budget: ~200k tokens"

### Union model (known limitation)

There is ONE workspace `settings.local.json` — the UNION of every task's rules — so with parallel tasks, task A inherits task B's allowed tools (not per-task isolated). Accepted for now; per-worktree isolation (a scoped `settings.local.json` per task worktree) is deferred until cross-task tool bleed matters and Claude Code is confirmed to honor a worktree-local settings file from the subagent's CWD.

### Require user approval (do not add to allow)

- `Bash(rm *)`, `Bash(git push *)`, `Bash(git reset *)` — destructive ops
- `Bash(curl *)`, `Bash(wget *)` — network calls
- `Bash(sudo *)` — elevated privileges
- Anything touching `.env`, credentials, or secrets

A task-declared `tools.deny` rule for any of these is honored as-is; never move a task's deny into allow.

## Phase 3: Confirm with User

Present rules grouped by category (git, build/test, file ops, orchestrator, task-bound deny, still-requires-approval), plus the advisory `write`/`read`/`budgets` guidance derived from bounds. Use AskUserQuestion with header "Permissions": "Approve" / "Modify".

## Phase 4: Write Configuration

1. Read existing `.claude/settings.local.json` if present
2. Merge new `permissions.allow` with existing rules (deduplicate)
3. Merge `permissions.deny` (toolchain + task-bound `tools.deny` rules), preserving existing `permissions.deny`/`permissions.ask` entries
4. Write the file (create `.claude/` if needed). Only modify `settings.local.json`, not the shared `settings.json`.
5. Remind the user to restart Claude Code and confirm `.claude/settings.local.json` is in `.gitignore`
