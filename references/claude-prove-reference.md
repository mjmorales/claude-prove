# claude-prove CLI Reference

<!-- Primacy: invocation shape + index before any prose -->

**Shape**: `claude-prove <topic> <action> [args] [flags]`

**Invocation:** `claude-prove <topic> <action>` — the CLI is assumed on `PATH`. Dev-mode users alias or symlink `claude-prove` to their working-tree entry point so the bare command always resolves correctly.

Examples below omit the prefix.

## Topic Index (task cue -> topic)

<!-- Retrieval cues: grep-match a task to a topic -->

- Find files, routing hints, repo index -> `cafi`
- Orchestrator run/step/validator/task verdict -> `run-state`
- Task, milestone, tag, next-ready, stalled -> `scrum`
- Validate/migrate/diff `.claude/.prove.json` -> `schema`
- Commit manifest, change brief, PR assemble -> `acb`
- Distill files into token-budgeted context -> `pcd`
- Count prompt tokens -> `prompting`
- Scaffold `.claude/`, doctor, upgrade binary -> `install`
- Generate/scan CLAUDE.md -> `claude-md`
- Render orchestrator task/review/wave-plan prompt -> `orchestrator`
- Create/remove/reset sub-task git worktrees -> `worktree`
- Gather session-handoff context (git + artifacts) -> `handoff`
- Dispatch reporter event (Slack/Discord/MCP) -> `notify`
- Inspect/migrate/reset `.prove/prove.db` -> `store`
- Review UI config -> `review-ui`; commit message check -> `commit`

## Topics

<!-- Canonical examples: one realistic invocation per high-traffic topic -->

### cafi — content-addressable file index + routing hints

Actions: `index [--force]` `status` `get <sha|path>` `lookup <keyword>` `context` `gate` `clear`. Flag: `--project-root`.
Ex: `cafi lookup scrum`. Run `cafi context`/`cafi lookup` before Glob/Grep.

### run-state — orchestrator run CRUD on `.prove/runs/<branch>/<slug>/`

Actions: `validate` `init` `show` `show-report` `ls` `summary` `current` `step` `step-info` `validator` `task` `dispatch` `report` `migrate` `migrate-runs` `hook`.
Flags: `--runs-root` `--branch` `--slug` `--kind` `--plan` `--prd` `--overwrite` `--format md|json` `--commit` `--reason` `--verdict` `--notes` `--reviewer` `--status` `--strict` `--dry-run` `--json`.
Ex: `run-state step --branch main --slug add-login --commit <sha> --verdict pass`
`migrate` applies the deterministic structural chain (column moves on run JSON); `migrate-runs` is the read-only planner for model-driven CONTENT reshaping — it detects which artifacts are behind the current schema and emits a plan (target artifacts + per-hop instruction file) that the operator-invoked `run-migrate` skill consumes. `migrate-runs` never calls a model and never mutates; it composes with `migrate` (structure first, content second) and runs only on explicit invocation, never as a background loop.

### scrum — tasks, milestones, tags on `.prove/prove.db`

Actions: `init` `status` `next-ready` `compile-plan` `alerts` `task <create|show|list|tag|link-decision|status|cancel|move|delete|add-dep|remove-dep|acceptance|bounds>` `milestone <create|list|show|close|activate|reopen>` `tag <add|remove|list>` `decision <record|get|list|supersede|review-stale|recover>` `contributor <register|list|resolve>` `operator <set|resolve|history>` `link-run` `hook <session-start|subagent-stop|stop>`.
`task acceptance <add|list|supersede>` manages first-class acceptance criteria; `task bounds <set|show>` reads/writes the per-task `bounds` declaration. `task create --parent <id> --layer <epic|story|task>` writes layered children into the containment tree. `task move <id> --milestone <m>|--unassign` reassigns a task's milestone (`--unassign` clears it). `task cancel <id> [--cascade]` cancels a task (or its whole `parent_id` subtree) with terminal provenance (`terminal_reason`/`terminal_detail`). `decision review-stale [--days N]` reports decisions older than the threshold (default 90) — report-only, never prunes.
Story-layer floors (mechanical, store-enforced): a `layer=story` task is rejected on `→ ready|in_progress|done` with zero active acceptance criteria, and on `→ done` with no `synthesis` reasoning-log entry in its most-recent linked run; criteria are frozen while a task is `in_progress`.
`contributor register --slug <s> [--display-name N] [--github G] [--email E] [--id CT-UUID] [--status active|inactive]` mints a CT-UUID (a stable, prefixed contributor id) and writes a `contributors/<slug>.md` identity artifact mirroring the row; `contributor list [--status active|inactive]` lists the registry; `contributor resolve [--github G] [--email E]` maps a worker/event author to a contributor by github match first, then email fallback (exit 1 on a miss).
`operator set --contributor <CT-UUID> [--from-ts ISO]` sets/transfers the operator-of-record — the single role slot — appending a new open position-history interval (closing the prior one at the handoff instant) and syncing `charter.md`'s `operator_of_record` frontmatter; `operator resolve --at <ISO>` returns the contributor who held the role AT that instant (the `[from_ts, to_ts)` interval containing it), NOT the current holder (exit 1 when no holder was in effect); `operator history [--human]` prints the full interval list oldest-first.
Flags: `--human` `--limit` `--milestone` `--title` `--description` `--id` `--status` `--tag` `--task` `--target-state` `--branch` `--slug` `--out` (compile-plan) `--stalled-after-days` (default 7) `--workspace-root` `--parent` `--layer <epic|story|task>` `--bounds <json>` `--text` `--verifies-by <bash|assert|gate|agent>` `--check` `--idempotent` `--criterion` `--by` `--reason` `--cascade` `--detail` `--days` `--unassign` `--topic` `--from-git` `--display-name` `--github` `--email` `--contributor` `--from-ts` `--at`.
Ex: `scrum task create --title "Add login" --milestone auth-v1 --tag backend`.
Ex: `scrum task create --title "OAuth" --parent <epic-id> --layer story` · `scrum task acceptance add <id> --text "builds clean" --verifies-by bash --check "bun run build"`.
`compile-plan --milestone <id> [--out plan.json]` emits a run-state plan.json (waves from `blocked_by` edges) + a `scrum-map.json` sidecar — the `/prove:workflow` source-compile step.
`scrum hook` is hook-driven — do not call inline.

