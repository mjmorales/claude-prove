# Plugin Updates

Migration guide for features that require user action after updating the plugin. Run `/prove:update` to apply these automatically, or follow the manual steps below.

For the full commit-level changelog, see [CHANGELOG.md](CHANGELOG.md).

---

## v0.39.0 — run_state ported to TypeScript

Phase 6 of the TypeScript CLI unification (see `.prove/decisions/2026-04-21-typescript-cli-unification.md`). The Python `tools/run_state/` module is retired; orchestrator state mutation now flows through `prove run-state` backed by `packages/cli/src/topics/run-state/`. Every Claude Code hook, shell script, and skill directive that previously invoked `python3 -m tools.run_state ...` now routes through the TS CLI (directly or via `scripts/prove-run`, whose public interface is unchanged).

**Removed**:

- `tools/run_state/` (all Python sources, hook entrypoints, tests, `tool.json`, `__main__.py`, `_validator.py`)
- `python3 -m tools.run_state <cmd>` invocation path
- `python3 tools/run_state/hook_*.py` commands in `.claude/settings.json` (PreToolUse, PostToolUse, SessionStart, Stop, SubagentStop)

**Added**:

- `prove run-state validate, init, show [--kind ...], show-report <id>, ls, summary, current, step <start|complete|fail|halt> <id>, step-info <id>, validator set <id> <phase> <status>, task review <id> --verdict <v>, dispatch <record|has>, report write <id> --status ..., migrate` — full TS port
- `prove run-state hook <guard|validate|session-start|stop|subagent-stop>` — Claude Code hook entrypoints, read payload from stdin, exit with Python-compatible codes
- `packages/cli/src/topics/run-state/{schemas,validate,validator-engine,paths,state,migrate,render}.ts` — 312 bun tests and 63+ byte-equal parity captures against the retired Python module
- `packages/cli/src/topics/run-state/hooks/{guard,validate,session-start,stop,subagent-stop,dispatch,json-compat,types}.ts`
- `packages/cli/src/topics/run-state/cli/*` — 13 per-action handlers

**Migration**:

1. Run `/prove:update` — picks up the new CLI and rewrites the five `.claude/settings.json` hook entries (PreToolUse + PostToolUse Write|Edit|MultiEdit, SessionStart resume|compact, Stop, SubagentStop general-purpose) in place.
2. Manual fallback for each hook: command body becomes `bun run <plugin>/packages/cli/bin/run.ts run-state hook <event>`; timeouts preserved (3000ms SessionStart, 5000ms everywhere else).
3. `scripts/prove-run` keeps its public interface unchanged; the body swaps to `bun run <plugin>/packages/cli/bin/run.ts run-state`. Agents calling `scripts/prove-run <subcmd>` need no changes.
4. If scripts call `python3 -m tools.run_state …` directly, rewrite to `prove run-state …` (or `scripts/prove-run <subcmd>`).
5. Schema path references: `tools/run_state/schemas.py` → `packages/cli/src/topics/run-state/schemas.ts`.

**CLI shape divergences** (agents calling the underlying CLI directly — `scripts/prove-run` masks these):

- Python `run_state report show <step_id>` is now `run-state show-report <step_id>` on the TS side. `scripts/prove-run show-report <id>` still works unchanged.
- `run-state migrate` flags are kebab-case on the CLI (`--dry-run`, `--overwrite`) and camelCase internally. Downstream wrappers should pass kebab.
- Exit codes mirror Python: 0 success, 1 usage/IO, 2 schema/invariant violation (hook-blocking), 3 dispatch miss.

