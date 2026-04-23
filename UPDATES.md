# Plugin Updates

Migration guide for features that require user action after updating the plugin. Run `/prove:update` to apply these automatically, or follow the manual steps below.

For the full commit-level changelog, see [CHANGELOG.md](CHANGELOG.md).

---

## v1.0.2 — Skill/command consolidation

Aggressive consolidation after the phase-13 CLI unification. Twenty-five skills collapse to thirteen, thirty-five commands collapse to sixteen. Each merge group routes by a mode flag or subcommand; no functional capability is lost. Description fields on the new skills absorb every trigger phrase from the retired skills so description-matched invocations still route correctly for a release while muscle memory adjusts.

**Merged skills** (N → 1 with dispatch):

- `/prove:steward` — absorbs `auto-steward`, `steward-review`. Modes: `--review` (default, session diff), `--full [scope]` (PCD pipeline + fixes), `--auto [--max-passes N]` (iterative loop).
- `/prove:create` — absorbs `skill-creator`, `slash-command-creator`, `subagent-creator`, `spec-writer`. Dispatch: `--type skill|command|agent|spec`.
- `/prove:docs` — absorbs `docs-writer`, `agentic-doc-writer`, `auto-docs`, `claude-md`. Subcommands: `human`, `agent`, `both` (default), `claude-md generate`, `claude-md update <directive>`.
- `/prove:prompting` — absorbs `prompting-craft`, `prompting-cache`, `prompting-token-count`. Subcommands: `craft`, `cache`, `token-count`.
- `/prove:plan` — absorbs `plan-step`, `task-planner`. Modes: `--task [desc]`, `--step <id>`.
- `/prove:notify` — absorbs `notify-setup`. Subcommands: `setup [platform]`, `test [--reporter name]`.
- `/prove:task` — absorbs `handoff`, `cleanup` + lifecycle commands. Subcommands: `handoff`, `pickup`, `progress`, `complete <slug>`, `cleanup <slug>`.
- `/prove:orchestrator` — absorbs autopilot/full-auto as flags. Modes: `--autopilot [plan-id]`, `--full [desc]`, auto-detect default.

**Removed**:

- Skill dirs: `auto-steward`, `steward-review`, `skill-creator`, `slash-command-creator`, `subagent-creator`, `spec-writer`, `docs-writer`, `agentic-doc-writer`, `auto-docs`, `claude-md`, `prompting-craft`, `prompting-cache`, `prompting-token-count`, `plan-step`, `task-planner`, `notify-setup`, `handoff`, `cleanup`.
- Command files (wrappers + subdirs): `spec.md`, `claude-md-update.md`, `plan-step.md`, `plan-task.md`, `handoff.md`, `pickup.md`, `progress.md`, `complete-task.md`, `task-cleanup.md`, `autopilot.md`, `full-auto.md`, `commit.md`, `brainstorm.md`, `comprehend.md`, `index.md`, `prep-permissions.md`, plus `commands/{steward,create,docs,prompting,notify}/` subdirs in full.
- `skills/handoff/scripts/gather-context.sh` relocated to `skills/task/scripts/gather-context.sh`.

**Unchanged** (load-bearing, not merged): agents under `agents/` (delegation targets); CLI topics under `packages/cli/src/topics/`; `skills/{brainstorm,commit,comprehend,index,orchestrator,prep-permissions}`; `commands/{scrum,init,update,doctor,install-skills,report-issue,review-ui,bug-fix}.md`.

**Migration**:

1. Update slash-command muscle memory — old paths are gone with no aliases:
   - `/prove:autopilot <plan>` → `/prove:orchestrator --autopilot <plan>`
   - `/prove:full-auto [desc]` → `/prove:orchestrator --full [desc]`
   - `/prove:handoff` → `/prove:task handoff`
   - `/prove:pickup` → `/prove:task pickup`
   - `/prove:progress` → `/prove:task progress`
   - `/prove:complete-task <slug>` → `/prove:task complete <slug>`
   - `/prove:task-cleanup <slug>` → `/prove:task cleanup <slug>`
   - `/prove:plan-task <desc>` → `/prove:plan --task <desc>`
   - `/prove:plan-step <id>` → `/prove:plan --step <id>`
   - `/prove:create:create-{skill,command,agent}` → `/prove:create --type {skill,command,agent}`
   - `/prove:spec` → `/prove:create --type spec`
   - `/prove:docs:{auto-docs,agentic-docs,claude-md}` → `/prove:docs {both,agent,claude-md}`
   - `/prove:claude-md-update <directive>` → `/prove:docs claude-md update <directive>`
   - `/prove:steward:{auto-steward,steward-review}` → `/prove:steward {--auto,--review}`
   - `/prove:prompting:{craft,cache,token-count}` → `/prove:prompting {craft,cache,token-count}` (path flattens)
   - `/prove:notify:{notify-setup,notify-test}` → `/prove:notify {setup,test}`