### schema — `.claude/.prove.json` lifecycle

Actions: `validate` `migrate` `diff` `summary`. Flags: `--file <path>` `--strict` `--dry-run`.
Ex: `schema migrate --file .claude/.prove.json`

### acb — Agent Change Brief

Actions: `save-manifest` `assemble` `hook post-commit` `migrate-legacy-db`.
Flags: `--branch` `--sha` `--slug` (save-manifest); `--base <branch>` (assemble, default `main`); `--workspace-root`.
Ex: `acb assemble --branch feat/login --base main`

### pcd — Progressive Context Distillation

Actions: `map` `collapse` `batch` `status`. Flags: `--project-root` `--scope <csv>` `--token-budget <n>` (default 8000) `--max-files <n>` (default 15).
Ex: `pcd map --scope src/auth,src/db --token-budget 6000`

### prompting — prompt token accounting

Action: `token-count <patterns...>`. Flags: `--sort tokens|name|lines` `--json` `--no-strip`.
Ex: `prompting token-count "agents/*.md" --sort tokens`. Heuristic tokenizer (~10-15% of BPE); strips YAML frontmatter unless `--no-strip`.

### store — `.prove/prove.db` unified store

Actions: `migrate` `info` `reset` (requires `--confirm`). Ex: `store info`.

### install — `.claude/` scaffolding + binary upgrade

Actions: `init` `init-hooks` `init-config` `doctor` `upgrade`. Flags: `--project` `--cwd` `--settings <path>` `--force` `--prefix <dir>` (default `~/.local/bin`). Ex: `install doctor`.

### review-ui — review UI config

Action: `config`. Flag: `--cwd`. Ex: `review-ui config`.

### commit — conventional commit validator

Action: `validate-msg [file]`. Ex: `commit validate-msg .git/COMMIT_EDITMSG`.

### claude-md — CLAUDE.md generation + inspection

Actions: `generate` `scan` `subagent-context` `validators`. Flags: `--project-root` `--plugin-dir`. Ex: `claude-md scan`.

### orchestrator — render orchestrator prompts + wave schedule

Actions: `task-prompt` `review-prompt` `wave-plan`. Flags: `--run-dir` `--task-id` `--project-root` `--worktree` (req for `review-prompt`) `--base-branch` (review-prompt) `--max-agents` `--format json|md` (wave-plan).
Ex: `orchestrator task-prompt --run-dir .prove/runs/main/add-login --task-id 1`
`wave-plan --run-dir <dir> [--max-agents N] [--format md]` emits the read-only dependency-wave dispatch schedule (batches capped at `--max-agents`, `dispatch_rounds`, `peak_concurrency`) — the `/prove:workflow` scheduler + `--dry-run` projection.

### worktree — namespaced sub-task git worktrees

Actions: `create` `remove` `remove-all` `list` `path` `branch` `reset`. Flags: `--base <branch>` (create/reset; default `orchestrator/<slug>`) `--workspace-root`.
Naming: path `.claude/worktrees/<slug>-task-<id>`, branch `task/<slug>/<id>`. `create`/`path`/`branch`/`reset` print the path on stdout; `list` prints JSON. Exit: 1 usage, 2 git failure.
Ex: `worktree create add-login 1` · `worktree reset add-login 1` (auto-rebound).

### handoff — session-handoff context

Action: `gather`. Flags: `--project-root` (req) `--plugin-dir` (enables the Discovery section).
Emits deterministic markdown (git state + files + recent commits + prove artifacts + discovery + task-plan steps). No LLM calls.
Ex: `handoff gather --project-root "$PWD" --plugin-dir "$PLUGIN_DIR"`

### notify — reporter event dispatcher

Actions: `dispatch <event>` `test [event]`. Flags: `--project-root` `--config` `--branch` `--slug`.
Ex: `notify dispatch step-complete --branch main --slug add-login`. Events: see `references/validation-config.md`.

## Reserved / Out of scope

<!-- Constraint pairing: every "do not" names a replacement -->

- Do not invoke a top-level `hook` topic — reserved. Instead use `scrum hook <event>` or `acb hook post-commit`.
- Do not look up `/prove:*` slash commands, skills, or agents here — CLI-only reference. Instead read `commands/`, `skills/`, or `agents/`.
- Do not call `prompting cache` or `prompting craft` — skill-level only. Instead use `/prove:prompting` (out of scope).
- Do not invent flags. Instead run `<topic> --help`.

---
<!-- Version stamp -->
claude-prove v2.0.4 — source of truth: `<topic> --help`