**Auto-adoption**: `/prove:update` swaps `.claude/settings.json` hook entries and refreshes `scripts/prove-run` body in place. No on-disk format migration required — state.json / plan.json / prd.json / reports/*.json schemas are unchanged (still `schema_version: "1"`).

---

## v0.38.0 — CAFI ported to TypeScript

Phase 5 of the TypeScript CLI unification (see `.prove/decisions/2026-04-21-typescript-cli-unification.md`). The Python `tools/cafi/` module is retired; the content-addressable file index is now a real TypeScript topic backed by `packages/cli/src/topics/cafi/` and the shared helpers in `packages/shared/src/`. The PreToolUse Glob|Grep hook that injects CAFI context now runs the TS gate. Config is now read from the post-v4 `tools.cafi.config` path — the retired top-level `index` key is no longer consulted, fixing a latent silent-fallback-to-defaults bug.

**Removed**:

- `tools/cafi/` (all Python sources, tests, `tool.json`, README)
- `python3 -m tools.cafi` / `python3 $PLUGIN_DIR/tools/cafi/__main__.py` invocation path
- Python `cafi_gate.py` PreToolUse hook command

**Added**:

- `prove cafi index [--force] [--project-root <path>]`
- `prove cafi status [--project-root <path>]`
- `prove cafi get <path> [--project-root <path>]`
- `prove cafi lookup <keyword> [--project-root <path>]`
- `prove cafi clear [--project-root <path>]`
- `prove cafi context [--project-root <path>]`
- `prove cafi gate` — PreToolUse hook dispatcher; reads the Claude Code hook payload from stdin
- `packages/shared/src/{cache,file-walker,tool-config}.ts` — shared helpers reusable by PCD in phase 7
- `packages/cli/src/topics/cafi/` — full TS port with bun test coverage and parity fixtures under `__fixtures__/`
- Fix: config is now read from `tools.cafi.config` (post-v4 path); the retired top-level `index` key is no longer consulted (silent fallback-to-defaults bug resolved)

**Migration**:

1. Run `/prove:update` — picks up the new CLI and rewrites the `.claude/settings.json` PreToolUse Glob|Grep hook automatically.
2. Manual fallback for the hook entry: invoke becomes `bun run <plugin>/packages/cli/bin/run.ts cafi gate` with `_tool: "cafi"` ownership and `timeout: 10000`.
3. If scripts call `python3 tools/cafi/__main__.py …`, rewrite to `bun run <plugin>/packages/cli/bin/run.ts cafi …`.
4. No on-disk cache migration required — `.prove/file-index.json` format is unchanged (still cache v1).

**Auto-adoption**: `/prove:update` refreshes the hook command in place; existing cache files are read and re-indexed without user intervention.

## v0.37.0 — Schema topic ported to TypeScript (breaking config migration)

Phase 4 of the TypeScript CLI unification (see `.prove/decisions/2026-04-21-typescript-cli-unification.md`). The Python `tools/schema/` module is retired; `prove schema` is now a real TypeScript topic backed by `packages/cli/src/topics/schema/`. `.claude/.prove.json` migrates from v3 to v4.

**Removed**:

- `tools/schema/` (all Python sources, tests, and `tool.json`)
- `python3 -m tools.schema <cmd>` invocation path
- `scopes.tools` mapping in `.claude/.prove.json` (no longer needed — `tools/` directory is retired per the TS unification plan)
- `tools.schema.enabled` registry entry (schema is now a CLI topic, not a pluggable tool)

**Added**:

- `prove schema validate [--file <path>] [--strict]`
- `prove schema migrate [--file <path>] [--dry-run]`
- `prove schema diff [--file <path>]`
- `prove schema summary`
- `packages/cli/src/topics/schema/` — full TS port with bun test coverage (64 tests) and parity fixtures under `__fixtures__/`
- v3→v4 migration in `packages/cli/src/topics/schema/migrate.ts` (drops `scopes.tools` + `tools.schema`)

**Migration**:

1. Run `/prove:update` — it picks up the new CLI and runs `prove schema migrate` against `.claude/.prove.json` automatically.
2. Manual fallback: `bun run <plugin>/packages/cli/bin/run.ts schema migrate --file .claude/.prove.json`.
3. Remove any `.bak` file the migrator writes (only needed if you want to keep an on-disk backup; git history already covers it).
4. If you have scripts that call `python3 -m tools.schema …`, rewrite them to call `prove schema …`.

**Auto-adoption**: `/prove:update` runs the migration and refreshes command bodies in place. No manual config edits required for standard repos.

## v0.35.0 — Docker-based review UI (breaking)

The ACB review UI has moved out of the plugin and into a standalone Docker image published to GHCR. All Python-side review commands and the embedded Flask UI are gone.

**Removed** (breaking):

- `/prove:review`, `/prove:review:fix`, `/prove:review:discuss`, `/prove:review:resolve` commands
- `skills/review/` skill
- `python3 -m tools.acb` subcommands: `serve`, `fix`, `discuss`, `resolve`
- `tools/acb/server.py`, `tools/acb/static/`, `tools/acb/review_prompts.py`, and the `fix_prompt.j2` / `discuss_prompt.j2` / `resolve_summary.j2` templates

**Added**:

- `/prove:review-ui` — launches `ghcr.io/mjmorales/claude-prove/review-ui` as a detached Docker container named `prove-review`. Binds the project root to `/repo`. Handles container lifecycle (start, reuse, stop, restart) and opens the browser.
- `tools/review-ui/` — Fastify + Vite React tool that replaces the Python UI. Same underlying `.prove/acb.db` store; different frontend (Dracula theme, progressive column reveal, explicit verdict CTAs).
- `.github/workflows/review-ui-image.yml` — builds and pushes multi-arch (`linux/amd64`, `linux/arm64`) images on pushes to `main` and tags matching `review-ui-v*`.

**Migration**:

1. Install Docker Desktop (or any compatible runtime — `colima`, `podman machine`). The `/prove:review-ui` command checks for `docker` on `PATH`.
2. Replace any `/prove:review` invocations in scripts, docs, or agent prompts with `/prove:review-ui`. The new command keeps the UI running between calls (detached container named `prove-review`) so repeated invocations just reopen the browser.
3. If you previously relied on CLI-mode review (`python3 -m tools.acb fix|discuss|resolve`), use the in-UI actions instead — the rework drawer composes the same fix brief and writes verdicts to `.prove/acb.db` that the review UI reads.
4. `python3 -m tools.acb save-manifest` and `python3 -m tools.acb assemble` are unchanged — manifest creation and ACB assembly still run locally.

**Auto-adoption**: `/prove:update` refreshes the `acb` tool directive in CLAUDE.md to point at `/prove:review-ui`. The old command files are removed from the plugin automatically on next update.

### Config

New keys under `tools.acb.config` in `.claude/.prove.json`:

```json
{
  "tools": {
    "acb": {
      "config": {
        "review_ui_port":  5174,
        "review_ui_image": "ghcr.io/mjmorales/claude-prove/review-ui",
        "review_ui_tag":   "latest"
      }
    }
  }
}
```

`/prove:review-ui` reads these as defaults. Precedence: `--port`/`--image`/`--tag` flags > `PROVE_REVIEW_*` env vars > config > built-in defaults. Pin `review_ui_tag` to `review-ui-vX.Y.Z` for reproducible review sessions.

## v0.34.0 — JSON-first Run State (breaking)

All run artifacts under `.prove/runs/` are now JSON. Markdown (`PRD.md`, `TASK_PLAN.md`, `PROGRESS.md`) and the old `dispatch-state.json` are gone.

**New layout**: `.prove/runs/<branch>/<slug>/` with:

- `prd.json` — write-once requirements
- `plan.json` — write-once task graph (tasks, waves, deps, steps)
- `state.json` — hot path, mutated **only** via `scripts/prove-run`
- `reports/<step_id>.json` — write-once per-step reports

No markdown is persisted. Every human view renders JIT from JSON:

```bash
scripts/prove-run ls               # list active runs
scripts/prove-run show state       # render current state
scripts/prove-run show plan        # render plan
scripts/prove-run show prd         # render PRD
scripts/prove-run show-report <id> # render per-step report
```

### `scripts/prove-run` — the blessed CLI

Every mutation and query routes through this single wrapper. Agents must not inline `python3 -c`, `jq`, or `sed` against run state.

```bash
scripts/prove-run init --branch <b> --slug <s> --plan ... [--prd ...]
scripts/prove-run step-start <id>
scripts/prove-run step-complete <id> --commit <sha>
scripts/prove-run step-fail <id> --reason "..."
scripts/prove-run step-halt <id> --reason "..."
scripts/prove-run validator <id> <phase> <status>
scripts/prove-run review <task-id> approved|rejected --reviewer <name>
scripts/prove-run report <id> --status completed --commit <sha>
scripts/prove-run dispatch-record <key> <event>
scripts/prove-run step-info <id>   # JSON: {task, step, task_state, step_state}
```

Slug is auto-resolved from `.prove-wt-slug.txt` (written by `manage-worktree.sh create`). If missing, the CLI hard-errors (exit 2) — agents must never invent slugs.

### Hook enforcement

A `run_state` tool ships with three hooks (installed via `python3 tools/registry.py install run_state`):

- **PreToolUse** `Write|Edit|MultiEdit` on `state.json`: blocks direct edits; directs to `prove-run`
- **PostToolUse** `Write|Edit|MultiEdit` on any `.prove/runs/**/*.json`: validates against the schema; blocks invalid writes
- **SessionStart** `resume|compact`: prints active-run summary into the new session
- **SubagentStop**: reconciles the subagent's worktree — auto-completes the current step if the subagent produced a new commit, halts it otherwise
- **Stop** (session end): halts any `in_progress` step with a diagnostic reason so the next session resumes on clean state

Sub-agents MUST NOT call `scripts/prove-run step-complete` themselves. The step-state contract for workers is: commit your work and exit — the SubagentStop hook records the SHA. The orchestrator owns step transitions.

Override the Pre hook with `RUN_STATE_ALLOW_DIRECT=1` only for emergency recovery.

### Migration

```bash
# One-shot — converts every legacy run in-place, folds dispatch-state.json
# into state.json, preserves markdown bodies under prd.body_markdown.
# (Since v0.39.0 this runs through the TS CLI; prior versions shipped
#  `python3 -m tools.run_state migrate`, retired with tools/run_state/.)
prove run-state migrate