2. Description-matched invocations ("audit this code", "write docs for X", "craft a prompt for Y") continue to work — the new skills' frontmatter descriptions aggregate every trigger phrase from the retired ones.
3. External automation or scripts that shelled into `skills/handoff/scripts/gather-context.sh` must update the path to `skills/task/scripts/gather-context.sh`.
4. No schema change; no `/prove:update` action required beyond the normal managed-block refresh.

---

## v1.0.1 — Python removal (phase 13)

Post-cutover cleanup. Phase 13 retires the last shell/python bridges that still embedded business logic: every `python3 -c`, `jq`, or `awk` heredoc that read `.claude/.prove.json`, `plan.json`, or `prd.json` now runs through a typed `prove <topic>` subcommand. Four wrapper scripts are deleted outright; three skill/command markdown files migrate to the CLI surface; the final grep sweep confirms zero `python3` invocations remain in `agents/`, `commands/`, `skills/`, `references/`, `scripts/`, or top-level docs.

**Added**:

- `prove notify dispatch <event>` — reporter event dispatcher; dedupes via `state.json.dispatch.dispatched[]` through the run_state API, fires matching reporter commands with the `PROVE_*` env surface, prefixes each reporter's combined stdout/stderr with `  [<name>] `. Best-effort: always exits 0.
- `prove notify test [event]` — notification pipeline probe; reports match counts and invokes `runNotifyDispatch` with synthesized test env.
- `prove orchestrator task-prompt --run-dir --task-id --project-root [--worktree]` — emits the worktree implementation-agent prompt markdown directly (no sentinel+awk indirection).
- `prove orchestrator review-prompt --run-dir --task-id --worktree --base-branch` — emits the principal-architect review prompt; runs `git diff <base>...HEAD` inside the worktree via `child_process`.
- `prove claude-md validators [--project-root]` — emits `- <phase>: \`<command>\`` lines from `.claude/.prove.json`; plugin-dir-less fallback used by `skills/handoff/scripts/gather-context.sh`.
- 19 parity tests covering the new CLI surface (validators output, notify dispatch dedup + reporter firing, task/review-prompt rendering).

**Changed**:

- `skills/orchestrator/SKILL.md` — the `generate-{task,review}-prompt.sh` bash invocations are now `bun run "$PLUGIN_DIR/packages/cli/bin/run.ts" orchestrator <task-prompt|review-prompt> ...` with explicit flags.
- `skills/handoff/scripts/gather-context.sh` — discovery block calls `prove claude-md subagent-context` (primary) or `prove claude-md validators` (fallback via `command -v prove`); no more inline python3 reading `.claude/.prove.json`.
- `commands/notify/notify-test.md` — invokes `prove notify test` directly.
- `commands/doctor.md` — Tooling tier renumbered 2.1-2.4 (CAFI, Docker, Schema, Reporters); Step 2.1 Tool Registry Health and Step 2.6 Pack Symlink Health dropped; python3 → bun run for claude-md regen.
- `commands/init.md` — Step 7 (tool registry setup) dropped; subsequent steps renumbered 7-10; python3 → bun run for claude-md generate.
- `commands/update.md` — Step 5 subsection 3 (new-tools discovery) dropped; python3 → bun run for CLAUDE.md regen.
- Plugin version → `1.0.1`; CLAUDE.md managed-block version header → v1.0.1.

**Removed**:

- `scripts/dispatch-event.sh`, `scripts/notify-test.sh`, `skills/orchestrator/scripts/generate-task-prompt.sh`, `skills/orchestrator/scripts/generate-review-prompt.sh` — wholesale deletions; all callers migrated to `prove <topic>` subcommands.
- `commands/tools.md` + `/prove:tools` slash command — the underlying `tools/registry.py` pack registry was retired with the phase 11 tools/ deletion and has no TS replacement.

**Migration**:

1. Run `/prove:update` — refreshes the managed CLAUDE.md block to v1.0.1 and regenerates any scrum/ACB/run-state hook blocks if drift is detected. Schema version unchanged (still v5); no data migration required.
2. External automation that shelled out to `scripts/dispatch-event.sh`, `scripts/notify-test.sh`, or the two orchestrator prompt generators must migrate to `prove notify dispatch|test` or `prove orchestrator task-prompt|review-prompt` (same stdin/stdout contracts).
3. The `/prove:tools` slash command is gone. Tool install/remove/status have no replacement in v1.0.1 because the pack model itself was retired in phase 11; projects that installed community packs before the cutover should bundle them directly under `tools/<pack>/` and wire hooks manually if still needed.

**Auto-adoption**:

- Plugin version header auto-refreshes on first `/prove:update` after pull.
- New CLI subcommands are available immediately after pulling v1.0.1; callers in user-space skills/commands migrate at their own pace (the retired shell wrappers no longer exist, so stale callers fail loudly rather than silently).

---

## v1.0.0 — scrum + TypeScript unification complete

Cutover release. The TypeScript CLI unification (phases 6-11, see `.prove/decisions/2026-04-21-typescript-cli-unification.md`) is complete — every Python tool now runs through `prove <topic>` backed by `packages/cli/`. Phase 12 lands the scrum system top-to-bottom: schema, reconciler, hooks, CLI, agents, slash command, and read-only UI. From v1.0.0 forward, the public CLI shape is semver-stable: breaking changes require a major bump. See `.prove/decisions/2026-04-21-scrum-architecture.md` for the scrum architecture.

**Added**:

- Scrum system on `.prove/prove.db` (schema v5): `scrum_tasks`, `scrum_milestones`, `scrum_tags`, `scrum_task_tags`, `scrum_deps`, `scrum_run_links`, `scrum_context_bundles` — all managed through `prove scrum` and reconciled by `packages/cli/src/topics/scrum/reconcile.ts`
- `/scrum` slash command — `init|status|next` as direct `prove scrum` passthroughs; `task|milestone|tag|link|alerts` delegate to the `scrum-master` agent
- `prove scrum` CLI topic — subcommands: `init`, `status`, `next-ready`, `task`, `milestone`, `tag`, `link-run`, `hook`
- `scrum-master` agent (model: sonnet) — operational: hook-invoked (SessionStart/SubagentStop/Stop) and user-invoked via `/scrum` routes; owns task-state transitions, dep-graph edits, run/decision linkage
- `product-visionary` agent (model: opus) — strategic: user-invoked only; owns milestone shaping, VISION.md alignment, macro dep-chain leverage
- `/scrum` UI routes under `packages/review-ui/web/src/routes/scrum/` — 5 read-only views (overview, tasks, milestones, dep-graph, alerts) served by `/api/scrum/*` GET endpoints
- `plan.json` `task_id` optional field — couples orchestrator runs to scrum tasks; surfaced as linked/unlinked runs in `/scrum alerts`
- `.claude/settings.json` scrum hooks — three entries tagged `_tool: "scrum"`: SessionStart (`startup|resume|compact`), SubagentStop, Stop — all invoking `prove scrum hook <event>`

**Changed**:

- `.claude/.prove.json` schema v4 → v5 (adds `tools.scrum` block with `enabled` and `config.*` defaults). Auto-migrated via `/prove:update` or `prove schema migrate --file .claude/.prove.json`; full v0-to-v5 chain is covered by `packages/cli/src/topics/schema/migrate.test.ts`
- `/prove:task-planner` now prompts for `task_id` when `tools.scrum.enabled` is true and surfaces `prove scrum next-ready` as the picker source
- `commands/update.md` step 5 grew a **Scrum hooks** note: on schema v5+, `/prove:update` idempotently registers the three scrum hook entries in `.claude/settings.json` when they're missing

**Removed**:

- `tools/project-manager/` pack (wholesale) — superseded by the scrum CLI + agents. Legacy `planning/ROADMAP.md`, `planning/BACKLOG.md`, and `planning/ship-log.md` (if present in a consuming project) are absorbed by `/scrum init` on first run
- `product-owner` agent — replaced by `product-visionary` (opus; strategic scope, no transactional writes)

**Migration**:

