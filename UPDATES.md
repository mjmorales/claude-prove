# Plugin Updates

Migration guide for features that require user action after updating the plugin. Run `/prove:update` to apply these automatically, or follow the manual steps below.

For the full commit-level changelog, see [CHANGELOG.md](CHANGELOG.md).

---

## v2.4.0 — Decisions persisted in `prove.db`

ADR content now survives file `rm`, `git mv`, archive sweeps, and reclones without `.prove/`. Previously, `scrum_events(kind='decision_linked')` carried only `{ decision_path }` — if the file disappeared the rationale was unrecoverable from the DB alone. This release adds a `scrum_decisions` table (populated on `link-decision` and during brainstorm Phase 4) that owns a durable snapshot of every decision, keyed by filename slug with a sha256 `content_sha` for drift tracking. Event payloads become `{ decision_id, decision_path }`; readers prefer `decision_id` and fall back to `decision_path` for legacy rows. Full rationale: `.prove/decisions/2026-04-24-decision-persistence.md`.

**Changed**:

- `packages/cli/src/topics/scrum/schemas.ts` — scrum domain migration v2 adds `scrum_decisions` (id, title, topic, status, content, source_path, content_sha, recorded_at, recorded_by_agent) + indexes on `topic` and `status`.
- `packages/cli/src/topics/scrum/store.ts` — `recordDecision(input)` / `getDecision(id)` / `listDecisions(filter)` with upsert semantics on id and `content_sha = sha256(content)` for drift detection.
- `packages/cli/src/topics/scrum/cli/decision-cmd.ts` (new) — CLI subcommand tree exposing the store via `record | get | list | recover`.
- `packages/cli/src/topics/scrum.ts` — wires the `decision` subcommand and the `--from-git` flag into the scrum dispatcher.
- `packages/cli/src/topics/scrum/cli/task-cmd.ts` — `link-decision` now reads the file, auto-records the decision if absent, and appends `{ decision_id, decision_path }` payloads. Legacy path-only payloads still parse (reader prefers `decision_id`, falls back to `decision_path`).
- `packages/cli/src/topics/scrum/reconcile.ts` — `collectDecisions` reads both legacy `{ path, title }` and new `{ decision_id, decision_path }` event payloads.
- `packages/review-ui/server/src/decisions.ts` + `routes/prove.ts` — `/api/decisions/:id` resolves DB-first via scrum store, falls back to `.prove/decisions/<id>.md` on miss. Response gains an additive `source: 'db' | 'disk'` field.
- `skills/brainstorm/SKILL.md` — Phase 4 now writes the file AND calls `claude-prove scrum decision record`, halts on record failure, reports file path + decision id.
- `agents/spec-writer.md` — discovers prior decisions via `claude-prove scrum decision list --human` and `scrum decision get <id>` instead of globbing `.prove/decisions/`.

**New CLI**:

- `claude-prove scrum decision record <path>` — parse markdown (H1 title, `**Topic**:` / `**Status**:` lines, filename slug = id) and upsert. Re-records are idempotent — same `content_sha` when content unchanged; `recorded_at` refreshes.
- `claude-prove scrum decision get <id>` — emit content byte-for-byte to stdout.
- `claude-prove scrum decision list [--topic T] [--status S] [--human]` — JSON array or fixed-width table.
- `claude-prove scrum decision recover --from-git [--workspace-root <path>]` — scan `git log --all --reverse` for every blob version of `.prove/decisions/*.md` and upsert. Idempotent.

**Migration**:

- Schema auto-migrates on next scrum invocation — `@claude-prove/store` runs migration v2 transactionally when the store is opened.
- Existing `decision_linked` events with path-only payload (`{ decision_path }`) keep working; readers prefer the new `decision_id` and fall back to `decision_path` for legacy rows.
- `CURRENT_SCHEMA_VERSION` in `packages/cli/src/topics/schema/schemas.ts` is NOT incremented — this is a scrum-domain migration via `@claude-prove/store`, not a `.claude/.prove.json` config-schema change.
- **Optional backfill**: if your project commits `.prove/decisions/*.md` to git (most do not — `.prove/` is typically gitignored), run `claude-prove scrum decision recover --from-git` to populate the store from git history. In repositories where `.prove/` is gitignored (including this plugin repo), the verb runs cleanly and reports `recovered: 0` — there is nothing in history to recover.

**Auto-adoption**:

- Schema migration: automatic on next store open.
- Brainstorm skill: Phase 4 now persists to DB; users of `/prove:brainstorm` see the new persistence on their next session.
- Review UI: DB-first resolution kicks in once users restart the server after the upgrade; pre-upgrade bookmarks continue to work via disk fallback.
- No `.claude/.prove.json` fields added or changed.

**ADR**: `.prove/decisions/2026-04-24-decision-persistence.md` (scrum task `persist-decisions-in-prove-db-mod1lkx3`).

---

## v2.3.1 — ACB save-manifest auto-injects missing `timestamp`

The PostToolUse hook's manifest prompt template includes a `timestamp` field, but agents occasionally drop it when filling in `intent_groups` — producing a hard schema failure (`Error: invalid manifest: Missing required field: timestamp`) that blocks the commit flow. The fix mirrors the existing `commit_sha` pinning in `save-manifest-cmd.ts`: if the agent omits (or empties) `timestamp`, the CLI injects a UTC ISO-seconds value server-side using the same `isoSeconds()` helper the hook already uses for its prompt.

**Changed**:

- `packages/cli/src/topics/acb/cli/save-manifest-cmd.ts` — auto-inject `timestamp` via `isoSeconds()` when missing/null/empty. `commit_sha` pinning behavior is unchanged; only ops metadata is coerced, so agent-judgment fields (`acb_manifest_version`, `intent_groups`) still fail validation when missing.
- `packages/cli/src/topics/acb/hook.ts` — exported `isoSeconds` so both the hook prompt template and the save-manifest CLI share the exact UTC-seconds format contract.

**Migration**:

- No schema changes, no config changes. Auto-adopts on upgrade — existing manifests on disk are untouched; only new `save-manifest` invocations benefit.
- The validator itself (`schemas.ts::validateManifest`) still flags `timestamp` as a required field; only the CLI wrapper injects a default before calling it. Direct `validateManifest` callers (tests, external consumers) see unchanged behavior.

---