# Review what changed first:
prove run-state migrate --dry-run

# Then delete legacy md/json:
find .prove/runs -type f \
  \( -name "PRD.md" -o -name "TASK_PLAN.md" -o -name "PROGRESS.md" \
     -o -name "dispatch-state.json" -o -name "dispatch-state.json.lock" \) -delete
find .prove/runs -type d -empty -delete

# Move any remaining flat-layout runs into a branch namespace:
mkdir -p .prove/runs/main
mv .prove/runs/<slug> .prove/runs/main/

# Install the enforcement hooks:
python3 tools/registry.py install run_state
```

### Files removed

- `scripts/update-progress.sh` (PROGRESS.md is gone)
- `skills/orchestrator/scripts/update-progress.sh`
- `scripts/manage-worktree.sh` (kept only at `skills/orchestrator/scripts/manage-worktree.sh`)
- `scripts/generate-task-prompt.sh` (top-level duplicate)
- `scripts/generate-review-prompt.sh` (top-level duplicate)
- `skills/task-planner/assets/templates/TASK_PLAN_template.md`

### Consumers updated

- `skills/orchestrator/SKILL.md` + scripts — drive state via `scripts/prove-run`; prompts render from JSON
- `skills/task-planner/SKILL.md` — emits `prd.json` + `plan.json`, calls `init` to seed `state.json`
- `skills/plan-step/SKILL.md` — reads via `scripts/prove-run step-info <id>`
- `skills/handoff/scripts/gather-context.sh` — renders run state via the CLI
- `skills/cleanup/SKILL.md` + `scripts/cleanup.sh` — archives JSON, scans branched layout
- `skills/prep-permissions/SKILL.md`, `skills/review/SKILL.md`, `skills/steward*/SKILL.md` — read `plan.json` via the CLI
- `scripts/dispatch-event.sh` — dedup via `state.json.dispatch.dispatched[]`
- `scripts/hooks/*.sh` — read state.json; propagate `PROVE_RUN_SLUG` / `PROVE_RUN_BRANCH`
- `tools/acb/_slug.py` — slug resolution now scans `plan.json`'s `worktree.path` field
- `tools/acb/hook.py` — on `orchestrator/*` or `task/*` branches, a missing slug hard-blocks the commit; the error instructs you to create the worktree via `manage-worktree.sh create` (which writes `.prove-wt-slug.txt`). Non-orchestrator branches keep the previous behavior (slug optional)

### Schema evolution

Run-state JSON carries its own `schema_version` (currently `"1"`) independent from the `.claude/.prove.json` schema. Future breaking changes will increment and migrate via `packages/cli/src/topics/run-state/migrate.ts`.

---

## v0.18.0 — External References & Dynamic Commands

### External References for CLAUDE.md

Projects can now include external files (coding standards, security policies, etc.) in their generated CLAUDE.md via `@` inclusions. References are configured per-repo in `.claude/.prove.json` and rendered inside the managed block.

**What ships with the plugin**: `references/llm-coding-standards.md` — LLM-optimized coding standards applied across all projects.

**Migration** (existing projects):

```bash
# Option 1: Automatic — run /prove:update, Step 5 will detect and offer bundled references

# Option 2: Manual — add to .claude/.prove.json:
```

```json
{
  "claude_md": {
    "references": [
      {"path": "$PLUGIN_DIR/references/llm-coding-standards.md", "label": "LLM Coding Standards"}
    ]
  }
}
```

Then regenerate: `/prove:docs:claude-md`

`$PLUGIN_DIR` is resolved at generation time to the actual plugin install path.

**New projects**: `/prove:init` Step 7 offers bundled references automatically.

### Dynamic Prove Commands

The `## Prove Commands` section in generated CLAUDE.md is no longer hardcoded. Commands with `core: true` in their frontmatter are auto-detected and rendered.

**Migration**: No action needed. Run `/prove:docs:claude-md` to regenerate — new commands appear automatically.

**Adding your own**: Any command file in `commands/` with `core: true` and `summary:` in its frontmatter will appear in generated CLAUDE.md files:

```yaml
---
description: What this command does
core: true
summary: Short text for CLAUDE.md listing
---
```

### Default Subcommand for claude-md CLI

`python3 skills/claude-md/__main__.py` now defaults to `generate` when no subcommand is given.

**Migration**: No action needed. Existing explicit `generate` calls still work.