1. Run `/prove:update` — applies the v4 → v5 schema migration, registers the three scrum hooks in `.claude/settings.json`, and refreshes the managed CLAUDE.md block.
2. Run `/scrum init` once — imports any legacy `planning/*` artifacts (`VISION.md`, `ROADMAP.md`, `BACKLOG.md`, `ship-log.md`) into scrum tasks/milestones/tags; safe to re-run.
3. Existing orchestrator plans without `task_id` keep working — they run unchanged and surface as unlinked-run alerts in `/scrum alerts`. Backfill via `prove scrum link-run --run <slug> --task <id>` when desired.

**Auto-adoption**:

- v1.0.0 signals CLI-shape stability — `prove <topic> <subcommand>` contracts are covered by semver from this release forward.
- Scrum hooks land automatically via `/prove:update` (idempotent by `_tool: "scrum"` marker). No manual `.claude/settings.json` edits required.
- Plan files without `task_id` remain valid input for the orchestrator; scrum coupling is opt-in per run.

---

## v0.43.0 — review-ui absorbed into the monorepo + Bun Docker runtime

Phase 11 of the TypeScript CLI unification (see `.prove/decisions/2026-04-21-typescript-cli-unification.md`). The standalone `tools/review-ui/` tree is retired; the review UI now lives at `packages/review-ui/` as a bun workspace, the Docker image runs on `oven/bun:1-alpine` (322MB → 110MB, same `ghcr.io/mjmorales/claude-prove/review-ui` name), and `/prove:review-ui` has shed its `python3` dependency in favour of `prove review-ui config | jq`. The web shell is now route-based: `/acb/*` (existing review flows) and a `/scrum` placeholder for phase 12. The server reads SQLite through `@claude-prove/store` (`bun:sqlite`) — `better-sqlite3` is gone.

**Added**:

- `packages/review-ui/` — monorepo home for the review UI as a bun workspace (`server/` + `web/` flattened into the root `workspaces` list)
- `prove review-ui config [--cwd <path>]` — CLI subcommand that emits `{port, image, tag}` as a single JSON line with hardcoded defaults filled for missing keys, consumed by `/prove:review-ui`
- `react-router-dom` in the web shell with `/acb/*` (existing review flows) and `/scrum` (phase 12 placeholder) routes

**Changed**:

- Docker runtime: `node:20-alpine` → `oven/bun:1-alpine`; image name unchanged (`ghcr.io/mjmorales/claude-prove/review-ui`); image size 322MB → 110MB
- `.github/workflows/review-ui-image.yml` — path filter and build context repointed from `tools/review-ui/` to `packages/review-ui/`
- `/prove:review-ui` slash command — config resolution now uses `prove review-ui config | jq -r '.<key>'` instead of `python3 -c 'import json...'`; the `python3` precondition is gone
- Review UI server SQLite access migrated to `@claude-prove/store` (`bun:sqlite`), replacing `better-sqlite3`

**Removed**:

- `tools/review-ui/` — fully migrated to `packages/review-ui/`
- `better-sqlite3` + `@types/better-sqlite3` from the server package
- `python3` dependency from `/prove:review-ui` (jq + prove CLI replace it)

**Migration**:

1. Image users: `docker pull ghcr.io/mjmorales/claude-prove/review-ui:latest`. Name is unchanged; the next `/prove:review-ui` pulls the Bun-based image transparently.
2. Dev contributors: `bun install` at the repo root after pulling main. The previous `cd tools/review-ui && npm install` flow is gone — `packages/review-ui/server` and `packages/review-ui/web` are now leaf bun workspaces hoisted into the root `node_modules`.
3. External scripts that referenced `tools/review-ui/**` paths must repoint to `packages/review-ui/**`.

**Auto-adoption**:

- Non-breaking — `/prove:review-ui` UX is unchanged (same flags, env vars, `.claude/.prove.json` `tools.acb.config.review_ui_{port,image,tag}` keys).
- No `PROVE_SCHEMA` or `CURRENT_SCHEMA_VERSION` bump; on-disk `.prove/prove.db` shape is unchanged.
- `v1.0.0` remains reserved for phase 12 (scrum) per `.prove/decisions/2026-04-21-typescript-cli-unification.md`.

---

## v0.42.0 — installer package + `prove install` CLI + binary release workflow

