# claude-prove CLI Reference

<!-- Primacy: invocation shape + index before any prose -->

**Shape**: `claude-prove <topic> <action> [args] [flags]`

**Invocation:**
- In this repo (prefer): `bun run claude-prove/packages/cli/bin/run.ts <topic> <action>` — uses working-tree source, not the stale installed binary.
- Installed: `claude-prove <topic> <action>`.

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
- Render orchestrator task/review prompt -> `orchestrator`
- Dispatch reporter event (Slack/Discord/MCP) -> `notify`
- Inspect/migrate/reset `.prove/prove.db` -> `store`
- Review UI config -> `review-ui`; commit message check -> `commit`

## Topics

<!-- Canonical examples: one realistic invocation per high-traffic topic -->

### cafi — content-addressable file index + routing hints

Actions: `index [--force]` `status` `get <sha|path>` `lookup <keyword>` `context` `gate` `clear`. Flag: `--project-root`.
Ex: `cafi lookup scrum`. Run `cafi context`/`cafi lookup` before Glob/Grep.

### run-state — orchestrator run CRUD on `.prove/runs/<branch>/<slug>/`

Actions: `validate` `init` `show` `show-report` `ls` `summary` `current` `step` `step-info` `validator` `task` `dispatch` `report` `migrate` `hook`.
Flags: `--runs-root` `--branch` `--slug` `--kind` `--plan` `--prd` `--overwrite` `--format md|json` `--commit` `--reason` `--verdict` `--notes` `--reviewer` `--status` `--strict` `--dry-run` `--json`.
Ex: `run-state step --branch main --slug add-login --commit <sha> --verdict pass`

### scrum — tasks, milestones, tags on `.prove/prove.db`

Actions: `init` `status` `next-ready` `alerts` `task <create|show|list|tag|link-decision|status|delete>` `milestone <create|list|show|close>` `tag <add|remove|list>` `link-run` `hook <session-start|subagent-stop|stop>`.
Flags: `--human` `--limit` `--milestone` `--title` `--description` `--id` `--status` `--tag` `--task` `--target-state` `--branch` `--slug` `--stalled-after-days` (default 7) `--workspace-root`.
Ex: `scrum task create --title "Add login" --milestone auth-v1 --tag backend`.
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

### orchestrator — render orchestrator prompts

Actions: `task-prompt` `review-prompt`. Flags: `--run-dir` `--task-id` `--project-root` `--worktree` (req for `review-prompt`) `--base-branch` (review-prompt).
Ex: `orchestrator task-prompt --run-dir .prove/runs/main/add-login --task-id 1`

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