## v2.2.1 — Scrum CLI surface + importer precision + milestone reassignment + binary-rename follow-ups + next-ready scoring (issue #18)

Closes the seven gaps filed in issue #16, adds the milestone-reassignment CLI path filed in issue #17, tightens `scrum next-ready` ranking per issue #18 (closes #18), and finishes the trailing consumers of the v1.2.0 `prove` → `claude-prove` binary rename that were left half-done in the working tree (`install doctor`, `install upgrade`, version bump script, CI release workflow, and runtime PATH checks in `commands/review-ui.md` + `skills/task/scripts/gather-context.sh`).

### Scrum task milestone reassignment — issue #17

Backlog grooming needed a CLI path for moving tasks between milestones without dropping to raw SQL. Added `ScrumStore.updateTaskMilestone` + a `scrum task move` action that emits a `milestone_changed` event for every reassignment.

**Added**:

- `claude-prove scrum task move <task-id> --milestone <milestone-id>` — reassigns a task's milestone and emits a `milestone_changed` event with `{from, to}` payload. Rejects unknown milestone/task ids with exit 1.
- `--unassign` flag (and `--milestone=""`) — clears `milestone_id` to `NULL` on the task row. Both forms emit the same `milestone_changed` event with `to: null`. When both `--milestone` and `--unassign` are supplied, `--unassign` wins (explicit clear beats implicit target).
- `ScrumStore.updateTaskMilestone(id, nextMilestoneId, agent?)` — transaction-wrapped mirror of `updateTaskStatus`. Validates task existence, validates target milestone when non-null, updates row + inserts `scrum_events` row + bumps `last_event_at` in one transaction. No-ops silently when target equals current.
- `EventKind` union extended with `'milestone_changed'` in `packages/cli/src/topics/scrum/types.ts`.
- Closed-milestone safety: moving a task into a milestone whose status is `closed` succeeds but writes a one-line warning to stderr (exit 0 preserved) — operators re-opening scope should not be blocked.
- `scrum` registered as a commit scope in `.claude/.prove.json` alongside the existing `packages` / `agents` / etc. scopes — matches scrum's first-class domain status (dedicated CLI topic, hook integration, `/scrum` slash command).

**Migration**:

- No schema changes. The `scrum_events.kind` column has no CHECK constraint, so older databases stay forward-compatible; rolling back the binary leaves existing `milestone_changed` rows untouched (readers ignore unknown kinds).
- Operators patching around the missing path with `sqlite3 UPDATE scrum_tasks SET milestone_id = ? WHERE id = ?` can now switch to `claude-prove scrum task move <id> --milestone <mid>` (or `--unassign`) — the CLI emits the event row the raw `UPDATE` was bypassing.
- `scrum-master` agent can drive bulk grooming (close M4 → reassign 46 tasks into M5/M6/M7) by looping single `move` invocations.

### Scrum CLI — issue #16

The scrum CLI gains the status-transition and soft-delete actions the operator-facing surface was missing, a dedicated `alerts` subcommand matches the `/prove:scrum` routing table, the status summary stops undercounting closed milestones, and the importer rejects prose/dep-notes, dedupes ROADMAP↔BACKLOG ICE entries, and lifts referenced milestones into first-class rows.

**Added**:

- `claude-prove scrum task status <id> <new-status>` — drive a task through the lifecycle from the CLI; rejects invalid transitions and unknown statuses.
- `claude-prove scrum task delete <id>` — soft-delete via `softDeleteTask`; removed tasks stop showing up in `task list`.
- `claude-prove scrum alerts [--human] [--stalled-after-days N]` — aggregates `stalled_wip` (in_progress/review tasks whose `last_event_at` exceeds the threshold, default 7d) and `orphan_runs` (directories under `.prove/runs/<branch>/<slug>/` with no matching `scrum_run_links` row). Stdout JSON for agents, `--human` table for operators. Exit 0 whether or not alerts are present — this is a report, not a gate.
- `status` snapshot now carries `total_milestones` alongside the existing `milestones` array; the `--human` table renders `Active milestones (N of M total)` and the stderr summary reads `N/M active milestones`. Resolves the undercount surprise filed in #16.4.
- Importer noise filter: bullets ending in `:`, bare `**Header**` rows, and dependency prose (`/\b(all\s+)?depend(s|ed)?\s+on\b/i`, `see also:`, `note:`) are dropped from both ROADMAP and BACKLOG. Fixes the "M1 capstone" and "parser items all depend on AST node type 9" false positives.
- Importer ICE dedup: ROADMAP tasks with an `ICE <n>` token register the number; matching BACKLOG entries are skipped as duplicates rather than creating parallel records.
- Importer milestone inference: `## M<n>` anchors are recognized alongside the canonical `## Milestone:` form, and any task title containing a `M<n>` token creates a planned milestone placeholder when none was declared. All imported tasks now carry a `milestone_id` whenever one is inferable, which restores the milestone component of `next-ready` scoring.

**Changed**:

- `commands/scrum.md` routing table: `alerts` is a direct CLI passthrough (`claude-prove scrum alerts --human`) rather than an agent delegation. Matches `init|status|next`.
- `agents/scrum-master.md`: hook-invoked digests pull stalled-WIP + orphan-run signal from `claude-prove scrum alerts` instead of re-deriving it. Frontmatter description + interactive routing no longer advertise `alerts` — the agent reaches for it when useful but is no longer the only entry point.
- `claude-prove scrum task` error message now lists the full action set (`create | show | list | tag | link-decision | status | delete`).

**Migration**:

- No schema changes. All state lives in the existing `scrum_tasks`, `scrum_milestones`, and `scrum_run_links` tables.
- Operators who patched around the missing CLI by importing `openScrumStore` directly can now switch to the CLI surface:
  - `updateTaskStatus(id, s)` → `claude-prove scrum task status <id> <s>`
  - `softDeleteTask(id)` → `claude-prove scrum task delete <id>`
  - `createMilestone(...)` for inferred placeholders happens automatically during `claude-prove scrum init`.
- Projects that previously ran `claude-prove scrum init` against a planning tree with prose-as-task noise, ICE duplicates, or unreferenced milestones should re-run the importer against a fresh `.prove/prove.db` (or use `claude-prove scrum task delete` to trim the existing seed). The importer itself is still idempotent and short-circuits when any tasks exist.