Phase 10 of the TypeScript CLI unification (see `.prove/decisions/2026-04-23-phase-10-installer.md`). A new `packages/installer/` workspace package centralises plugin-root resolution, settings-hook wiring, and `.prove.json` bootstrap. The `prove install <action>` CLI topic (`init`, `init-hooks`, `init-config`, `doctor`, `upgrade`) replaces the legacy bash installers; dev checkouts and compiled binaries are handled by a single `detectMode` helper. `scripts/install.sh` is now a 30-line bootstrap that fetches a platform-specific binary from GitHub Releases and hands off to `prove install init`. `/prove:init` delegates stack detection + `.prove.json` emission to `prove install init-config`; the AskUserQuestion UX for scope and validator customization is preserved.

**Added**:

- `packages/installer/` workspace package: `detectMode`, `resolvePluginRoot`, `resolveBinaryPath`, `writeSettingsHooks` (idempotent `.claude/settings.json` merge via `_tool` markers), `bootstrapProveJson` (stack-detected `.prove.json` emission)
- `prove install <action>` CLI topic: `init`, `init-hooks`, `init-config`, `doctor`, `upgrade` — unified dispatch over the installer package
- `.github/workflows/release.yml`: four-target `bun build --compile` matrix (`darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`) uploading artifacts to GitHub Releases on tag push
- `packages/cli/src/topics/schema/detect.ts`: ported `scripts/init-config.sh` detector logic to TS with public `detectValidators(cwd)` + `DETECTED_VALIDATOR_NAMES` exports, subpath-exported via `@claude-prove/cli/schema/detect` and consumed by `prove install init-config`

**Removed**:

- `scripts/init-config.sh` — detection logic ported to `packages/cli/src/topics/schema/detect.ts`, consumed by `prove install init-config`
- `scripts/setup-tools.sh` — superseded by `/prove:tools` command + `tools/registry.py`
- `scripts/hooks/{post-tool-use,session-stop,subagent-stop}.sh` — hook dispatch now lives under `prove <topic> hook <event>`
- Legacy 170-line `scripts/install.sh` — replaced with a 30-line bootstrap that fetches the compiled binary and hands off to `prove install init`

**Behavior changes**:

- `/prove:init` slash command delegates stack detection + `.prove.json` emission to `prove install init-config`. Dev checkouts run `bun run <pluginRoot>/packages/cli/bin/run.ts install init-config`; installed users run `prove install init-config` from PATH.
- `.claude/settings.json` hook command paths are owned by `writeSettingsHooks` and resolved by `detectMode` — dev checkouts use `bun run <pluginRoot>/packages/cli/bin/run.ts <topic> hook <event>`; installed users use the compiled binary path (`~/.local/bin/prove` by default).
- First release to ship binary artifacts: `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`.

**Migration**:

1. Dev users (plugin authors): no action required — `detectMode` keeps hook commands as `bun run <repo>/packages/cli/bin/run.ts ...`.
2. Installed users: run `/prove:update` — it invokes `prove install init --force` to rewrite any stale absolute paths in `.claude/settings.json` to the current install location.
3. New users: `curl -fsSL https://raw.githubusercontent.com/mjmorales/claude-prove/main/scripts/install.sh | bash` — fetches the platform binary, runs `prove install init` to wire hooks and bootstrap `.prove.json`, and optionally registers with Claude Code via `claude plugin install`.

**Auto-adoption**:

- Non-breaking: all reads and writes remain schema-compatible with v0.41.0 `.prove.json` and `.claude/settings.json` shapes. No `PROVE_SCHEMA` or `CURRENT_SCHEMA_VERSION` bump was required for phase 10.
- `v1.0.0` remains reserved for phase 12 (scrum) per `.prove/decisions/2026-04-21-typescript-cli-unification.md`.

---

## v0.41.0 — ACB ported to TypeScript + unified store migration

Phase 9 of the TypeScript CLI unification (see `.prove/decisions/2026-04-21-typescript-cli-unification.md`) combined with ACB v2.1 of the unified-store plan (see `.prove/decisions/2026-04-21-unified-prove-store.md`). The Python `tools/acb/` module is retired; the Agent Change Brief assembler, PostToolUse hook, SQLite schema, and CLI now run through `prove acb` backed by `packages/cli/src/topics/acb/`. ACB storage moved from the standalone `.prove/acb.db` to the unified `.prove/prove.db` with `acb_*`-prefixed tables; the first `prove acb` invocation transparently auto-imports any legacy rows and deletes `.prove/acb.db`.

**Removed**:

- `tools/acb/` (all Python sources, tests, `tool.json`, `templates/`, `__main__.py`, `hook.py`, `assembler.py`, `store.py`, `schemas.py`, `_git.py`, `_slug.py`)
- Standalone `.prove/acb.db` — auto-imported into `.prove/prove.db` on first `prove acb` call, then deleted
- `python3 -m tools.acb ...` / `python3 $PLUGIN_DIR/tools/acb/hook.py ...` invocation paths
- `tools/acb` lint-ignore entry in `biome.json`

**Added**:

- `prove acb save-manifest [--branch B] [--sha S] [--slug G] [--workspace-root W]` — reads intent manifest JSON on stdin, validates, inserts into `.prove/prove.db`
- `prove acb assemble [--branch B] [--base main]` — merges branch manifests into an ACB document, upserts `acb_acb_documents` row, clears manifests
- `prove acb hook post-commit --workspace-root W` — Claude Code PostToolUse hook (reads payload on stdin)
- `prove acb migrate-legacy-db [--workspace-root W]` — user-triggered legacy-db importer (auto-invoke runs transparently on first non-migrate call)
- `packages/cli/src/topics/acb/` — full TS port with bun test coverage
- `packages/shared/src/{git,run-slug}.ts` — cross-topic helpers (git subprocess wrappers, 5-tier run-slug resolver) extracted from `tools/acb/_git.py` and `tools/acb/_slug.py`
- `acb` domain in the unified store — `acb_manifests`, `acb_acb_documents`, `acb_review_state` tables registered via `@claude-prove/store`

**Migration**:

1. Run `/prove:update` — rewrites `.claude/settings.json` PostToolUse hook command to the TS form. No other manual steps.
2. The next `prove acb save-manifest`, `prove acb assemble`, or `prove acb hook post-commit` invocation auto-imports `.prove/acb.db` into `.prove/prove.db` and deletes the legacy file. One stderr line announces the import count.
3. If the review UI container is running, restart it so the server process opens the new `.prove/prove.db`. The HTTP/response shapes are unchanged.
4. External scripts that invoked `python3 -m tools.acb save-manifest` must switch to `prove acb save-manifest` (same stdin contract).

**Auto-adoption**:

- `.claude/settings.json` hook swap is applied by `/prove:update`.
- Legacy-db import runs transparently; no user action required.
- Review UI reads the new db on next container restart.

---

## v0.40.0 — PCD ported to TypeScript

Phase 7 of the TypeScript CLI unification (see `.prove/decisions/2026-04-21-typescript-cli-unification.md`). The Python `tools/pcd/` module is retired; the Progressive Context Distillation deterministic rounds (structural map, collapse, batch formation) now run through `prove pcd` backed by `packages/cli/src/topics/pcd/`. Every steward skill directive that previously invoked `python3 $PLUGIN_DIR/tools/pcd/__main__.py ...` now routes through the TS CLI.

**Removed**:

- `tools/pcd/` (all Python sources, tests, `tool.json`, `README.md`, `__main__.py`, `__init__.py`, `schemas.py`, `import_parser.py`, `structural_map.py`, `collapse.py`, `batch_former.py`)
- `python3 $PLUGIN_DIR/tools/pcd/__main__.py <cmd>` invocation path
- `tools/pcd` lint-ignore entry in `biome.json`

**Added**:

- `prove pcd map [--project-root <path>] [--scope <files>]` — Round 0a structural map
- `prove pcd collapse [--project-root <path>] [--token-budget <n>]` — triage manifest compression
- `prove pcd batch [--project-root <path>] [--max-files <n>]` — Round 2 batch formation
- `prove pcd status [--project-root <path>]` — artifact presence check
- `packages/cli/src/topics/pcd/` — full TS port with bun test coverage and byte-parity fixtures under `__fixtures__/{structural-map,collapse,batch-former}/python-captures/`

**Migration**:

1. Run `/prove:update` — picks up the new CLI. No hook changes needed; no on-disk artifact migration (`.prove/steward/pcd/*.json` schemas unchanged).
2. If external scripts call `python3 tools/pcd/__main__.py …` directly, rewrite to `prove pcd <map|collapse|batch|status>`.
3. Steward skill invocations (`skills/steward/SKILL.md`, `skills/steward-review/SKILL.md`, `skills/auto-steward/SKILL.md`) and `agents/pcd/README-pcd.md` already carry the new `prove pcd` form — no user action required.

**Auto-adoption**: None required — steward skill directives were rewritten in place. Existing artifact files under `.prove/steward/pcd/` are read back unchanged by the TS CLI.

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