### Binary-rename follow-ups

Finishes the trailing consumers of the `prove` → `claude-prove` rename shipped in v1.2.0.

**Changed**:

- `packages/cli/src/topics/install/upgrade.ts`: `BINARY_NAME` = `claude-prove`; release asset URL is now `${PROVE_RELEASE_URL_BASE}/claude-prove-<target>` (default: GitHub Releases). Docstrings and the concurrency-safety comment updated accordingly.
- `packages/cli/src/topics/install/doctor.ts`: `binary-on-path` check now looks for `claude-prove` on `$PATH`; fix hints reference `claude-prove install upgrade` (and the install-from-source fallback).
- `commands/doctor.md`: new §2.0 documenting the `claude-prove binary on PATH` check with pass/warn/fail states and fix hints for both stock installs and dev checkouts.
- `packages/cli/bin/run.ts`: `cac('prove')` → `cac('claude-prove')` so `claude-prove --help` prints the correct program name.
- `scripts/bump-version.sh`: also rewrites `packages/cli/package.json` → `version` on each bump. Without this, `claude-prove --version` reported whatever was last committed (historically `0.0.0`) because cac reads `pjson.version` at bundle time.
- `.github/workflows/release.yml`: `build-release-binary` now runs in-workflow via `needs: release` instead of relying on the `tags: ['v*']` trigger. The tag-trigger approach silently no-op'd because the release commit carries `[skip ci]`, which GitHub honors for the tag push pointing at that commit too. Binaries again upload against the tag the release job just cut.
- `scripts/install.sh`: fallback git-clone path now `git fetch && reset --hard` refreshes an existing `~/.claude/plugins/prove` checkout instead of trusting it — stale pre-workspace layouts don't have `packages/cli/bin/run.ts` and would silently fail with "Module not found".
- `commands/review-ui.md` precondition check + `skills/task/scripts/gather-context.sh` fallback now probe `command -v claude-prove` instead of `command -v prove` (the latter now resolves to the Perl TAP runner).
- `packages/cli/test/install-upgrade.test.ts` + `install-doctor.test.ts`: updated fixtures to expect `claude-prove-<target>` release URLs and destination filenames.
- Swept every remaining `prove <subcommand>` reference across docs, CLI source (JSDoc + help + error prefixes), test describe labels, agent definitions, skills, and `UPDATES.md` migration snippets. Historical `prove` mentions that describe the rename itself (`bin."prove"`, `~/.local/bin/prove`, `command -v prove`) are preserved intentionally.

**Removed**:

- `packages/cli/src/topics/install/doctor.ts.bak` — stray backup from the rename iteration.

**Migration**:

- No end-user migration beyond re-running `scripts/install.sh` (or `claude-prove install upgrade` once the new binary is on PATH). The CI release-binary pipeline will self-heal on the next tag cut now that `build-release-binary` runs in-workflow.

### Built-in CLI reference in the CLAUDE.md managed block

The composer now injects `@$PLUGIN_DIR/references/claude-prove-reference.md` as a plugin-level default reference whenever `.claude/.prove.json` exists. The reference is a CLI-only cheat sheet (topics, actions, flags, canonical invocations) sized for always-on context (~1.7K tokens) and optimized via `llm-prompt-engineer` to maximize first-try invocation correctness.

**Added**:

- `references/claude-prove-reference.md` — `claude-prove` CLI reference covering all 14 topics, sized as an always-on CLAUDE.md import.
- `PLUGIN_DEFAULT_REFERENCES` constant in `packages/cli/src/topics/claude-md/composer.ts`; `mergeReferences()` prepends built-ins and dedupes against user-configured references by path.

**Changed**:

- `packages/cli/src/topics/claude-md/composer.ts`: References section renders whenever `prove_config.exists` is true (previously required at least one user-configured reference).
- `commands/init.md` Step 7 and `commands/update.md` Step 5: bundled-reference scans now exclude `claude-prove-reference.md` (it's a built-in, not opt-in).
- Golden fixture `packages/cli/src/topics/claude-md/__fixtures__/golden/self-CLAUDE.md`: includes the built-in reference first in the References section.

**Migration**:

- Auto-adopted on next `/prove:update` (Step 8 regenerates CLAUDE.md). Manual: `claude-prove claude-md generate --project-root "$(pwd)" --plugin-dir "$PLUGIN_DIR"`.
- If you previously added `claude-prove-reference.md` to your `.claude/.prove.json` by hand, the composer silently dedupes it — safe to leave or remove.

### Milestone lifecycle transitions — issue #18

Planned milestones now have an explicit `active` state with CLI transitions, so operators can promote scope into focus without hand-editing the DB. `closed` remains terminal (reopen reverts to `planned`, not `active`).

**Added**:

- `claude-prove scrum milestone <id> activate` — transitions `planned` → `active`. Idempotent on already-active rows; rejects activation from `closed` (reopen first).
- `claude-prove scrum milestone <id> reopen` — transitions `closed` → `planned`. Operators re-enter the lifecycle from `planned` and re-activate explicitly, preserving the audit trail.
- `ScrumStore.updateMilestoneStatus(id, nextStatus)` — transaction-wrapped transitions with explicit allow-list: `planned↔active`, `planned→closed`, `active→closed`, `closed→planned`. Rejects other transitions with a descriptive error.

**Migration**:

- No schema changes. Existing `scrum_milestones` rows with `status = 'planned'` stay planned until activated; rows with `status = 'active'` are unaffected.

### Weighted milestone boost in `next-ready` — issue #18

`scrum next-ready` now weights milestone contribution by lifecycle status instead of treating all milestone-linked tasks equally. Active milestones (or an explicit `--milestone` filter) get full credit, planned milestones get half credit so they rank below in-focus work but above unlinked tasks, and closed/unlinked tasks contribute zero.

**Changed**:

- `milestone_boost` in the `next-ready` score is now `1.0` for active/filter-matched milestones, `0.5` for planned milestones, and `0` for closed or unlinked tasks. Activating a planned milestone automatically promotes its tasks from `0.5` → `1.0` on the next ranking — no manual re-ranking required.

**Migration**:

- Auto-adopted. Ranking shifts on the next `claude-prove scrum next-ready` invocation; operators who relied on planned milestones outranking active ones (unusual) should run `milestone activate` on the intended focus scope.

### Negative tag scoring in `next-ready` — issue #18

`next-ready` now demotes explicitly-suppressed tasks instead of only boosting positive signals. Tasks tagged `deferred`, `blocked`, or `wontfix` contribute `-1` per tag to `tag_boost`, ranking them below neutral peers so the top of the queue stays free of known-suppressed work.

**Added**:

- `DEFER_TAGS = { deferred, blocked, wontfix }` constant in the `next-ready` scorer. Each defer tag subtracts `1` from `tag_boost`; positive-signal tags continue to contribute their existing boost.

**Migration**:

- Auto-adopted. Operators using non-standard suppression vocabulary (e.g. `on-hold`, `paused`) should re-tag affected tasks with one of the canonical defer tags, or continue to rely on status transitions (`in_review`, `blocked`) for suppression.

---

## v1.2.0 — CLI binary renamed to `claude-prove`

The compiled CLI binary is renamed from `prove` to `claude-prove` to end the naming collision with `/usr/bin/prove` (the Perl TAP test runner shipped with macOS and most Linux distros). Slash commands (`/prove:*`), plugin name, marketplace ID, and source paths are unchanged. Only the binary on `$PATH` and the release asset filenames move.

**Changed**:

- `packages/cli/package.json`: `bin."prove"` → `bin."claude-prove"`. `bun install` / `bun link` now exposes the CLI as `claude-prove`.
- `packages/installer/src/resolve-binary-path.ts`: compiled-mode default is `~/.local/bin/claude-prove` (was `~/.local/bin/prove`). `writeSettingsHooks` picks up the new path on the next `claude-prove install init --force` run.
- `.github/workflows/release.yml` + `ci.yml`: release artifacts are `claude-prove-{darwin-arm64,darwin-x64,linux-x64,linux-arm64}` (was `prove-*`). `bun build --compile` emits `claude-prove` before the matrix rename step.
- `scripts/install.sh`: fetches `claude-prove-${TARGET}` from Releases, writes `${PREFIX}/claude-prove`, and best-effort deletes any stale `${PREFIX}/prove` binary left over from v1.1.x installs. Fallback git-clone path unchanged (hands off to `bun run ...` regardless of binary name).

**Behavior changes**:

- Users who previously had `~/.local/bin/prove` on PATH must switch to `claude-prove`. Shell aliases or scripts that shelled out to `prove <subcommand>` need to be updated — `prove` now resolves to the Perl TAP runner again (or errors if not installed).
- Dev checkouts are unaffected: `.claude/settings.json` hooks generated in dev mode still call `bun run <pluginRoot>/packages/cli/bin/run.ts ...` directly — never touch `$PATH`.

**Migration**:

1. Installed users: re-run `curl -fsSL https://raw.githubusercontent.com/mjmorales/claude-prove/main/scripts/install.sh | bash`. The script deletes the legacy `~/.local/bin/prove` binary, writes `~/.local/bin/claude-prove`, and invokes `claude-prove install init --force` to rewrite `.claude/settings.json` hook paths.
2. Alternatively: `/prove:update` inside Claude Code calls `claude-prove install init --force` via the installed binary — works once you've replaced the binary.
3. Dev users: no action needed.

**Auto-adoption**:

- No schema changes; `PROVE_SCHEMA` / `CURRENT_SCHEMA_VERSION` unchanged.
- Hooks in `.claude/settings.json` are idempotent via `_tool` markers — re-running `install init --force` rewrites the prefix in-place without duplicating entries.

---

## v1.1.0 — Review-UI XSS hardening + broad code-quality pass

Security fix plus a wide steward sweep across the CLI, installer, review-UI client, review-UI server, and shared packages. User-visible behavior change: markdown content rendered by the review-UI is now sanitized through `DOMPurify`, so script/style/event-handler vectors in manifest notes, decisions, or commit bodies no longer execute in the reviewer's browser.

**Added**:

- DOMPurify sanitation in the review-UI Markdown component. Run artifacts reach this component through manifest notes and decision records; anything that looked like HTML used to be injected verbatim via `dangerouslySetInnerHTML`. Adds `isomorphic-dompurify` to `packages/review-ui/web/` and its jsdom-based transitive chain.
- `resolveBaselineBranch(repoRoot)` on the review-UI server. Repositories whose default branch is not `main` (e.g. `master`, `trunk`, `develop`) now get correct diff ranges instead of always comparing against a hard-coded `"main"`.
- Node.js fallback for the shared file-walker's git helpers. The Node-based review-UI server can now consume the same walker the Bun-native CLI does; previously a `Bun.spawnSync` reference blew up under Node.

**Changed**:

- ACB verdict vocabulary is canonical across the CLI manifest schema and the review-UI HTTP/DB contract. Legacy dialect values (`approved`, `discuss`) are rewritten by acb migration v3 at DB boundary, and the review-UI HTTP endpoint only accepts canonical (`accepted`, `needs_discussion`, `rework`) strings going forward.
- Review-UI SSE: one `EventSource` per tab via a reference-counted bus (`sseBus.ts`), instead of one per hook. Heartbeat-driven staleness checks no longer tear down the connection on every activity signal.
- Review-UI server SSE route: tolerant resource-cleanup handshake. Clients that disconnect mid-setup no longer leave dangling watcher + heartbeat handles.
- Run-state CLI dispatcher split into per-action sub-dispatchers behind a `Positionals` bundle; handlers destructure only the slots they use.
- Scrum store routes every dynamic SQL shape through the prep-statement cache; `nextReadyQuery` batches tag-boost lookups and memoizes per-root `computeUnblockDepth` BFS within an invocation.
- Install CLI: `doctor` now verifies every entry in a hook block (not just `hooks[0]`); `upgrade` rejects non-binary content-types to guard against CDN HTML error pages overwriting the installed binary; `init-config` surfaces corrupt `.prove.json` with a pointed error instead of crashing.
- Installer bootstrap writes to a pid-scoped `.tmp` path so concurrent bootstraps can't race on the same tempfile.
- Release workflow reads `plugin.json` as the authoritative current version instead of the latest git tag. Hand-rolled `chore(release):` commits without pushed tags no longer cause the workflow to silently revert `plugin.json` to an older version.

**Removed**:

- Legacy `registerDoctor(cli)` shim from the install topic — `install <action>` dispatch is the canonical entrypoint.
- `deepCopy` alias in `run-state/state.ts` — every call site now uses canonical `deepCloneJson`.
- Dead post-marshal JSON re-parse sanity check in `write-settings-hooks.ts`.

**Migration**:

1. No schema change; no `/prove:update` action required.
2. If you have uncommitted review-UI code that sends `approved` or `discuss` verdicts to `POST /api/review/verdict/...`, switch to `accepted` / `needs_discussion`. The server rejects legacy dialect values at the HTTP edge — migration lives at the DB read boundary, not HTTP ingress.
3. The `acb` domain in `.prove/prove.db` gains a v3 migration that rewrites legacy verdict strings in-place on first CLI/server startup after upgrade. No manual action.

**Auto-adoption**: Plugin consumers pick up the security fix on next plugin update. The review-UI Docker image ships on its own release channel (GHCR) and will include DOMPurify when its image tag rolls forward.

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

- `claude-prove notify dispatch <event>` — reporter event dispatcher; dedupes via `state.json.dispatch.dispatched[]` through the run_state API, fires matching reporter commands with the `PROVE_*` env surface, prefixes each reporter's combined stdout/stderr with `  [<name>] `. Best-effort: always exits 0.
- `claude-prove notify test [event]` — notification pipeline probe; reports match counts and invokes `runNotifyDispatch` with synthesized test env.
- `claude-prove orchestrator task-prompt --run-dir --task-id --project-root [--worktree]` — emits the worktree implementation-agent prompt markdown directly (no sentinel+awk indirection).
- `claude-prove orchestrator review-prompt --run-dir --task-id --worktree --base-branch` — emits the principal-architect review prompt; runs `git diff <base>...HEAD` inside the worktree via `child_process`.
- `claude-prove claude-md validators [--project-root]` — emits `- <phase>: \`<command>\`` lines from `.claude/.prove.json`; plugin-dir-less fallback used by `skills/handoff/scripts/gather-context.sh`.
- 19 parity tests covering the new CLI surface (validators output, notify dispatch dedup + reporter firing, task/review-prompt rendering).

**Changed**:

- `skills/orchestrator/SKILL.md` — the `generate-{task,review}-prompt.sh` bash invocations are now `bun run "$PLUGIN_DIR/packages/cli/bin/run.ts" orchestrator <task-prompt|review-prompt> ...` with explicit flags.
- `skills/handoff/scripts/gather-context.sh` — discovery block calls `claude-prove claude-md subagent-context` (primary) or `claude-prove claude-md validators` (fallback via `command -v prove`); no more inline python3 reading `.claude/.prove.json`.
- `commands/notify/notify-test.md` — invokes `claude-prove notify test` directly.
- `commands/doctor.md` — Tooling tier renumbered 2.1-2.4 (CAFI, Docker, Schema, Reporters); Step 2.1 Tool Registry Health and Step 2.6 Pack Symlink Health dropped; python3 → bun run for claude-md regen.
- `commands/init.md` — Step 7 (tool registry setup) dropped; subsequent steps renumbered 7-10; python3 → bun run for claude-md generate.
- `commands/update.md` — Step 5 subsection 3 (new-tools discovery) dropped; python3 → bun run for CLAUDE.md regen.
- Plugin version → `1.0.1`; CLAUDE.md managed-block version header → v1.0.1.

**Removed**:

- `scripts/dispatch-event.sh`, `scripts/notify-test.sh`, `skills/orchestrator/scripts/generate-task-prompt.sh`, `skills/orchestrator/scripts/generate-review-prompt.sh` — wholesale deletions; all callers migrated to `prove <topic>` subcommands.
- `commands/tools.md` + `/prove:tools` slash command — the underlying `tools/registry.py` pack registry was retired with the phase 11 tools/ deletion and has no TS replacement.

**Migration**:

1. Run `/prove:update` — refreshes the managed CLAUDE.md block to v1.0.1 and regenerates any scrum/ACB/run-state hook blocks if drift is detected. Schema version unchanged (still v5); no data migration required.
2. External automation that shelled out to `scripts/dispatch-event.sh`, `scripts/notify-test.sh`, or the two orchestrator prompt generators must migrate to `claude-prove notify dispatch|test` or `claude-prove orchestrator task-prompt|review-prompt` (same stdin/stdout contracts).
3. The `/prove:tools` slash command is gone. Tool install/remove/status have no replacement in v1.0.1 because the pack model itself was retired in phase 11; projects that installed community packs before the cutover should bundle them directly under `tools/<pack>/` and wire hooks manually if still needed.

**Auto-adoption**:

- Plugin version header auto-refreshes on first `/prove:update` after pull.
- New CLI subcommands are available immediately after pulling v1.0.1; callers in user-space skills/commands migrate at their own pace (the retired shell wrappers no longer exist, so stale callers fail loudly rather than silently).

---

## v1.0.0 — scrum + TypeScript unification complete

Cutover release. The TypeScript CLI unification (phases 6-11, see `.prove/decisions/2026-04-21-typescript-cli-unification.md`) is complete — every Python tool now runs through `prove <topic>` backed by `packages/cli/`. Phase 12 lands the scrum system top-to-bottom: schema, reconciler, hooks, CLI, agents, slash command, and read-only UI. From v1.0.0 forward, the public CLI shape is semver-stable: breaking changes require a major bump. See `.prove/decisions/2026-04-21-scrum-architecture.md` for the scrum architecture.

**Added**:

- Scrum system on `.prove/prove.db` (schema v5): `scrum_tasks`, `scrum_milestones`, `scrum_tags`, `scrum_task_tags`, `scrum_deps`, `scrum_run_links`, `scrum_context_bundles` — all managed through `claude-prove scrum` and reconciled by `packages/cli/src/topics/scrum/reconcile.ts`
- `/scrum` slash command — `init|status|next` as direct `claude-prove scrum` passthroughs; `task|milestone|tag|link|alerts` delegate to the `scrum-master` agent
- `claude-prove scrum` CLI topic — subcommands: `init`, `status`, `next-ready`, `task`, `milestone`, `tag`, `link-run`, `hook`
- `scrum-master` agent (model: sonnet) — operational: hook-invoked (SessionStart/SubagentStop/Stop) and user-invoked via `/scrum` routes; owns task-state transitions, dep-graph edits, run/decision linkage
- `product-visionary` agent (model: opus) — strategic: user-invoked only; owns milestone shaping, VISION.md alignment, macro dep-chain leverage
- `/scrum` UI routes under `packages/review-ui/web/src/routes/scrum/` — 5 read-only views (overview, tasks, milestones, dep-graph, alerts) served by `/api/scrum/*` GET endpoints
- `plan.json` `task_id` optional field — couples orchestrator runs to scrum tasks; surfaced as linked/unlinked runs in `/scrum alerts`
- `.claude/settings.json` scrum hooks — three entries tagged `_tool: "scrum"`: SessionStart (`startup|resume|compact`), SubagentStop, Stop — all invoking `claude-prove scrum hook <event>`

**Changed**:

- `.claude/.prove.json` schema v4 → v5 (adds `tools.scrum` block with `enabled` and `config.*` defaults). Auto-migrated via `/prove:update` or `claude-prove schema migrate --file .claude/.prove.json`; full v0-to-v5 chain is covered by `packages/cli/src/topics/schema/migrate.test.ts`
- `/prove:task-planner` now prompts for `task_id` when `tools.scrum.enabled` is true and surfaces `claude-prove scrum next-ready` as the picker source
- `commands/update.md` step 5 grew a **Scrum hooks** note: on schema v5+, `/prove:update` idempotently registers the three scrum hook entries in `.claude/settings.json` when they're missing

**Removed**:

- `tools/project-manager/` pack (wholesale) — superseded by the scrum CLI + agents. Legacy `planning/ROADMAP.md`, `planning/BACKLOG.md`, and `planning/ship-log.md` (if present in a consuming project) are absorbed by `/scrum init` on first run
- `product-owner` agent — replaced by `product-visionary` (opus; strategic scope, no transactional writes)

**Migration**:

1. Run `/prove:update` — applies the v4 → v5 schema migration, registers the three scrum hooks in `.claude/settings.json`, and refreshes the managed CLAUDE.md block.
2. Run `/scrum init` once — imports any legacy `planning/*` artifacts (`VISION.md`, `ROADMAP.md`, `BACKLOG.md`, `ship-log.md`) into scrum tasks/milestones/tags; safe to re-run.
3. Existing orchestrator plans without `task_id` keep working — they run unchanged and surface as unlinked-run alerts in `/scrum alerts`. Backfill via `claude-prove scrum link-run --run <slug> --task <id>` when desired.

**Auto-adoption**:

- v1.0.0 signals CLI-shape stability — `prove <topic> <subcommand>` contracts are covered by semver from this release forward.
- Scrum hooks land automatically via `/prove:update` (idempotent by `_tool: "scrum"` marker). No manual `.claude/settings.json` edits required.
- Plan files without `task_id` remain valid input for the orchestrator; scrum coupling is opt-in per run.

---

## v0.43.0 — review-ui absorbed into the monorepo + Bun Docker runtime

Phase 11 of the TypeScript CLI unification (see `.prove/decisions/2026-04-21-typescript-cli-unification.md`). The standalone `tools/review-ui/` tree is retired; the review UI now lives at `packages/review-ui/` as a bun workspace, the Docker image runs on `oven/bun:1-alpine` (322MB → 110MB, same `ghcr.io/mjmorales/claude-prove/review-ui` name), and `/prove:review-ui` has shed its `python3` dependency in favour of `claude-prove review-ui config | jq`. The web shell is now route-based: `/acb/*` (existing review flows) and a `/scrum` placeholder for phase 12. The server reads SQLite through `@claude-prove/store` (`bun:sqlite`) — `better-sqlite3` is gone.

**Added**:

- `packages/review-ui/` — monorepo home for the review UI as a bun workspace (`server/` + `web/` flattened into the root `workspaces` list)
- `claude-prove review-ui config [--cwd <path>]` — CLI subcommand that emits `{port, image, tag}` as a single JSON line with hardcoded defaults filled for missing keys, consumed by `/prove:review-ui`
- `react-router-dom` in the web shell with `/acb/*` (existing review flows) and `/scrum` (phase 12 placeholder) routes

**Changed**:

- Docker runtime: `node:20-alpine` → `oven/bun:1-alpine`; image name unchanged (`ghcr.io/mjmorales/claude-prove/review-ui`); image size 322MB → 110MB
- `.github/workflows/review-ui-image.yml` — path filter and build context repointed from `tools/review-ui/` to `packages/review-ui/`
- `/prove:review-ui` slash command — config resolution now uses `claude-prove review-ui config | jq -r '.<key>'` instead of `python3 -c 'import json...'`; the `python3` precondition is gone
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

## v0.42.0 — installer package + `claude-prove install` CLI + binary release workflow

Phase 10 of the TypeScript CLI unification (see `.prove/decisions/2026-04-23-phase-10-installer.md`). A new `packages/installer/` workspace package centralises plugin-root resolution, settings-hook wiring, and `.prove.json` bootstrap. The `claude-prove install <action>` CLI topic (`init`, `init-hooks`, `init-config`, `doctor`, `upgrade`) replaces the legacy bash installers; dev checkouts and compiled binaries are handled by a single `detectMode` helper. `scripts/install.sh` is now a 30-line bootstrap that fetches a platform-specific binary from GitHub Releases and hands off to `claude-prove install init`. `/prove:init` delegates stack detection + `.prove.json` emission to `claude-prove install init-config`; the AskUserQuestion UX for scope and validator customization is preserved.

**Added**:

- `packages/installer/` workspace package: `detectMode`, `resolvePluginRoot`, `resolveBinaryPath`, `writeSettingsHooks` (idempotent `.claude/settings.json` merge via `_tool` markers), `bootstrapProveJson` (stack-detected `.prove.json` emission)
- `claude-prove install <action>` CLI topic: `init`, `init-hooks`, `init-config`, `doctor`, `upgrade` — unified dispatch over the installer package
- `.github/workflows/release.yml`: four-target `bun build --compile` matrix (`darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`) uploading artifacts to GitHub Releases on tag push
- `packages/cli/src/topics/schema/detect.ts`: ported `scripts/init-config.sh` detector logic to TS with public `detectValidators(cwd)` + `DETECTED_VALIDATOR_NAMES` exports, subpath-exported via `@claude-prove/cli/schema/detect` and consumed by `claude-prove install init-config`

**Removed**:

- `scripts/init-config.sh` — detection logic ported to `packages/cli/src/topics/schema/detect.ts`, consumed by `claude-prove install init-config`
- `scripts/setup-tools.sh` — superseded by `/prove:tools` command + `tools/registry.py`
- `scripts/hooks/{post-tool-use,session-stop,subagent-stop}.sh` — hook dispatch now lives under `prove <topic> hook <event>`
- Legacy 170-line `scripts/install.sh` — replaced with a 30-line bootstrap that fetches the compiled binary and hands off to `claude-prove install init`

**Behavior changes**:

- `/prove:init` slash command delegates stack detection + `.prove.json` emission to `claude-prove install init-config`. Dev checkouts run `bun run <pluginRoot>/packages/cli/bin/run.ts install init-config`; installed users run `claude-prove install init-config` from PATH.
- `.claude/settings.json` hook command paths are owned by `writeSettingsHooks` and resolved by `detectMode` — dev checkouts use `bun run <pluginRoot>/packages/cli/bin/run.ts <topic> hook <event>`; installed users use the compiled binary path (`~/.local/bin/prove` before v1.2.0, `~/.local/bin/claude-prove` after).
- First release to ship binary artifacts: `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`.

**Migration**:

1. Dev users (plugin authors): no action required — `detectMode` keeps hook commands as `bun run <repo>/packages/cli/bin/run.ts ...`.
2. Installed users: run `/prove:update` — it invokes `claude-prove install init --force` to rewrite any stale absolute paths in `.claude/settings.json` to the current install location.
3. New users: `curl -fsSL https://raw.githubusercontent.com/mjmorales/claude-prove/main/scripts/install.sh | bash` — fetches the platform binary, runs `claude-prove install init` to wire hooks and bootstrap `.prove.json`, and optionally registers with Claude Code via `claude plugin install`.

**Auto-adoption**:

- Non-breaking: all reads and writes remain schema-compatible with v0.41.0 `.prove.json` and `.claude/settings.json` shapes. No `PROVE_SCHEMA` or `CURRENT_SCHEMA_VERSION` bump was required for phase 10.
- `v1.0.0` remains reserved for phase 12 (scrum) per `.prove/decisions/2026-04-21-typescript-cli-unification.md`.

---

## v0.41.0 — ACB ported to TypeScript + unified store migration

Phase 9 of the TypeScript CLI unification (see `.prove/decisions/2026-04-21-typescript-cli-unification.md`) combined with ACB v2.1 of the unified-store plan (see `.prove/decisions/2026-04-21-unified-prove-store.md`). The Python `tools/acb/` module is retired; the Agent Change Brief assembler, PostToolUse hook, SQLite schema, and CLI now run through `claude-prove acb` backed by `packages/cli/src/topics/acb/`. ACB storage moved from the standalone `.prove/acb.db` to the unified `.prove/prove.db` with `acb_*`-prefixed tables; the first `claude-prove acb` invocation transparently auto-imports any legacy rows and deletes `.prove/acb.db`.

**Removed**:

- `tools/acb/` (all Python sources, tests, `tool.json`, `templates/`, `__main__.py`, `hook.py`, `assembler.py`, `store.py`, `schemas.py`, `_git.py`, `_slug.py`)
- Standalone `.prove/acb.db` — auto-imported into `.prove/prove.db` on first `claude-prove acb` call, then deleted
- `python3 -m tools.acb ...` / `python3 $PLUGIN_DIR/tools/acb/hook.py ...` invocation paths
- `tools/acb` lint-ignore entry in `biome.json`

**Added**:

- `claude-prove acb save-manifest [--branch B] [--sha S] [--slug G] [--workspace-root W]` — reads intent manifest JSON on stdin, validates, inserts into `.prove/prove.db`
- `claude-prove acb assemble [--branch B] [--base main]` — merges branch manifests into an ACB document, upserts `acb_acb_documents` row, clears manifests
- `claude-prove acb hook post-commit --workspace-root W` — Claude Code PostToolUse hook (reads payload on stdin)
- `claude-prove acb migrate-legacy-db [--workspace-root W]` — user-triggered legacy-db importer (auto-invoke runs transparently on first non-migrate call)
- `packages/cli/src/topics/acb/` — full TS port with bun test coverage
- `packages/shared/src/{git,run-slug}.ts` — cross-topic helpers (git subprocess wrappers, 5-tier run-slug resolver) extracted from `tools/acb/_git.py` and `tools/acb/_slug.py`
- `acb` domain in the unified store — `acb_manifests`, `acb_acb_documents`, `acb_review_state` tables registered via `@claude-prove/store`

**Migration**:

1. Run `/prove:update` — rewrites `.claude/settings.json` PostToolUse hook command to the TS form. No other manual steps.
2. The next `claude-prove acb save-manifest`, `claude-prove acb assemble`, or `claude-prove acb hook post-commit` invocation auto-imports `.prove/acb.db` into `.prove/prove.db` and deletes the legacy file. One stderr line announces the import count.
3. If the review UI container is running, restart it so the server process opens the new `.prove/prove.db`. The HTTP/response shapes are unchanged.
4. External scripts that invoked `python3 -m tools.acb save-manifest` must switch to `claude-prove acb save-manifest` (same stdin contract).

**Auto-adoption**:

- `.claude/settings.json` hook swap is applied by `/prove:update`.
- Legacy-db import runs transparently; no user action required.
- Review UI reads the new db on next container restart.

---

## v0.40.0 — PCD ported to TypeScript

Phase 7 of the TypeScript CLI unification (see `.prove/decisions/2026-04-21-typescript-cli-unification.md`). The Python `tools/pcd/` module is retired; the Progressive Context Distillation deterministic rounds (structural map, collapse, batch formation) now run through `claude-prove pcd` backed by `packages/cli/src/topics/pcd/`. Every steward skill directive that previously invoked `python3 $PLUGIN_DIR/tools/pcd/__main__.py ...` now routes through the TS CLI.

**Removed**:

- `tools/pcd/` (all Python sources, tests, `tool.json`, `README.md`, `__main__.py`, `__init__.py`, `schemas.py`, `import_parser.py`, `structural_map.py`, `collapse.py`, `batch_former.py`)
- `python3 $PLUGIN_DIR/tools/pcd/__main__.py <cmd>` invocation path
- `tools/pcd` lint-ignore entry in `biome.json`

**Added**:

- `claude-prove pcd map [--project-root <path>] [--scope <files>]` — Round 0a structural map
- `claude-prove pcd collapse [--project-root <path>] [--token-budget <n>]` — triage manifest compression
- `claude-prove pcd batch [--project-root <path>] [--max-files <n>]` — Round 2 batch formation
- `claude-prove pcd status [--project-root <path>]` — artifact presence check
- `packages/cli/src/topics/pcd/` — full TS port with bun test coverage and byte-parity fixtures under `__fixtures__/{structural-map,collapse,batch-former}/python-captures/`

**Migration**:

1. Run `/prove:update` — picks up the new CLI. No hook changes needed; no on-disk artifact migration (`.prove/steward/pcd/*.json` schemas unchanged).
2. If external scripts call `python3 tools/pcd/__main__.py …` directly, rewrite to `claude-prove pcd <map|collapse|batch|status>`.
3. Steward skill invocations (`skills/steward/SKILL.md`, `skills/steward-review/SKILL.md`, `skills/auto-steward/SKILL.md`) and `agents/pcd/README-pcd.md` already carry the new `claude-prove pcd` form — no user action required.

**Auto-adoption**: None required — steward skill directives were rewritten in place. Existing artifact files under `.prove/steward/pcd/` are read back unchanged by the TS CLI.

---

## v0.39.0 — run_state ported to TypeScript

Phase 6 of the TypeScript CLI unification (see `.prove/decisions/2026-04-21-typescript-cli-unification.md`). The Python `tools/run_state/` module is retired; orchestrator state mutation now flows through `claude-prove run-state` backed by `packages/cli/src/topics/run-state/`. Every Claude Code hook, shell script, and skill directive that previously invoked `python3 -m tools.run_state ...` now routes through the TS CLI (directly or via `scripts/prove-run`, whose public interface is unchanged).

**Removed**:

- `tools/run_state/` (all Python sources, hook entrypoints, tests, `tool.json`, `__main__.py`, `_validator.py`)
- `python3 -m tools.run_state <cmd>` invocation path
- `python3 tools/run_state/hook_*.py` commands in `.claude/settings.json` (PreToolUse, PostToolUse, SessionStart, Stop, SubagentStop)

**Added**:

- `claude-prove run-state validate, init, show [--kind ...], show-report <id>, ls, summary, current, step <start|complete|fail|halt> <id>, step-info <id>, validator set <id> <phase> <status>, task review <id> --verdict <v>, dispatch <record|has>, report write <id> --status ..., migrate` — full TS port
- `claude-prove run-state hook <guard|validate|session-start|stop|subagent-stop>` — Claude Code hook entrypoints, read payload from stdin, exit with Python-compatible codes
- `packages/cli/src/topics/run-state/{schemas,validate,validator-engine,paths,state,migrate,render}.ts` — 312 bun tests and 63+ byte-equal parity captures against the retired Python module
- `packages/cli/src/topics/run-state/hooks/{guard,validate,session-start,stop,subagent-stop,dispatch,json-compat,types}.ts`
- `packages/cli/src/topics/run-state/cli/*` — 13 per-action handlers

**Migration**:

1. Run `/prove:update` — picks up the new CLI and rewrites the five `.claude/settings.json` hook entries (PreToolUse + PostToolUse Write|Edit|MultiEdit, SessionStart resume|compact, Stop, SubagentStop general-purpose) in place.
2. Manual fallback for each hook: command body becomes `bun run <plugin>/packages/cli/bin/run.ts run-state hook <event>`; timeouts preserved (3000ms SessionStart, 5000ms everywhere else).
3. `scripts/prove-run` keeps its public interface unchanged; the body swaps to `bun run <plugin>/packages/cli/bin/run.ts run-state`. Agents calling `scripts/prove-run <subcmd>` need no changes.
4. If scripts call `python3 -m tools.run_state …` directly, rewrite to `claude-prove run-state …` (or `scripts/prove-run <subcmd>`).
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

- `claude-prove cafi index [--force] [--project-root <path>]`
- `claude-prove cafi status [--project-root <path>]`
- `claude-prove cafi get <path> [--project-root <path>]`
- `claude-prove cafi lookup <keyword> [--project-root <path>]`
- `claude-prove cafi clear [--project-root <path>]`
- `claude-prove cafi context [--project-root <path>]`
- `claude-prove cafi gate` — PreToolUse hook dispatcher; reads the Claude Code hook payload from stdin
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

Phase 4 of the TypeScript CLI unification (see `.prove/decisions/2026-04-21-typescript-cli-unification.md`). The Python `tools/schema/` module is retired; `claude-prove schema` is now a real TypeScript topic backed by `packages/cli/src/topics/schema/`. `.claude/.prove.json` migrates from v3 to v4.

**Removed**:

- `tools/schema/` (all Python sources, tests, and `tool.json`)
- `python3 -m tools.schema <cmd>` invocation path
- `scopes.tools` mapping in `.claude/.prove.json` (no longer needed — `tools/` directory is retired per the TS unification plan)
- `tools.schema.enabled` registry entry (schema is now a CLI topic, not a pluggable tool)

**Added**:

- `claude-prove schema validate [--file <path>] [--strict]`
- `claude-prove schema migrate [--file <path>] [--dry-run]`
- `claude-prove schema diff [--file <path>]`
- `claude-prove schema summary`
- `packages/cli/src/topics/schema/` — full TS port with bun test coverage (64 tests) and parity fixtures under `__fixtures__/`
- v3→v4 migration in `packages/cli/src/topics/schema/migrate.ts` (drops `scopes.tools` + `tools.schema`)

**Migration**:

1. Run `/prove:update` — it picks up the new CLI and runs `claude-prove schema migrate` against `.claude/.prove.json` automatically.
2. Manual fallback: `bun run <plugin>/packages/cli/bin/run.ts schema migrate --file .claude/.prove.json`.
3. Remove any `.bak` file the migrator writes (only needed if you want to keep an on-disk backup; git history already covers it).
4. If you have scripts that call `python3 -m tools.schema …`, rewrite them to call `claude-prove schema …`.

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
claude-prove run-state migrate

# Review what changed first:
claude-prove run-state migrate --dry-run

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
