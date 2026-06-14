# Plugin Updates

Migration guide for features that require user action after updating the plugin. Run `/prove:update` to apply these automatically, or follow the manual steps below.

For the full commit-level changelog, see [CHANGELOG.md](CHANGELOG.md).

**Authoring convention:** write every new entry at the top of this file under a `## Unreleased — <title>` heading — never a hand-written version number, since the next semver is unknowable until the release cut. The release workflow stamps each pending `## Unreleased` heading with the version that ships it, in the same commit that bumps the version and regenerates the changelog.

---

## v4.1.0 — `install upgrade --tag <vX.Y.Z>` pins a specific release

*(No config or schema migration. New optional flag; default behavior unchanged.)*

`claude-prove install upgrade` previously only ever fetched `latest`, so stepping off a release that regressed meant manually downloading a prior asset. It now accepts `--tag <vX.Y.Z>` (a leading `v` is optional — `4.0.1` and `v4.0.1` both work) to pin the download to a specific release:

```
claude-prove install upgrade --tag v3.13.3
```

With no `--tag` the behavior is identical to before (newest release). The tag is validated as a semver before any network call, so a typo fails fast instead of 404-ing. Note a binary that is already non-running cannot execute this command at all (it fails before argument parsing) — recovering a fully broken binary still goes through `install.sh` or a manual download; `--tag` covers pinning/downgrading from a working binary.

Migration: none. Auto-adoption: full — the flag ships with the binary.

---

## v4.0.1 — Standalone binary loads the Turso native addon (fixes v4.0.0 startup brick); Intel mac dropped

*(No `.claude/.prove.json` migration. The fix lands entirely in the compiled release binary — upgrade to get it.)*

The v4.0.0 standalone binary died on **every** invocation — including `claude-prove --version` — with `Cannot find native binding`, because `bun build --compile` bundles JavaScript but does not carry the external `@tursodatabase/database` NAPI `.node` addon the store loads at runtime ([#56](https://github.com/mjmorales/claude-prove/issues/56)). Since `install upgrade` overwrote the working binary with the broken one, the upgrade bricked the CLI. (Pre-4.0 was immune: `bun:sqlite` is built into the Bun runtime, so the SEA had no external native dependency.)

The compiled binary now **embeds the platform native addon** as a file asset (`with { type: 'file' }`, the same mechanism that bakes in the review-ui bundle) and points the loader at the extracted copy via `NAPI_RS_NATIVE_LIBRARY_PATH`. The binary is fully self-contained again — no sidecar files, no `node_modules` at runtime. Three things make it durable:

- **Per-target embed** (`scripts/gen-native-embed.ts`): the release build generates a compiled entry that embeds the host's prebuilt addon, run before the store's loader evaluates. Dev (`bun run`) and tests resolve the addon from `node_modules` as before and are unaffected.
- **Loader fix** (vendored patch, `patches/@tursodatabase%2Fdatabase@0.6.1.patch`): the upstream NAPI-RS loader's `NAPI_RS_NATIVE_LIBRARY_PATH` branch assigned the binding but omitted its `return`, so the result was immediately clobbered to `undefined` — the env hook never worked. The one-line patch adds the missing `return`; it is recorded in the lockfile and applied automatically by `bun install`.
- **Clean-room release smoke test**: the release workflow now runs the freshly-built binary from a directory with **no `node_modules`** and exercises the store end-to-end (`scrum init` + `scrum status`, opening/migrating/reading the DB). The prior smoke test ran in the repo root, where `node_modules` masked exactly this failure — so a broken binary passed CI and shipped. A non-running binary can no longer reach a release.

**Intel mac (`darwin-x64`) is no longer built or published.** `@tursodatabase/database` ships no Intel-mac binding at the pinned version (no `-darwin-x64` package, no `-darwin-universal` or `-wasm32-wasi` fallback), so an Intel-mac binary has no addon to embed and would brick the same way. `install upgrade` and `install.sh` now fail fast on Intel mac with a clear message instead of fetching a 404. Apple Silicon mac and Linux (x64/arm64) are unaffected and supported. The target returns when upstream publishes an Intel-mac (or universal/wasm) binding.

Migration: **Apple Silicon / Linux** — `claude-prove install upgrade` (or re-run `install.sh`) to replace the bricked v4.0.0 binary; verify with `claude-prove --version`. If your binary is already bricked and cannot self-upgrade, fetch the new release asset directly: `gh release download <latest> -R mjmorales/claude-prove -p 'claude-prove-<target>' && install -m 0755 claude-prove-<target> ~/.local/bin/claude-prove`. **Intel mac** — no supported binary; stay on the source (`bun run`) path, which is itself constrained by the upstream binding gap.

Auto-adoption: full on supported platforms — the fix ships in the binary; no config or project changes.

---

## v4.0.0 — Turso store: async driver port + sync-safe v1 schema (BREAKING store reset)

*(Store migration: **breaking — the schema chain resets to a clean v1 per domain**. A store written by any earlier plugin version is refused on write-open with a reset-or-migrate message; see Migration below. No `.claude/.prove.json` migration.)*

The `.prove/prove.db` store moves off `bun:sqlite` onto the Turso stack (`@tursodatabase/database`, async NAPI) and onto a schema redesigned to survive Turso sync (`REBASE_LOCAL` — whole-transaction replay with a winner, not a CRDT): two offline writers only merge cleanly if their writes commute. Two changes, shipped together:

**Async driver port** (`@claude-prove/store` extraction): all store reads/writes are async end-to-end — `openStore`/`openScrumStore`/`openAcbStore`, every CLI handler, and the review-ui server. The scrum + ACB write services live in `@claude-prove/store` with async signatures; a single `withTx` helper (BEGIN IMMEDIATE at depth 0, savepoints when re-entrant) replaces every `db.transaction()` closure; recursive status rollups batch-fetch the subtree in one query instead of one query per node.

**Sync-safe v1 schema**: every primary key is a monotonic ULID TEXT id — no `AUTOINCREMENT` anywhere (rowid PKs silently lose a row under two-writer sync; distinct ULIDs commute — proven by a regression test). The contended blobs become append-only logs read through SQL head views: `scrum_tasks.acceptance_json` normalizes into `scrum_acceptance_criteria` + append-only `scrum_criterion_verdicts` (+ `scrum_criterion_head` view), and the ACB document/review-state/group-verdict blobs become append-only revision tables with `_head` views. `scrum_tasks` gains a `status_event_id` provenance pointer to the event that set its status. Shared `scrum_ready_eligible` / `scrum_current_operator` views feed both the CLI and the review-ui server, so both surfaces read one definition. `scrum_decisions`/`scrum_lores` gain nullable `embedding F32_BLOB(32)` columns (unpopulated — a later semantic-search phase fills them). A schema-version write guard refuses write-opens on a legacy (pre-v1) or ahead-of-binary store instead of silently migrating or corrupting; readonly opens are exempt.

Also in this change:

- **`store reset --confirm` fixed for FK-bearing stores**: the drop path now suspends `foreign_keys` for the drop transaction and drops views alongside tables — previously it failed with `FOREIGN KEY constraint failed` on exactly the legacy stores the write guard directs at it, and a leftover view would collide with the bare `CREATE VIEW` on re-migration.
- **Install test deadlock fix**: the `install latest`/`install upgrade` suites spawned the CLI with `spawnSync` while serving their HTTP stubs from the same process — the blocked event loop deadlocked the stub. Async spawn; the suites run in milliseconds instead of riding 300s timeouts.

Migration (manual — `/prove:update` does not auto-apply a destructive reset):

1. **Fresh start (recommended for most projects):** `claude-prove store reset --confirm`, then reopen — the v1 schema bootstraps cleanly and `scrum init` can re-import `planning/`. All prior scrum/ACB rows are discarded.
2. **Preserve data:** wait for the `store migrate-to-turso` one-shot migrator (tracked upstream) that lifts a legacy store's rows onto v1.

Auto-adoption: none — the write guard makes the incompatibility explicit on first write-open and prints exactly these options.

---

## v3.13.3 — `add-dep`/`remove-dep` usage names the edge direction (`<blocker> <blocked>`)

*(No behavior change, no migration — usage text + docs only.)* `scrum task add-dep <A> <B>` records `A -blocks-> B`: the FIRST positional is the prerequisite, the opposite of the verb-name-natural "add a dependency to task A" reading, which silently inverted the dep-graph and corrupted wave-plan build order ([#53](https://github.com/mjmorales/claude-prove/issues/53)). The positionals are now documented as `<blocker> <blocked>` everywhere — usage-error strings, the file-top usage comment, the CLI reference, and the `scrum-master` agent — each stating the inverse spelling (`--kind blocked_by` flips the positional reading; both spellings normalize to one canonical `blocks` row). The `scrum-master` agent doc also drops a stale claim that `blocked_by` edges do not surface through `next-ready` — normalized edges surface identically. Argument order is unchanged; existing scripts keep working.

Migration: none. Auto-adoption: full — new text ships with the plugin/binary.

---

## v3.13.2 — Worker prompt lands typed findings; milestone-close curation sweeps them

*(No `.claude/.prove.json` migration, no store migration — prompt template + skill behavior.)* Fixes the worker/driver protocol gap where milestone-close curation swept 0 candidates after orchestrator full-mode runs ([#51](https://github.com/mjmorales/claude-prove/issues/51)). The `orchestrator task-prompt` template documented `acb log append` only on the cooperative-cancel path, so worker findings reached the driver solely in handoff messages, got folded into driver `synthesis` entries, and never hit the typed kinds (`hack`/`risk`/`decision`/`assumption`) the curation reconciler sweeps.

- **Worker prompt — "Typed Findings" section** (`orchestrator task-prompt`): on normal completion, each task subagent records its substantive findings as typed reasoning-log entries (one JSON file via the Write tool, landed with `claude-prove acb log append --run-dir <dir> --file <entry.json>`, `agent: task-<id>`). These are file appends into the main worktree run dir — exempt from the worker shared-store ban. The worker exit contract is now: record typed findings → commit → exit.
- **Driver findings backstop** (orchestrator + workflow skills): when a worker's handoff message reports findings missing from the reasoning log, the driver transcribes them as typed entries (`agent: "driver"`) before writing `synthesis` — never folds them into `synthesis` prose alone.

Migration: none — the template change applies to the next dispatched run. Auto-adoption: full; no config or store changes.

---

## v3.13.0 — Lore supersession + `scrum lore promote`/`supersede` (store v28)

*(Store migration v28 — auto-applies on the next `claude-prove scrum` open; no `.claude/.prove.json` migration.)* `scrum_lores` gains the compaction lifecycle: `superseded_by` (a typed soft reference — `lore:<id>` for a consolidation, `decision:<id>` for a promotion) plus `reason`. Rows are never edited or deleted — a retired entry keeps its body, author, and timestamp; only the pointer lands, and a supersession is resolved once. New CLI surface:

- **`scrum lore supersede <id> (--by <loreId> | --by-decision <decisionId>) --reason R --author CT-UUID`** — retire a live entry by pointer. Same seated-tech_lead authorship gate as `lore record` (vacant seat warns and allows); a consolidation pointer must name a live entry of the same team, a decision pointer must name an `accepted` decision.
- **`scrum lore promote <id> [--kind adr|glossary|pattern] [--title T] [--id D]`** — the store's Lore→Codex lift as a verb: records a gated draft under the deterministic `lore-promotion-<team>-<loreId>` id and stamps `source_lore_id`. Only gated kinds are accepted. **`scrum decision approve` on a promotion now auto-retires the still-live source Lore** (`superseded_by = decision:<id>`, reason `promoted to codex`); reject leaves it live.
- **`scrum lore list <slug> --live`** — only entries no supersession has retired.

The `teams/<slug>.md` artifact's `lore:` block now reports `count` (full history) plus `live`, and its recent window carries live entries only — a folded entry leaves the window the moment its replacement lands. Team disband promotes only live Lore (retired sources are skipped; their substance already lives in their replacement). The janitor skill's Phase 3 drives the new verbs.

Migration: none beyond the automatic column add — existing Lore rows are all live by default. Empirical motivation: a janitor pass without supersession grew the funpack stress-target's memory footprint +16% (consolidations appended while their sources stayed visible); with supersession the same pass lands below the pre-cleanup baseline.

---

## v3.12.0 — Janitor: memory-layer cleanup for team Lore, the Codex, and contributor artifacts

*(No `.claude/.prove.json` migration, no store migration — new skill + agent + command only.)* New `/prove:janitor` command (thin wrapper over the `janitor` skill) and a `memory-janitor` agent. The janitor cleans prove's durable memory layers without ever deleting: a per-scope `memory-janitor` pass (one agent per team plus one for the Codex, read-only) classifies every Lore entry, annotation, decision, and contributor-artifact body as `keep | consolidate | promote | supersede | rewrite | noise`; an `AskUserQuestion` batch gate per scope approves; the driver then executes through existing CLI verbs only — `scrum lore record` for tech_lead-authored consolidation entries that cite the ids they fold, `scrum decision record`/`approve` for Lore→Codex promotions (deterministic `lore-promotion-<team>-<loreId>` ids, matching the store's promotion convention so a future mechanical promotion upserts), `scrum decision supersede` for Codex cleanup, and direct body edits for contributor artifacts. `prompting token-count` over `teams/*.md`, `contributors/*.md`, and `.prove/decisions/*.md` brackets the run as the before/after compaction metric.

Consolidated and promoted sources are retired by pointer via the store-v28 Lore supersession (see that entry); consolidation bodies still name the ids they fold so provenance reads in both directions. `references/agent-routing.md` gains the janitor cue row and lists `memory-janitor` as pipeline-internal (invoke via `/prove:janitor`, not ad hoc).

Migration: none — the command is available after the plugin update. Auto-adoption: not a `core: true` command; invoke on demand when team bundles or the Codex feel bloated.

---

## v3.11.0 — CAFI: the describe loop moves into the driver session (`cafi index` removed)

*(No `.claude/.prove.json` migration, no store migration — CLI verb surface + skill behavior.)* `cafi index` used to shell out to an external `claude -p - --model haiku` process to generate routing-hint descriptions — the one place the CLI spawned a model, with the failure modes to match (silently empty descriptions when the `claude` binary was unavailable, fragile JSON parsing, hard 8KB content truncation). The describe loop is now driven by the Claude session itself, split along the engine boundary:

- **`cafi plan [--force] [--batch-size N]`** (new) — the mechanical delta: walk + triage + hash + diff, emitted as batched JSON (`{ total, new, stale, deleted, unchanged, batches }`). Read-only except stat backfill; never prunes, never calls a model.
- **`cafi save [--file <p>|stdin]`** (new) — the validated merge: per-file floor (recomputed disk hash must equal the payload hash, non-empty ≤600-char description), deletion pruning, and a cache lockfile so parallel batch agents can save concurrently. Rejections return as `{ path, reason }` (`hash-drift` | `deleted` | `invalid-description` | `invalid-path`) for re-planning.
- **`/prove:index`** is the driver: it routes the delta by size — ≤10 files described inline, 11–50 via Agent-tool fan-out (one subagent per batch, each self-saving), >50 via a Workflow pipeline gated by an explicit confirmation. A stale entry keeps its old description and hash until `save` lands the replacement, so `status`, `lookup`, and the Glob/Grep gate stay truthful mid-build.
- **`cafi index` exits 1** with a pointer to `/prove:index`. The read path — `status`, `get`, `lookup`, `context`, `clear`, the `gate` hook — and the `.prove/file-index.json` format are unchanged; existing indexes keep working with no rebuild.

Migration: replace any scripted `claude-prove cafi index` invocation with running `/prove:index` in a Claude Code session — there is no headless equivalent by design ("prove never spawns Claude — you do"). A `tools.cafi.config.concurrency` key is now ignored (describe parallelism belongs to the driver's fan-out); it is harmless to leave in place and there is nothing to migrate. `batch_size`, `excludes`, `max_file_size`, and `triage` keep their meaning.

Auto-adoption: full — the new verbs land in the compiled binary and the rewritten skill ships with the plugin; no action required on update beyond installing the new release.

## v3.10.2 — Slashed branch names get a flat, percent-encoded run directory

*(No `.claude/.prove.json` change, no store migration — on-disk run layout for slashed branch names only.)* A run initialized with a branch name containing `/` (git-flow style: `feat/login`, `orchestrator/<slug>`) used to nest its directory deeper than the canonical two-level `.prove/runs/<branch>/<slug>/` layout — `runs/feat/login/<slug>/` — which silently hid the run from every two-level enumerator: the Stop/SubagentStop/SessionStart hooks, `run-state ls`/`show --summary`, branch autodetection, and the scrum reconciler's run sweep.

The branch path component is now percent-encoded (`%` → `%25`, then `/` → `%2F`): branch `feat/login` lands at `runs/feat%2Flogin/<slug>/` and every enumerator finds it; display and autodetection round-trip back to the logical branch name. Branch names without `/` or `%` encode to themselves, so **existing flat layouts are byte-identical — no migration needed**.

Corner case: a run that was previously initialized with a slashed branch sits in a nested directory the CLI no longer addresses. Rename it to the encoded form, e.g. `mv .prove/runs/feat/login/<slug> ".prove/runs/feat%2Flogin/<slug>"` (and remove the emptied nesting dirs). Such runs were already invisible to hooks and listings, so most projects have none.

Auto-adoption: full — the fix lands in the compiled binary; no action required on update beyond installing the new release.

## v3.10.2 — Stop hook no longer halts runs with background agents in flight

*(No `.claude/.prove.json` change, no store migration — hook behavior only.)* The session Stop hook reconciler halts any step still `in_progress` with no completion recorded — but Stop fires at the end of every driver turn, not only at true session termination. Under orchestrator full-mode, the driver dispatches background implementation agents into sub-task worktrees and yields its turn, so every started step was spuriously halted (`halt_reason: "session ended with step still in_progress — no completion recorded"`) seconds after dispatch, forcing manual re-start/complete.

The Stop hook now skips reconciliation for any run with a live sub-task worktree (`.claude/worktrees/<slug>-task-*`): background work in flight means `in_progress` is the legitimate state, and the steps complete later via SubagentStop auto-complete or an explicit `run-state step`. Runs without live worktrees — simple-mode runs and genuinely abandoned ones — keep the exact prior halt behavior. Corollary: a stale, never-cleaned worktree now suppresses the halt for its run until removed (`claude-prove worktree remove|remove-all`), which is intentional — un-merged worktrees mean the run is not reconciled-clean.

Auto-adoption: full — the fix lands in the compiled binary; no action required on update beyond installing the new release.

## v3.10.0 — Generated CLAUDE.md gains a Team Agents dispatch + memory-protocol section

*(No `.claude/.prove.json` change, no store migration — regenerate CLAUDE.md to adopt.)* Projects with registered teams now get a `## Team Agents` section in the prove-managed CLAUDE.md block. The scanner detects the role-bound agent files (`.claude/agents/team-<slug>-<role>.md`, closed `tech_lead`/`engineer`/`implementer` role set — purely filename-driven, no store lookup) and the composer renders three things: the agent roster grouped by team, a dispatch directive (for work inside a team's scope, dispatch that team's role agent rather than a general-purpose agent; resolve scope from the team bundle `teams/<slug>.md`), and a memory-protocol reminder for dispatched team agents (read the bundle before acting; record learnings through `scrum annotation add --target-kind team`, `scrum lore record` on the tech_lead seat, and `scrum decision record`). Projects with no team agent files render no section — output is unchanged.

`claude-md scan` JSON output gains a `team_agents` array (`{team, role, name}`, team-ascending then canonical role order); consumers of the scan shape should tolerate the new field.

Auto-adoption: full on CLAUDE.md regeneration — `/prove:update` Step 8 (`claude-prove claude-md generate`) picks the section up automatically; or run `/prove:docs claude-md` to regenerate on demand.

## v3.9.0 — `review-ui serve` boots on a published plugin install (fixes #38)

*(No `.claude/.prove.json` change, no store migration — distribution shape + module-resolution path only.)* `claude-prove review-ui serve start` now boots the loopback daemon from a marketplace plugin install (a sources-only clone with no build step and no `node_modules`). The compiled `claude-prove` binary is now fully self-contained: the review-ui Fastify server — and its whole dependency tree (fastify, @fastify/*, simple-git, chokidar) — is bundled INTO the binary, alongside the already-embedded web bundle. A published install needs nothing on disk outside the binary itself.

**What was broken.** The daemon resolved the server as a separate on-disk module (`packages/review-ui/server/dist/index.js`), which a sources-only clone never ships (`Cannot find module`); pointing `CLAUDE_PROVE_PLUGIN_DIR` at a source checkout hit a path-join bug that dropped the plugin-dir prefix and produced an absolute `/review-ui/server/src/index.ts` (`Cannot find module`); and even with `dist/` copied in, the server's `require('fastify')` failed against a clone with no `node_modules` (`Cannot find package 'fastify'`).

**How it's fixed.** The CLI loads the server through one string-literal dynamic `import('@claude-prove/review-ui-server')`, which `bun build --compile` statically traces and bakes — with all transitive deps — into the binary's virtual filesystem. The server package's `exports` map resolves the same specifier to its source entry, so dev (`bun run` from a checkout) loads the checkout's server and a compiled binary loads the bundled copy — one specifier, no plugin-dir path arithmetic. Two compiled-only boot bugs surfaced and were fixed in the same pass: the server's self-exec guard now suppresses a spurious second listener under the bundled binary, and the child boot no longer hits the `process.exit` that tore the just-bound listener down.

**Release pipeline.** No new build step. The existing `scripts/build-review-ui-embed.sh` (web bundle → `web-dist.tar`) still runs before the compile step; the server now rides the same `bun build --compile packages/cli/bin/run.ts` that already produced the binary — its static import graph pulls the server in automatically.

Auto-adoption: full — the fix lands in the compiled binary; no action required on update beyond installing the new release.

## v3.9.0 — `scrum compile-plan` excludes containment parents from the executable plan (fixes #37)

*(No `.claude/.prove.json` change, no store migration — behavior change to the emitted `plan.json`/`scrum-map.json` for layered milestones only.)* Compiling a milestone with a layered containment tree (`epic → story → task` via `parent_id`/`--layer`) previously emitted the epic/story container tasks themselves as wave-1 plan tasks alongside their children — each with a synthesized single step duplicating the container description. Dispatching those would re-implement the children's work monolithically. A milestone with 2 accepted epics + 8 stories compiled to a 10-task plan where two tasks were the epics.

**Container-exclusion predicate.** A task is now excluded from the executable plan iff at least one of its `parent_id` children is itself in the actionable set (i.e. it is a containment parent of in-plan work). The exclusion is by this child-presence test, never by `layer` alone:

- An epic/story whose children are ALL done/cancelled/out-of-milestone (none in the plan) STAYS in — it is residual parent-level work, not a container, so it never silently vanishes.
- An epic with no children at all STAYS in.
- The deepest leaves of any tree always survive (a leaf has no in-plan child).

`scrum-map.json` and `team-map.json` likewise carry no container ids — the sidecars map only emitted plan tasks.

**Dependency re-wiring.** A `blocked_by` edge pointing AT an excluded container is re-targeted onto that container's in-plan leaf descendants (transitively, across nested `epic→story→task`), so waves stay correct; a re-target that would create a self-edge (a child blocked_by its own ancestor) is dropped. `mode` (`full` at ≥ 4 tasks) is computed on the emitted leaf count, not the pre-filter actionable count.

This restores the documented "the plan is regenerable — re-run compile rather than hand-editing" invariant: the prior hand-filtering workaround (deleting the epic tasks from `plan.json` after compile) is no longer needed. No action required on update.

## v3.9.0 — Per-action `--help` usage lines + full-usage argument errors (fixes #36)

*(No `.claude/.prove.json` change, no store migration — help/error text and one resolution path only.)* Required positionals and per-action flags are now discoverable without failing repeatedly, and a topic's `--help` is no longer a flat dump spanning every action.

**Action-scoped `--help`.** `claude-prove <topic> <action> --help` (e.g. `scrum link-run --help`, `scrum task create --help`, `run-state validate --help`) prints a single usage line — `Usage: claude-prove <topic> <action> <positional1> <positional2> [flags]` — followed by only that action's flags with their descriptions, instead of the whole topic's flag set. A bare `claude-prove <topic> --help` (no action) keeps the existing full topic help.

**Full-usage argument errors.** When a required positional is missing, the error now prints the same usage line naming every positional at once, plus the specific missing-arg message — so `scrum link-run` with no arguments tells you both `<task-id>` and `<run-path>` are required in one shot, rather than one failed run per positional.

**`run-state validate` run resolution.** `run-state validate` now resolves its target artifact from `--branch`/`--slug` (`--runs-root`) plus `--kind` (`state` | `plan` | `prd`; default `state`) when no positional file is given, matching its sibling read actions. The positional-file form (`run-state validate <file>`) works unchanged. `--kind report` still requires a positional file (one report per step).

**Coverage.** The per-action registry covers the `scrum` and `run-state` topics — the worst offenders — end to end; unregistered topics fall through to cac's stock help, so every existing invocation behaves as before. No action required on update.

## v3.8.2 — `run-state summary --slug` filters to one run (fixes #31)

*(No `.claude/.prove.json` change, no store migration — behavior change only.)* `claude-prove run-state summary --slug <s>` previously dropped the `--slug` flag and printed a summary block for every run under `.prove/runs/<branch>/`, which silently corrupted scripted reads like `summary --slug X | tail -3` (it returned whichever run sorted last). The flag is now threaded into run selection: `--slug` resolves exactly one run (the branch autodetects when omitted, or pass `--branch` to disambiguate) and emits that single block. An unknown slug now errors (exit 2, `slug '<s>' is not registered`) instead of matching nothing. Without `--slug`, the sweep behavior is unchanged; `--branch` alone narrows the sweep to one branch namespace.

No action required on update.

## v3.8.1 — `scrum contributor register` is idempotent on slug (fixes #30)

*(No `.claude/.prove.json` change, no store migration — behavior change only.)* Re-running `contributor register` against an existing slug no longer fails with a UNIQUE-constraint error. It now reconciles the row — provided flags override the stored fields, unset flags preserve them — and re-emits/merges the `contributors/<slug>.md` identity artifact, so a bare re-register repairs a registry row whose identity file was never emitted or was lost. The CT-UUID and created-* provenance never change: a provided `--id` that conflicts with the registered CT-UUID errors (exit 1), preserving attribution history.

**Repair recipe** for registries with missing identity artifacts: for each row in `claude-prove scrum contributor list` without a matching `contributors/<slug>.md`, run `claude-prove scrum contributor register --slug <slug>` — the artifact is re-emitted from the stored row, no flags needed.

No action required on update; existing workflows that relied on the duplicate-slug failure as a "does this contributor exist" probe should use `contributor list` instead.

## v3.7.0 — Role-bound team agents: generated per-(team,role) agent files + task→team assignment

*(No `.claude/.prove.json` change — the scrum store migrates itself to v27 on first write. For teams registered before this version, run `claude-prove scrum team sync-agents` once to backfill the agent files.)* Roster role slots now bind to execution: each registered team gets three committed, natively-discoverable agent definitions, tasks can carry an owning team, and the dispatch surfaces name the team's agents for spawning.

**Generated team agent files (`.claude/agents/team-<slug>-<role>.md`).** `scrum team create` and `rotate` render one agent file per role (`tech_lead`/`engineer`/`implementer`); `terminate` deletes them. Each file is generated frontmatter plus a marker-delimited "Team Context Protocol" block (startup self-serve reads of the team's `teams/<slug>.md`, seated-contributor resolution via `scrum team roster`, per-role write commitments through `scrum annotation add` / `scrum lore record` / run-state); body prose outside the markers is authored and survives regeneration. `scrum team sync-agents [<slug>]` backfills/repairs files for active teams.

**Task→team assignment (scrum store v27).** Tasks gain an optional `team_slug`: `scrum task create --team <slug>` and `scrum task move --team <slug>` (empty value unbinds), validated against the team registry (unknown or inactive teams are rejected); reassignment appends a `team_changed` event. The decompose ladder propagates the parent's team onto children.

**Spawn-list wiring.** `scrum compile-plan` forwards `team_slug` onto plan tasks and writes a `team-map.json` sidecar; `orchestrator task-prompt` renders a "Team Agents" section and `orchestrator wave-plan` carries a `team_agents` map (plus a markdown column) listing the owning team's three deterministic agent names — derived purely from the slug, no store lookup.

**Doctor + advisory floor.** `install doctor` gains two report-only checks (generated-region marker integrity; registry-vs-filesystem drift) whose fix hint is `scrum team sync-agents`. The scrum subagent-stop reconciler gains an advisory contribution floor: a team-role agent (identified via `PROVE_AGENT=team-<slug>-<role>`) that stops without stamping a contribution in its dispatch window raises a `contribution_miss` escalation in `scrum alerts` — never a block.

Auto-adoption: full — new verbs and checks are active on update; agent files appear as teams are created/rotated (or via the one-time `sync-agents` backfill).

## v3.6.0 — Editor autocomplete for `.claude/.prove.json` (`schemas/prove.schema.json`)

*(Additive — opt-in per project; no config schema migration.)* A standard JSON Schema (draft-07) artifact, `schemas/prove.schema.json`, gives editors (VS Code, Cursor, JetBrains) autocomplete, hover docs, and inline validation for `.claude/.prove.json`. It is generated mechanically from `PROVE_SCHEMA` (`packages/cli/src/topics/schema/schemas.ts` stays the single source of truth) by `bun run scripts/generate-json-schema.ts`, and a drift-guard test fails CI whenever `PROVE_SCHEMA` changes without regeneration. Field descriptions, defaults, enums (validator phases, trigger statuses, decompose layers), and required keys all carry through.

- **Embedding the reference** — add `"$schema": "https://raw.githubusercontent.com/mjmorales/claude-prove/main/schemas/prove.schema.json"` as the first key of `.claude/.prove.json` (or a relative path to a local checkout). `claude-prove schema validate` now skips a top-level `$schema` key — previously it warned as an unknown field (and failed under `--strict`). Nested `$schema` keys still warn like any unknown key.
- **Editor-side strictness** — the JSON Schema closes objects (`additionalProperties: false`) wherever the CLI validator warns on unknown keys, so an editor squiggle and a `schema validate` WARN flag the same finding.

**Migration.** None required. To adopt: add the `$schema` key as above.

## v3.6.0 — Hook scaffolding: `dev_mode` config is the authority, detection requires a runnable checkout

*(Fixes [#28](https://github.com/mjmorales/claude-prove/issues/28); behavior changes only — no config schema migration.)* `install init`/`init-hooks` used to pick the hook command prefix from filesystem detection alone: any plugin dir containing `packages/cli/src/` scaffolded `bun run …/run.ts` hook commands — including marketplace clones with no workspace `node_modules`, where every hook then died silently on module resolution. An explicit `dev_mode: false` could not opt out. Three coordinated fixes:

- **`dev_mode` config is the authority.** `install init` and `install init-hooks` read `.claude/.prove.json::dev_mode` first: `true` → the interpolated `bun run` prefix, `false` → the bare-binary invocation, absent → filesystem detection seeds the choice. The banner names the source (`mode=compiled, dev_mode config` vs `mode=dev, detected`). Flipping `dev_mode` rewrites existing hook blocks on the next `init-hooks` run — no `--force` needed (command drift triggers the rewrite).
- **Detection requires a runnable checkout.** `detectMode` reports `dev` only when `packages/cli/src/` exists AND `node_modules/@claude-prove/shared` resolves (the workspace install ran). A sources-only marketplace clone now classifies as `compiled`, so codegen emits the binary invocation that actually works.
- **Doctor executes hook targets.** A new `hook-exec` check runs each distinct scaffolded hook command once with `--version` and FAILs on a non-zero exit — catching targets that exist on disk but die at fire time, with a fix hint (`bun install` the checkout, or set `"dev_mode": false` and re-run `claude-prove install init-hooks --force`).
- **Doctor resolves bare hook commands on `$PATH`** *(fixes [#29](https://github.com/mjmorales/claude-prove/issues/29))*. The `hook-paths` check used to probe a bare `claude-prove …` hook command as a cwd-relative path, false-failing all 12 hooks on every binary install — and suggested `install init --force`, which on a misdetected machine could replace working hook commands with a broken form. Bare commands (no `/`) now resolve the way the firing shell does; a genuine `$PATH` miss reports a target-specific fix (`install upgrade` / fix PATH) instead of the regen advice.

**Migration.** Affected projects (hooks scaffolded as `bun run …` against a non-runnable plugin dir): run `claude-prove install init-hooks --force` — with the fixed detection (or an explicit `"dev_mode": false`) the commands regenerate as bare-binary invocations. Verify with `claude-prove install doctor` (`hook-exec` must PASS). Hand-rewritten hook commands from the workaround are simply overwritten with the same shape.

## v3.6.0 — Contributor identity chain: init registers, register merges, writes attribute

*(Fixes the identity split-brain reported in [#27](https://github.com/mjmorales/claude-prove/issues/27); behavior changes only — no config schema migration.)* Bootstrapped identity artifacts used to stay files-only: `/prove:init` never minted a CT-UUID, so `operator set` was unsatisfiable, `contributor resolve` matched nothing, and every scrum write landed `created_by`/`last_modified_by: null` — permanently, since provenance is append-only. Three coordinated fixes:

- **`/prove:init` registers the contributor.** After authoring the identity skeletons, the command now runs `scrum contributor register` (deriving display name/email/GitHub from git + `gh`), binds the minted CT-UUID, and offers `scrum operator set` plus `scrum contributor default set` behind one gate — the identity artifacts mirror real registry rows from the start. Re-runs detect an existing slug via `contributor list` and never duplicate.
- **`scrum contributor register` merges instead of clobbering.** An existing `contributors/<slug>.md` (bootstrap-scaffolded or human-authored) keeps its body verbatim; register splices the registry `contributor:` block into the frontmatter (replacing a stale one), bumps the `last_modified_*` provenance pair, and prepends fresh frontmatter onto bare-markdown files. Only a missing file gets the full skeleton.
- **Scrum writes stamp the ambient actor.** Every `claude-prove scrum` write resolves its actor as explicit agent → `PROVE_AGENT` env → the per-project default-contributor mapping (`contributor default set`) → NULL, and stamps `created_by`/`last_modified_by`/event `agent` accordingly. This covers task create/status/move/cancel/delete, acceptance + bounds edits, events, decisions, contributor registration, and operator transfers. The mapping lives in the machine-global `~/.claude-prove/config.json` (reads fall back per-key to the legacy `${XDG_CONFIG_HOME:-~/.config}/claude-prove/config.json`); a malformed file is backed aside (`.corrupt-*`) and the write proceeds unattributed — corruption never fails a command.

**Migration.** Nothing structural. To repair an affected project: `claude-prove scrum contributor register --slug <you> [--github <handle>] [--email <addr>]` (your authored artifact body is preserved), then `claude-prove scrum operator set --contributor <CT-UUID>` and `claude-prove scrum contributor default set --id <CT-UUID>`. Provenance recorded before the repair stays NULL by design (append-only); new writes attribute from the next command on.

## v3.5.0 — Review UI goes Docker-free: native in-process daemon + schema v11

*(Config schema v10 → v11 — run `/prove:update` or `claude-prove schema migrate --file .claude/.prove.json`. The review UI no longer ships or pulls a container image; if you have a stale container from an earlier version, remove it once with `docker rm -f prove-review`.)* The review UI's entire Docker delivery path is retired. There is no Dockerfile, no GitHub Container Registry image, and no `docker pull` on launch — the server now runs as a native in-process loopback daemon owned directly by the CLI.

**Native daemon (`/prove:review-ui` / `claude-prove review-ui serve`).** The review UI is one long-lived detached loopback server per machine, driven through a pidfile:

- `claude-prove review-ui serve start` spawns the detached server, polls `/api/health` until it answers, and prints `{"running":true,"pid":<int>,"port":<int>}` on stdout. `stop` SIGTERMs the recorded pid and reaps the pidfile; `status` prints `{"running":<bool>,"pid":<int|null>,"port":<int>}`; `restart` stops any recorded daemon then runs the start path.
- The pidfile (`review-ui.pid`) and the combined server log (`review-ui.log`) live under `~/.claude-prove/review-ui/`. Tail that log for server output — there is no container or external process to inspect.
- The server binds `127.0.0.1` only. It runs git against the operator's repos, so the listener must never be reachable off the loopback interface.
- The daemon outlives the Claude session that started it; a later `serve start` that finds the pid alive refuses to double-start, and you reconnect by reading `serve status` and opening the reported port.

**Every registered project in one UI (`~/.claude-prove/projects.json`).** The daemon serves an auto-registry of every prove project on the machine. A project auto-registers the first time the CLI runs against it (the entry folds sub-task worktrees back to their main repo root, so worktrees never appear as distinct projects), and the UI exposes a project switcher in its header so one daemon covers them all. `claude-prove review-ui project <list|hide|remove|add> [path]` operates the registry by hand — `list` shows visible projects (pruning dead roots on read), `hide` drops a project from the switcher while retaining it on disk, `remove` deletes the entry, and `add` (re-)surfaces a root explicitly.

**Machine-global port (`~/.claude-prove/config.json::review_ui_port`).** Because the daemon is one per-machine listener serving every project, the listen port is a machine-global setting, not a per-project one. The port resolves from the top-level `review_ui_port` key in `~/.claude-prove/config.json` (default `5174`), then an upward scan past any busy port. Pin a port across runs by setting that key; a per-project `tools.acb.config.review_ui_port` left in a `.claude/.prove.json` is informational only and no longer governs the listener. The `serve start`/`restart` `--port <N>` flag overrides resolution for a single run.

**Schema v10 → v11 — `review_ui_image` / `review_ui_tag` removed.** With no container image to pin, the migration strips the `review_ui_image` and `review_ui_tag` keys from `tools.acb.config` when present, preserving every other `acb.config` key byte-for-byte. The hop is otherwise a pure version bump. Run it via `/prove:update` (which applies the migration in its migration step) or directly with `claude-prove schema migrate --file .claude/.prove.json` at the repo root; commit the updated file and delete the generated `.bak`.

**Migration summary.** Run `/prove:update` once to land schema v11 and the stripped keys. If an earlier Docker-based version left a `prove-review` container running, remove it once with `docker rm -f prove-review` — nothing recreates it. No other action is needed; the next `/prove:review-ui` starts the native daemon.

## v3.5.0 — `smart-compaction` skill + `/prove:compact`

*(Additive — new skill and thin command wrapper, discovered automatically on plugin load; nothing to configure. The command carries `core: true`, so a regenerated CLAUDE.md lists it — run `/prove:docs` claude-md regeneration to pick it up.)* Built-in context compaction summarizes by recency and drops the claude-prove state an agent needs to reorient. The `smart-compaction` skill makes compaction survivable by leaning on prove's durable anchors instead of the summary: `anchor` (pre-compact) sweeps the session for knowledge the store doesn't hold yet — untracked follow-ups, decisions with rationale, blockers, stale task statuses — persists each through `claude-prove scrum`, writes a ≤40-line pointer file (`.prove/compact-anchors.md`: branch/run/step identity, immediate next action, in-flight file paths, gotchas), and emits paste-ready `/compact` focus instructions; `rehydrate` (post-compact) runs a deterministic reorientation sequence (`scrum status`/`next-ready`/`alerts`, `run-state current`, git state, recent decisions, `cafi context`), reloads the in-flight working set, deletes the anchor file, and resumes. Bare `/prove:compact` auto-detects the phase from the anchor file's presence. Composes with the existing SessionStart `compact`-matcher hooks (mechanical digest) — the skill is the judgment layer on top; for session-ending transfers `/prove:task handoff` remains the right tool.

## v3.3.0 — `plugin-cache-cleanup` skill + `/prove:cache-cleanup`

*(Additive — new skill and thin command wrapper, discovered automatically on plugin load; nothing to configure.)* Claude Code keeps every installed plugin version under `<plugins-root>/cache/<marketplace>/<plugin>/<version>/` and never prunes superseded ones, so agents can Glob/Grep their way into stale skills, references, and CLI code from old prove versions. The `plugin-cache-cleanup` skill discovers all plugin roots (including claude-env's `~/.claude-envs/*/plugins`), builds the active set from every `installed_plugins.json`, classifies prove version dirs as active vs stale, and deletes the stale ones behind a single human gate — never touching manifests, `marketplaces/`, `data/`, or other plugins' caches. Invoke via `/prove:cache-cleanup` or trigger phrases ("prune the plugin cache", "remove old prove versions").

## v3.2.0 — Portable plugin paths: `CLAUDE_PROVE_PLUGIN_DIR` + `install local-env` + `/prove:local-env`

*(Behavior change for dev-mode installs — one-time per-machine setup via `/prove:local-env`; installed-binary users are unaffected.)* Generated artifacts no longer bake a machine-absolute plugin checkout path. Dev-mode codegen (settings.json hook blocks, CLAUDE.md command examples, ACB runtime prompts, subagent discovery context) emits the shell-interpolated prefix `bun run "${CLAUDE_PROVE_PLUGIN_DIR:-$HOME/.claude/plugins/prove}/packages/cli/bin/run.ts"`, expanded when the command fires. Compiled-mode hook commands emit `"$HOME/.local/bin/claude-prove"` instead of the expanded home path. Git-tracked artifacts are now byte-identical across contributor machines.

- **Per-machine value** — `claude-prove install local-env --plugin-dir <checkout>` writes `env.CLAUDE_PROVE_PLUGIN_DIR` into `.claude/settings.local.json` (Claude Code auto-gitignores the file and injects its `env` block into hooks and Bash). The **`/prove:local-env`** command drives detection, confirmation, the write, and drift repair.
- **Resolution precedence** — `resolvePluginRoot()` honors `$CLAUDE_PROVE_PLUGIN_DIR` first, then `$CLAUDE_PLUGIN_ROOT`, then the marker walk-up, then `~/.claude/plugins/prove`.
- **Doctor** — new `plugin-dir-env` check verifies the value the hooks will expand to (process env → `settings.local.json` env block → default path) contains the dev entry point; `hook-paths` expands interpolated commands before verification and WARNs on leftover machine-absolute dev prefixes.
- **CLAUDE.md `@`-references** — plugin built-ins render the constant project-relative form `@.claude/prove-plugin/references/<file>.md`, resolved through a gitignored symlink chain `.claude/prove-plugin → ~/.claude-prove/latest → plugin dir`. The CLAUDE.md importer only loads project-relative paths (env vars never expand; `~/...` and absolute imports outside the project silently fail to load) but follows symlinks, so the chain is the per-machine variable: re-pointing `~/.claude-prove/latest` (done automatically by `install init`/`local-env` and `claude-md generate`) fixes every project at once. Doctor's `stable-root` check verifies the chain; the project `.gitignore` gains a `.claude/prove-plugin` entry automatically.
- **`install upgrade` provenance gate** — the compiled/dev decision comes from how the process was launched (compiled Bun binary vs `bun run` source entry), not from the resolved plugin root, so a dev machine's `CLAUDE_PROVE_PLUGIN_DIR` no longer makes the installed binary refuse to upgrade itself. `PROVE_FORCE_MODE=dev|compiled` overrides detection (test escape hatch).

**Migration (dev-mode users / plugin contributors).** Run `/prove:local-env` once per machine (or `claude-prove install local-env --plugin-dir <checkout>`), then `claude-prove install init-hooks --force` and `claude-prove claude-md generate --project-root "$(pwd)"` to regenerate the tracked artifacts, and restart the Claude Code session so the env block is injected. `/prove:update` Step 5 detects the pre-portable format and offers the regeneration. No `.claude/.prove.json` change — the config schema is untouched.

## v3.1.0 — Agent Routing Map built-in reference

*(Additive — new bundled reference auto-injected into generated CLAUDE.md, nothing to configure.)* A new `references/agent-routing.md` cheatsheet maps task cues to the correct delegation surface — which subagent, skill, or direct CLI call owns a given flow. Centerpiece: the scrum routing convention (judgment writes → `scrum-master` agent; reads and skill-internal mechanical writes → direct `claude-prove scrum`; reconciliation → hooks only; never raw `sqlite3` against `.prove/prove.db`), plus a do-not-invoke-ad-hoc table for pipeline-internal agents (`validation-agent`, `brief-judge`, `pcd-*`).

**Adoption.** The composer injects the reference as a built-in default (third entry in `PLUGIN_DEFAULT_REFERENCES`, after the CLI reference and Design Principles), so it lands automatically the next time CLAUDE.md is regenerated — `/prove:docs claude-md`, or `/prove:update` Step 8. No `.claude/.prove.json` change is needed; a user entry pointing at the same path is deduped, and `/prove:update` feature discovery excludes it from the `claude_md.references` offer list alongside the other built-ins.

## v3.1.0 — report/v2: galley-proof redesign + first-class code rendering

*(Auto-adopted — no config migration. Hand-authored `report render --file <doc.json>` inputs must move to `schema_version: "2"`.)* The report/v1 HTML renderer's visual language is redesigned and the block model learns to distinguish prose from code.

**Visual redesign ("galley proof").** Every HTML surface (brief, milestone brief, status dashboard, run timeline, decompose preview) renders as a print-grade editorial document: warm paper ground, system serif stacks (Charter/Sitka body, Iowan/Palatino display), monospace micro-labels, ledger-style tables (rules, not grids), stamped badges/callouts, automatic dark scheme via `prefers-color-scheme`, a print stylesheet, and CSS-only staggered reveal guarded by `prefers-reduced-motion`. Still self-contained: inline CSS, zero network, zero JavaScript, byte-stable.

**Code vs prose (`schema_version: "2"`).** Two additions, mirroring the GitHub/Stack Overflow pattern:

- **Inline code convention** — in flowing text nodes (paragraph text, list items, table cells, key-value values, callout bodies) a backtick-delimited span renders as an inline `<code>` chip. Label voices (headings, section titles, badge labels, callout titles, key-value keys) render backticks literally. Producers mark values with the `codeSpan` helper; an unpaired or embedded backtick stays literal.
- **`code` block kind** — `{ "type": "code", "text": "...", "label?": "..." }` renders a block-level code panel with an optional mono caption.

Built-in producers adopt the convention automatically: decompose previews chip `bash`/`assert` acceptance checks (agent/gate checks stay prose), run timelines chip run ids/step ids/commit SHAs, briefs chip decision/story ids, the status dashboard chips task/milestone ids. The decompose preview callout also pluralizes layers correctly ("4 proposed stories", formerly "storyren").

**Migration.** `report validate` and `report render` now require `schema_version: "2"` on document-input files; producer-driven actions (`brief`, `milestone-brief`, `timeline`, `status`, `decompose-preview`) need no changes.

## v3.1.0 — configurable HTML-artifact opener (`artifacts.html_open` + `--open`)

*(Config schema v9 → v10 — run `/prove:update` or `claude-prove schema migrate --file .claude/.prove.json`; the migration is a pure version bump, nothing is seeded.)* Operators consume rendered HTML artifacts (intake forms, decompose previews, briefs, dashboards, timelines) in different surfaces — an editor's embedded preview, a browser, a text editor. Two pieces:

- **`artifacts.html_open`** (optional, `.claude/.prove.json`) — a shell command template; `{file}` is replaced with the quoted artifact path (a template without the placeholder gets the path appended). Examples: `"cursor {file}"`, `"open -a Safari {file}"`, `"xdg-open {file}"`. Empty/absent = the platform default opener (macOS `open`, Windows `start`, else `xdg-open`).
- **`--open` flag** on `report` (`render`/`brief`/`milestone-brief`/`timeline`/`status`/`decompose-preview`) and `intake render` — after writing `--out`, hands the artifact to the configured opener. Requires `--out`; the viewer is spawned detached, and a launch failure degrades to a stderr warning with exit 0 (it never masks the successful write).

The `intake` and `decompose` skills pass `--open` when rendering operator-facing artifacts, so a Cursor user sets `"artifacts": { "html_open": "cursor {file}" }` once and every intake form / decompose preview lands in their editor.

## v3.0.0 — Structured-agent methodology on prove machinery

*(One major release.)* Layered role-driven decomposition, AC-gated story close, risk-forward briefs, durable curation, contributor identity, trigger bindings, HTML report/intake surfaces, and a CLI robustness pass — shipped together as v3.0.0. Each subsection below documents one surface and its migration steps; run `/prove:update` once to adopt everything (config schema lands at v9, run-state schema at v4).

### CLI robustness hardening: clean failures, honest exit codes

*(Behavior changes, no config migration and nothing to adopt — review the consumer-contract notes below only if you script against CLI output.)* A hardening sweep across run-state, scrum, schema, pcd, acb, install, notify, report, claude-md, and cafi. Two systemic fixes plus targeted contract changes:

- **Corrupt artifacts fail clean.** Every on-disk artifact read (`plan.json`, `state.json`, triage/collapsed manifests, report inputs, schema configs) reports a one-line error and exits 1 instead of escaping as a raw `SyntaxError` stack trace.
- **Durable writes win.** Commands that commit a store row and then run a secondary write (contributor/team artifact mirrors, milestone-close curation, charter sync) emit the result JSON immediately after the commit; a secondary failure degrades to a stderr warning with exit 0 instead of masking the successful write as a command failure. `scrum decision recover` is now transactional — a mid-walk git failure rolls back every recovered row.
- **`schema validate` / `diff` error channel.** FAIL summaries, per-error lines, and warnings move from stdout to stderr; stdout carries only the PASS line. Consumers parsing validation failures from stdout must read stderr.
- **`run-state migrate` sweep isolation.** A corrupt run no longer aborts the remaining sweep. Summary format is `N processed, M failed` (was `N runs processed`); exit 1 only when failures exist.
- **`install upgrade` content-type check.** An HTML-denylist replaces the binary allowlist: any content-type is accepted except HTML/XHTML (or a body opening with an HTML doctype), so an upstream CDN content-type change cannot break upgrades.
- **Bootstrap never migrates `schema_version`.** Re-emitting `.claude/.prove.json` preserves an older on-disk version so `schema migrate` owns the upgrade; a newer on-disk version now errors (downgrade guard) instead of being silently relabeled.
- **Reporters time out.** `notify dispatch` kills a reporter process after 10s and continues with a warning; a hung reporter previously wedged the dispatcher indefinitely.
- **`report` inputs are shape-checked.** `brief`, `milestone-brief`, `timeline`, and `decompose-preview` validate the input file's shape and exit 1 with a readable message instead of crashing on a wrong-typed file.
- **`store info` survives a fresh database.** It reports v0 per domain instead of throwing `no such table: _migrations_log`.
- **Hooks cannot brick a session.** The scrum Stop/SubagentStop hooks survive a removed-worktree cwd, and the bounds PreToolUse hook passes permissively on malformed bounds rows; the SubagentStop message now surfaces the reason when a story-close floor blocks a task transition.
- **YAML frontmatter is quote-safe.** Contributor and team artifact writers escape scalars that would corrupt YAML (colons, leading specials, boolean/null keywords).
- **Performance.** `scrum status` computes the tree rollup in a single pass (previously one store query per node per level); `cafi status`/index reuse cached hashes for files whose mtime+size are unchanged (stat-only fast path, additive cache fields, no cache invalidation); glob `**` matching is memoized, collapsing exponential backtracking.


### Interactive intake forms: `intake/v1` + the `/prove:intake` skill

*(Additive — new `intake` CLI topic + `intake` skill, nothing to adopt.)* A self-contained interactive HTML form surface for the charter, team, and decomposition-kickoff Q&A. The operator fills the form, copies the answers to the clipboard, and pastes them back; a skill validates the payload and drives the **same** writer the conversational interview drives. The form and the conversation are two front-ends to one writer.

**The model.** An `IntakeForm` is `{ schema_version: "1", form, title, description?, fields[] }`. Each field is `{ id, label, type, required?, help?, placeholder?, choices?, default? }` over a **closed** type set: `text` · `textarea` · `choice` · `multichoice` · `boolean`. `secret` and `file` are **known-but-forbidden** — spec validation rejects them with a security message, because a token or a local path would travel in plaintext through the clipboard step. This is a sibling of report/v1, not an extension: report/v1 renders data outward (snapshot-stable, no JS); a form takes input back (interactive), so it owns its own model.

**New CLI — `intake <action>`:**
- `render --form <name> | --file <spec.json> [--out <path>]` — render a form to a complete self-contained interactive HTML page (inline CSS + JS, no network; a Copy-payload control with a select-and-copy fallback for `file://`).
- `validate --form <name> | --file <spec.json> --payload <p.json>` — PASS/FAIL a pasted-back payload against the form (envelope, required fields, value types, choice membership). The authoritative gate before any write.
- `spec --form <name> | --file <spec.json> [--out <path>]` — emit the resolved form spec JSON (inspect/extend).
- `list` — name the built-in forms (`charter`, `decompose`, `team`).

**New skill — `/prove:intake`** renders the form, walks the operator through fill → copy → paste, validates the payload, and maps the validated answers onto the existing writer: bootstrap scaffold + authoring for `charter`, `scrum team create`/`scope-set`/`rotate` for `team`, and the decompose ladder for `decompose`. It never reimplements a writer.


### HTML rendering surface: report/v1 block-document renderer

*(Additive — new `report` CLI topic, nothing to adopt.)* A single closed **report/v1** block-document model that every HTML surface compiles to, plus a vendored static renderer that maps blocks → a self-contained HTML page. Authors emit blocks (or the renderer compiles their data shape); one vendored renderer covers every surface (Review Brief, status dashboard, run timeline, decomposition preview).

**The model.** A `ReportDocument` is `{ schema_version: "1", title, blocks[] }` over a **closed** block set: `heading` · `paragraph` · `list` · `table` · `badge` · `keyValue` · `callout` · `section` (nests) · `divider`. Badges and callouts carry a closed `tone` (`neutral` · `info` · `success` · `warn` · `danger`). Adding a block kind is a deliberate model change.

**New CLI — `report <action>`** (every action writes to `--out` or stdout):
- `render --file <doc.json>` — render a report/v1 document to a complete self-contained HTML page (inline CSS, no network, every text node HTML-escaped, byte-stable).
- `validate --file <doc.json>` — validate a document against the closed model, reporting every problem with a JSON-path.
- `brief --file <brief.json>` / `milestone-brief --file <mb.json>` — mechanically compile a Review/Milestone Brief into report/v1 and render it (HTML beside the markdown).
- `timeline --file <state.json>` — compile a run-state state.json into a run-timeline view (run header + per-task step tables).
- `status [--workspace-root <p>]` — read the scrum store and render the tree-aware rollup dashboard (milestones + depth-indented task forest + active tasks).
- `decompose-preview --file <children.json>` — compile a decompose ladder's proposed child list into a preview the operator reviews before the accept gate (the decompose skill renders it inline before the `proposed → accepted` gate).

(The interactive intake-form surface is a separate effort and is not part of this entry.)


### Passive triggers & opt-in unattended-execution recipe

*(Docs — no schema change, nothing to adopt.)* A new reference, `references/passive-triggers.md`, documents the three-mechanism trigger model and the opt-in unattended-execution recipe:

- **Intra-run** — the trigger is the next `/workflows` statement (deterministic control flow).
- **Cross-session** — the scrum reconciler *surfaces* (does not auto-execute) bound next-actions from the `triggers[]` table via the session-start digest and `scrum next-ready` / `scrum alerts`.
- **Opt-in unattended** — a `/loop` (same machine, session open) or scheduled-remote-agent (`/schedule`, recurring) driver that drains `claude-prove scrum next-ready` hands-off. prove ships no scheduler of its own — both recipes use Claude Code's own scheduling primitives.

Explicit trade: **no autonomous progression between sessions unless the opt-in driver is configured** — prove trades unattended firing for zero operational surface (no resident daemon).


### Trigger binding table honored by the reconciler (config schema v8→v9)

*(Additive — one-time `/prove:update` stamp; absent `triggers` preserves current behavior.)* A declared trigger table maps a **status-transition → bound next-action**, and the scrum reconciler consults it on session transitions — realizing the common cases of passive triggers without a resident evaluator.

**New config field — `triggers`** in `.claude/.prove.json` (`PROVE_SCHEMA`): a list of bindings, each `{ on, workflow, description? }`:

```jsonc
"triggers": [
  { "on": "accepted", "workflow": "decompose", "description": "fire the next-layer decompose" },
  { "on": "ready",    "workflow": "orchestrate" }
]
```

- **`on`** — the task status whose entry fires the binding (closed enum: `backlog` `proposed` `accepted` `ready` `in_progress` `review` `blocked` `done` `cancelled`).
- **`workflow`** — the bound next-action the reconciler surfaces (a workflow name or short label).

**How it's honored.** The session-start scrum hook consults the table and surfaces a **bound next-actions** section in its digest: every non-terminal task currently sitting in a triggering status yields one pending next-action the next driver should take. There is **no resident evaluator** — bindings fire only when a session reconciles; intra-run, a workflow script branches directly. A malformed or absent config yields no bindings (the hook never breaks).

**Migration — config schema v8 → v9:** `CURRENT_SCHEMA_VERSION` `'8' → '9'`. The hop is a pure version bump (`triggers` is optional; absent = no bindings, the v8 behavior). Run `/prove:update` (or `claude-prove schema migrate --file .claude/.prove.json`) at the repo root; commit the updated file and delete the generated `.bak`.


### Durable workflow run records: retry/loop/fanout/on_fail/singleton (run-state schema v3→v4)

*(Additive — run-state plan schema `v3 → v4`; a pure version bump, absent block preserves current behavior.)* A plan task gains an optional `execution` block of declarative directives the workflow/orchestrator driver honors and the durable run record persists:

- **`retry: { max: N }`** — re-dispatch on terminal failure up to `N` times before halt-and-drain.
- **`loop: { max_iterations: N }`** — repeat the task body until its exit condition or `N` iterations (`N` is the runaway floor, not a target).
- **`fanout: { batch_size: N }`** — fan the task's sub-work out `N`-wide; larger sets split into sequential batches at the cap.
- **`on_fail: <task-id>`** — branch to the named task on terminal failure instead of halting the branch.
- **`concurrency: parallel | singleton`** — `singleton` caps the task at one in-flight instance across the run (a story-close task runs `singleton`); `parallel` imposes no limit.

Absent block = run-once / no-retry / no-loop / fan-out 1 / halt-on-fail / parallel — exactly the pre-v4 behavior, so existing runs are unaffected. **Migration:** run-state artifacts hop `v3 → v4` via `claude-prove run-state migrate` (a pure version bump — no field is injected); new runs emit `v4`. The driver patterns for honoring each directive live in the workflow skill (`skills/workflow/SKILL.md`).


### `proposed`/`accepted` decomposition-review task states

*(Additive — no migration, nothing to adopt.)* Two new `TaskStatus` values split apart what `backlog` and `ready` used to conflate:

- **`proposed`** — decomposed into children, awaiting the decomposition review.
- **`accepted`** — the decomposition review passed; this is the gate that fires the next layer's decompose, distinct from `ready` (deps cleared, implementation may start).

**Lifecycle** — `backlog → proposed → accepted → ready → in_progress → review → done`, plus `proposed → backlog` (review kickback). The direct `backlog → ready|in_progress` edges remain for tasks needing no decomposition review. Both states surface as active in `scrum status` and roll up through `derivedStatus` (precedence `ready > accepted > proposed > backlog`).

**No migration.** `scrum_tasks.status` is CHECK-free TEXT (same as the event-kind column), so the enum extends with no DB change and existing databases stay forward-compatible — the schema version does not move. Set the states via `scrum task status <id> proposed|accepted`.


### Record acceptance-criterion verdicts from the CLI (`scrum task acceptance verify`)

*(Bug fix — no schema change, no migration, nothing to adopt.)* Closes a close-floor deadlock: a `layer=story` task carrying `verifies_by: agent` (or any heavy-kind) acceptance criteria could not reach `done`, because the close floor reads `verification.verdict === 'verified'` and nothing wired that recording to a CLI. The verdict for an `agent` criterion is judged driver-side and was therefore unrecordable out-of-turn — the story wedged at close.

**New verb — `scrum task acceptance verify <task-id> --verdict verified|failed [--criterion ID] [--reason R] [--by WHO]`.** Stamps the recorded verification verdict the story-close floor reads:
- With `--criterion <id>`: records one criterion's verdict.
- Without `--criterion`: records the verdict on every *active, applies-to-self, non-`gate`* criterion on the task (the whole-task form). Skips `gate` criteria (their verdict lives in `gate.verdict`, resolved via `scrum gate respond`), superseded criteria, and `descendants`-scoped goalposts.
- `--by` is the verification contributor of record (else the run env `PROVE_WORKER_ID`, else NULL); `--reason` carries the failing detail on a `failed` verdict.
- Targeting a `gate` criterion, or a verify with no applicable non-gate criterion, exits non-zero with guidance.

This is the symmetric counterpart to `scrum gate respond` (which records the human verdict for `gate` criteria): `verify` records the engine/driver verdict for `assert`/`bash`/`agent` criteria out-of-turn, complementing the orchestrator validation gate's inline recording.


### Inter-agent communication: cross-team asks, escalations, handoff enforcement

A cross-team request protocol, a typed escalation chain with staleness auto-promotion, and an enforced end-of-session declaration — so blocked work routes to the team that owns the interface, unresolved blockers climb the authority chain on their own, and no worker session ends without recording its outcome.

- **Scrum store** (`.prove/prove.db`): advances **v22 → v26** across four additive migrations — **auto-migrates** on the next `claude-prove scrum …` command (or `claude-prove store migrate`); no manual step, no data loss (every migration is `CREATE TABLE` / `ALTER TABLE ADD COLUMN`, nullable).
  - **v23** — `scrum_asks` (the cross-team ask table).
  - **v24** — `scrum_escalations` (the escalation table + four-state machine).
  - **v25** — `scrum_asks.mapped_artifact` / `rejected_reason` / `counter_proposal` (ask-response provenance).
  - **v26** — `scrum_escalations.attributes` (the staleness auto-bubble marker).

**Cross-team ask protocol — `scrum ask file|respond|await`.** A worker whose artifact is blocked on another team's interface files an ask against that team:
- `scrum ask file --from-team A --to-team B --ask-type T --blocking-artifact ART` — persists a `filed` ask. Validates that team `B` resolves, that `T` is in `B`'s active accepted interface, and that `ART` exists; each failure exits non-zero.
- `scrum ask respond <ask-id> --verdict accept|reject|counter [--comment TEXT] [--by ID]` — mechanically applies a triage verdict. `accept` creates one child task under the responding team (tagged with its slug), sets `mapped_artifact`, and adds a `blocked_by` dep from the filing artifact onto that child; `reject` records the reason; `counter` records the counter-proposal. Every verdict emits an `ask_responded` event. The triage *judgment* is the driver's; the CLI only records it (no model is spawned).
- `scrum ask await <ask-id>` — a read-only status probe returning a closed-enum phase (`pending` | `waiting` | `ready` | `rejected` | `countered`) plus, on `ready`, the responding team's exposed outputs. The single `terminal` flag tells a polling loop when to stop.

**Escalation protocol — `scrum escalation raise|show|list|resolve|chain`.** A typed escalation (`blocked` | `ambiguous` | `conflict` | `missing_context`) walks up a fixed authority chain (`implementer → engineer → tech_lead → pm → strategy → human`) exactly one rung at a time. The receiver resolves it (`resolve` | `re_decompose` | `re_escalate`); `re_escalate` appends a fresh open escalation one rung up, linked to the closed one, so a single escalation that climbs the chain is a traversable series of rows rather than an in-place mutation.

**Escalation staleness auto-bubble.** An open escalation older than the staleness threshold (24h) auto-promotes one rung — a fresh escalation is filed up-chain and the original flips to `auto_bubbled` with a forward pointer. There is **no resident loop**: the sweep runs inside the session-start reconciler hook and surfaces bubbled escalations through `scrum alerts` and `scrum next-ready` ranking.

**Enforced end-of-session handoff/synthesis declaration.** *(Behavior change.)* `scrum hook stop` and `scrum hook subagent-stop` now **block** a session that touched an artifact unless it logged either a `synthesis` entry with `outcome: completed` or a `synthesis` entry plus a `handoff` entry carrying a reason from the closed set (`context_budget` | `blocked` | `checkpoint` | `scope_boundary` | `needs_decision`). The block emits actionable remediation telling the worker exactly what to log; sessions that touched nothing, or that already declared an outcome, pass unchanged.

**Workflow sugar — `kind:<team-slug>` step.** The workflow skill documents a step form that composes the above: file an ask → the responding team triages → poll `scrum ask await` until terminal → collect the exposed outputs on accept; reject/counter surface a terminal result rather than hanging.

**Auto-adoption.** The store migration is automatic on the next scrum command. The only behavior you must be aware of is the end-of-session gate: a worker session that edits files must now declare a `synthesis` outcome (or a `synthesis` + `handoff`) before it ends, or the stop hook will block and tell it what to write.

### User-level config: project-root → default contributor

A per-user (home-directory) config that maps a project root to a default contributor CT-UUID, so the active contributor is **implicit per project** — callers resolve "who am I driving as here?" without passing it on every invocation.

- **No schema change, no store table.** This is a home-dir dotfile, not project DB state. It carries no migration and `/prove:update` does not touch it.

**Config file.** `${XDG_CONFIG_HOME:-~/.config}/claude-prove/config.json` (XDG-honored, else `~/.config`). Shape:

```json
{ "default_contributors": { "<absolute-project-root>": "<CT-UUID>" } }
```

Reads tolerate an absent file (treated as an empty mapping) and raise a clear, path-anchored error on a malformed file. Writes create the directory if missing, preserve unrelated top-level keys, and write atomically.

**CLI — `scrum contributor default set|show`.**
- `scrum contributor default set [--project-root P] --id <CT-UUID>` — record the mapping for project root `P` (default: cwd). `--id` is required.
- `scrum contributor default show [--project-root P]` — print the resolved CT-UUID for `P`, or `null` when the root is unmapped (a sane fallback, never an error).

The mapping is **store-independent**: this verb never opens `.prove/prove.db`. The CT-UUID is stored verbatim and is **not** validated against any single project's registry — the config spans every project on the machine, so a CT-UUID minted in one project is meaningless to another's store. The caller resolves the returned CT-UUID against the relevant project's registry.

**Auto-adoption.** None required — the config is created the first time you run `scrum contributor default set`. Until then, `default show` resolves to `null` everywhere (the implicit-default mechanism is simply inactive).

### Operator-of-record: point-in-time (historical) attribution

The single role slot that exists today — **operator-of-record** — recorded as a position history, so an action attributes to whoever held the role **at the action's timestamp**, not merely the current holder.

- **Scrum store** (`.prove/prove.db`): advances to **v13** (new `scrum_operator_history` table) — **auto-migrates** on the next `claude-prove scrum …` command (or `claude-prove store migrate`); no manual step.

**Position-history table + point-in-time resolution.** A new `scrum_operator_history` table holds one row per held interval: `contributor_id` (a `scrum_contributors` CT-UUID — the holder), `from_ts` (when they took the role), and `to_ts` (when they handed it off, or `NULL` for the current holder). At most one open (`to_ts IS NULL`) row exists at a time — setting a new holder closes the prior row's `to_ts` to the new `from_ts`, then appends a fresh open row, all in one transaction. Resolving at an instant `t` returns the holder whose half-open interval `[from_ts, to_ts)` contains `t` — so an action stamped before a handoff attributes to the historical holder, not the current one.

**Charter records the current holder.** The `charter.md` identity artifact scaffolded by `claude-prove install bootstrap-identity` gains an `operator_of_record` frontmatter field (a contributor CT-UUID, `null` until a holder is set). `scrum operator set` keeps it in sync with the open interval. The canonical history lives in the table; the field is the file-side mirror of the current holder.

**CLI — `scrum operator set|resolve|history`.**
- `scrum operator set --contributor <CT-UUID> [--from-ts <ISO>]` — set / transfer the operator-of-record, appending a new open interval (closing the prior one) and syncing `charter.md`. `--from-ts` backdates the handoff (default: now). The contributor must be registered.
- `scrum operator resolve --at <ISO>` — resolve the contributor who held the role at that instant (the interval containing it), **not** the current holder; exits 1 when no holder was in effect.
- `scrum operator history [--human]` — print the full position history, oldest interval first.

**Auto-adoption.** The schema migrates automatically; the charter field and the CLI surface are opt-in (used when you set an operator-of-record). Re-running `claude-prove install bootstrap-identity` on a project whose `charter.md` predates this version leaves the existing file untouched (upgrade-preserve) — add the `operator_of_record: null` frontmatter line by hand, or it is written the first time `scrum operator set` runs.

### Contributor registry: stable CT-UUIDs + github/email resolution

A contributor registry that resolves an executing worker or event author to a stable contributor identity — the backing for role rosters, attribution, and PR-comment author matching.

- **Scrum store** (`.prove/prove.db`): advances to **v12** (new `scrum_contributors` table) — **auto-migrates** on the next `claude-prove scrum …` command (or `claude-prove store migrate`); no manual step.

**Registry table + stable CT-UUIDs.** A new `scrum_contributors` table holds one row per contributor: `id` (a CT-prefixed stable id, e.g. `ct-jane-doe-<uuid>`, minted once and never changed so attribution survives a renamed handle or email), `slug` (unique handle), `status` (`active | inactive`), `display_name`, `github`, `email`, plus the same `created_by`/`created_at`/`last_modified_by`/`last_modified_at` provenance columns the other scrum tables carry.

**CLI — `scrum contributor register|list|resolve`.**
- `scrum contributor register --slug <s> [--display-name N] [--github G] [--email E] [--id CT-UUID] [--status active|inactive]` — mints a CT-UUID (or accepts an explicit `--id`), inserts the row, and scaffolds an on-disk `contributors/<slug>.md` identity artifact whose frontmatter mirrors the row (`schema_version` + `provenance` block + the `{id, slug, status, display_name, github, email}` registry fields). This extends — does not compete with — the `contributor` artifact `claude-prove install bootstrap-identity` scaffolds.
- `scrum contributor list [--status active|inactive] [--human]` — lists the registry, ordered by slug.
- `scrum contributor resolve [--github G] [--email E]` — maps a worker / event author to a contributor by **github match first, then email fallback** (both case-insensitive); exits 1 on a miss. This is how a task row's `created_by` / `last_modified_by` / `worker_id` provenance resolves to a contributor identity.

### Methodology parity: reasoning Brief, milestone-close curation, escalation typing, initiative tier

A feature batch raising the structured-agent methodology on prove machinery to parity: a trustworthy reasoning **Review Brief** with a mechanical preservation gate, a milestone-close **curation** pass that lifts findings into durable memory, typed escalations that auto-rank into the ready queue, a milestone-grouping **initiative** tier, and a set of integrity floors on the story-close lifecycle. Two distinct schema versions advance — they migrate by **separate** paths, so do not conflate them:

- **Config schema** (`.claude/.prove.json`, `PROVE_SCHEMA`): **v7 → v8** — needs a one-time migration via `/prove:update` (or `claude-prove schema migrate --file .claude/.prove.json`).
- **Scrum store** (`.prove/prove.db`): advances to **v11** (v8 decision kind, v9 task provenance, v10 milestone initiative, v11 executing-worker/run attribution) — **auto-migrates** on the next `claude-prove scrum …` command (or `claude-prove store migrate`); no manual step.

**Reasoning Review Brief — `acb brief render|validate`.** A new synthesizer turns a run's reasoning log into the 7-section risk-forward Review Brief (Section 2 "Needs your attention" ordered hack > risk > open-assumption, reverse-chronological). The judgment half is a driver skill — **`reasoning-brief`** (`skills/reasoning-brief/SKILL.md`) — consuming `deriveEpisodes()` output plus the git diff; over a token threshold the episodes are chunked and synthesized across multiple passes (`acb brief chunk`). The mechanical half is a **Stage-1 preservation validator** (`acb brief validate`): it verifies every `hack`/`risk`/`bailout`/open-assumption finding and every decision's alternatives is present in the brief — without that gate the brief is advisory, not trustworthy. An optional non-blocking **Stage-2 prose judge** (the `brief-judge` agent) scores synthesized prose and records a failure as a risk entry rather than blocking the pipeline.

**Milestone-level Brief — `acb milestone-brief render|validate --milestone <id>`.** A stakeholder rollup that recursively aggregates the per-story briefs of a milestone, with the same mechanical preservation guarantee applied recursively (every child finding must survive into the rollup).

**Journal → Codex curation + decision kind taxonomy.** Milestone close now triggers a **curation** pass — the **`curate`** skill (`skills/curate/SKILL.md`) lifts durable reasoning-log findings into `scrum_decisions` so they survive the session that found them. Decisions gain an optional **kind** subtype — the closed set `adr | glossary | pattern`:
- `scrum decision record <path> --kind <adr|glossary|pattern>` — tag a decision's subtype on record (an unknown value exits 1; the column itself stays free TEXT, forward-compatible).
- `scrum decision list --kind <k>` — filter the decision list to one subtype.

**Structured escalation typing + staleness auto-bubble.** Escalations now carry a typed reason from the closed set `blocked | ambiguous | conflict | missing_context`. Open escalations are ranked by staleness and auto-bubble into the ready queue: `scrum next-ready` annotates each candidate's rationale with an `escalation=<boost>(<type>)` term, and `scrum alerts` reports open escalations alongside stalled WIP and orphan runs.

**Stale-memory review — `scrum decision review-stale [--days N]`.** Reports decisions older than the threshold (default 90, configurable via `memory.stale_threshold_days`), oldest-first, excluding superseded rows. **Report-only** — staleness never prunes or supersedes a decision.

**Tree-aware `scrum status`.** The status view renders the epic → story → task containment tree with each node's rolled-up derived status, rather than a flat task list. Parent-less tasks render as single-node roots, so pre-tree stores are unaffected.

**Cancel cascade + terminal provenance.** `scrum task cancel <id> [--cascade] [--reason R] [--detail D]` cancels a task — or, with `--cascade`, every non-terminal descendant in its `parent_id` subtree — and records terminal provenance (`terminal_reason` on the root, `parent_cancelled` on cascade descendants; an optional `terminal_detail`). This is the supersede / re-decompose lifecycle: cancel a subtree, then re-decompose under a fresh parent.

**Story-close integrity floors** (store-enforced, so the CLI and the reconciler both inherit them):
- **AC mid-flight freeze** — acceptance criteria are frozen while a `layer=story` task is `in_progress`; `task acceptance add|supersede` is rejected until the worker is moved off `in_progress`.
- **Mandatory synthesis floor** — a `layer=story` task cannot reach `done` unless its most-recent linked run carries a `synthesis` reasoning-log entry. Run-gated: a story with no linked run is exempt.

**Initiative tier above milestone.** A new `scrum_milestones.initiative` grouping column ties several milestones to one outcome bet — the tier above milestone. `scrum milestone create --initiative <label>` tags a milestone; `scrum milestone list --initiative <label>` filters to one initiative. NULL = the milestone belongs to no initiative (the flat default).

**Typed decompose-layer personas.** The `decompose` skill now applies a layer-typed planning persona at each rung of the ladder (the epic planner, the story planner, the task planner each reason in a role calibrated to that layer's altitude), rather than one generic decomposition prompt for all layers.

**Interrupt model — cancel-and-redispatch floor + cooperative checkpoint-interrupt.** Two layered interrupt mechanisms for in-flight workers: a Layer-1 **cancel-and-redispatch** floor (a hard stop that cancels a dispatched worker and re-dispatches fresh work) and a Layer-2 **cooperative checkpoint-interrupt** (a committed worker observes a CANCEL flag at safe checkpoints and yields cleanly without losing committed progress).

**Per-artifact provenance + executing attribution.** Scrum tasks carry a reusable provenance block — `created_by`, `created_at`, `last_modified_by`, `last_modified_at`, plus `worker_id`/`run_id` recording which worker and run last wrote the row (sourced from `PROVE_WORKER_ID`/`PROVE_RUN_SLUG`, NULL when absent). `scrum task show` surfaces it. This block is the shared shape that file artifacts (charter/team/contributor) mirror in their frontmatter.

**Project-identity bootstrap — `/prove:init` charter/team/contributor.** `/prove:init` extends beyond tech-stack detection: `claude-prove install bootstrap-identity` (with `--with-charter | --with-team | --full | --form`) runs pre-flight checks (git work tree, clean tree, integration branch, CLI on PATH), then scaffolds `charter.md`, `team.md`, and a `contributors/<id>.md` record — each carrying the `schema_version` + `provenance` frontmatter block. Re-running is upgrade-preserving: it adds only missing artifacts and never overwrites an existing one.

**Acceptance-criteria completion.** The acceptance/verification system gains four pieces: (1) an `assert`-kind **expression grammar** — a closed boolean grammar (comparisons + `and`/`or`/`not`) over run/plan context (`run.status`, `task.status`, `validator.*`, …), parsed to an AST and evaluated in-process, no shell, no `eval`; an unknown accessor/operator is a typed error, never a silent pass. (2) **`shared_acceptance` scope** — a criterion carries an optional closed-enum `scope` (`descendants | self | both`) gating copy-down to child tasks; `scrum task acceptance add --scope <s>` sets it, and absent scope preserves the prior copy-down default. (3) **Write-isolated verification** — a `bash`/`agent` criterion verifies inside an ephemeral detached worktree cut from story HEAD (native wall-clock timeout, failure transcript persisted, worktree always torn down), so a check cannot mutate the real tree and parallel evaluation is safe. (4) **`gate`-kind respond flow** — a human-decided criterion holds a persisted verdict (`gate_pending → approved | rejected`) resolved pull-based via `scrum gate respond <criterion-id> approve|reject --task <id> [--comment]` (or an interactive turn / session-start surfacing), recording the responder; never a blocking daemon.

**Acceptance verification is enforced, not just declared.** A `verifyTaskAcceptance` entry point evaluates each applicable criterion by kind (honoring `scope`) and is wired into the story-close floor: a `layer=story` task can no longer reach `done` while an applicable `gate` is unapproved or an applicable `assert`/`bash`/`agent` verdict is non-`verified`. Cheap kinds (gate, assert) resolve at the floor; heavy kinds (bash/agent worktree runs) are evaluated at the orchestrator gate, which records a verdict the floor reads — the floor never runs a worktree itself. `scrum alerts` also surfaces open `gate_pending` criteria (task + criterion id + the exact `scrum gate respond` resolver) so out-of-turn gates bubble up. The `decompose` skill is hardened from real exercise: stories are born with acceptance criteria (the ladder authors them at creation, satisfying the story-acceptance floor); the story-close Review Brief draws from the flat `acb log list` stream (a pure-verification close has no decision-anchored episodes); and a named story-close step promotes durable reasoning-log `decision` entries into the decision store via `scrum decision record`, human-gated — the per-story analogue of the milestone-close `curate` pass.

**Declared bounds become a native enforcement wall + mechanical capture.** A task's `bounds` (`read`/`write` path globs, `budgets`) were advisory; three native Claude Code hooks now make them load-bearing. A **PreToolUse scope wall** (`run-state hook bounds`, matcher `Read|Write|Edit|MultiEdit|Bash`) denies an Edit/Write/Read or a Bash write-target outside the active task's declared globs — emitting the canonical `permissionDecision: deny` (so the reason reaches the agent), and **permissive by construction** (absent bounds, ambiguous active task, or any resolution failure pass silently — no false blocks). A **tool_calls budget** folds into that same hook: a per-task counter soft-warns near the limit and hard-stops at it (`wall_clock_s` and `tokens` stay enforced by the subagent timeout and the workflow token budget — documented, not hook-metered). A **PostToolUse mechanical-capture** hook (matcher `*`) appends a `capture` reasoning-log entry recording the *what* (the tool + target) so agents author only the *why*; it is append-only and never blocks (always exit 0). All three resolve the active task/run from the main-worktree `.prove/prove.db` and are registered idempotently in the settings composer.

**New config knobs** (`PROVE_SCHEMA` v8, all optional with defaults — absent = the documented default, so no config edit is required):
- `brief.single_pass_token_threshold` (default `8000`) — episodes at or below this combined token count synthesize in one pass; above it, they chunk into multipass.
- `brief.max_synthesis_retries` (default `2`) — retry budget for the brief synthesis step before giving up.
- `brief.prose_judge_on` (default `true`) — whether the non-blocking Stage-2 prose judge runs.
- `memory.stale_threshold_days` (default `90`) — age past which `decision review-stale` flags a decision.
- `decomposition.auto_accept_through` (default `none`; enum `none|epic|story|task`) — the decompose layer through which children auto-promote `backlog → ready` without a human accept gate; every layer at or above the named one auto-accepts, and the gate still fires below it.

**Migration — config schema v7 → v8**: `CURRENT_SCHEMA_VERSION` bumped `'7'` → `'8'`. The hop adds the optional `brief`/`memory`/`decomposition` blocks with their defaults; no existing field is rewritten, so a v7 config migrates cleanly and configs that never set a knob inherit the defaults. **Manual step**: run `/prove:update` (or `claude-prove schema migrate --file .claude/.prove.json`) at the repo root to stamp v8; commit the updated file and delete the generated `.bak`.

**Migration — scrum store → v11**: the v8 (`scrum_decisions.kind`), v9 (`scrum_tasks.last_modified_by` + `last_modified_at`), v10 (`scrum_milestones.initiative`), and v11 (`scrum_tasks.worker_id` + `run_id`) migrations all `ADD COLUMN` with a NULL default — append-only, no existing row rewritten. **No manual step**: the unified store self-migrates on the next `claude-prove scrum …` command (or `claude-prove store migrate`). Separate from the config schema — `CURRENT_SCHEMA_VERSION` does not track it.

**On-demand run-content migration — `run-state migrate-runs` + the `run-migrate` skill.** Some methodology schema bumps need CONTENT reshaping of stored run artifacts (prose, structured findings) that no column move can do. The new `run-state migrate-runs` command is the mechanical half: it scans every run under the runs root (narrowable with `--branch`/`--slug`), detects which artifacts sit behind `CURRENT_SCHEMA_VERSION`, and emits a JSON plan naming each behind-version artifact plus the per-hop instruction file for any content reshaping it needs. It is read-only — it never calls a model and never mutates. The judgment half is the operator-invoked **`run-migrate`** skill (`skills/run-migrate/SKILL.md`): on explicit invocation it consumes the plan, reshapes the content behind an operator approval gate, and stops. This composes with the deterministic `run-state migrate`/`schema migrate` chain (which handles structural column moves) — structure first, content second — and runs only when the operator asks, never as a background or resident loop. No manual step on update: a run whose artifacts need no content reshaping is reported with empty `hops` and deferred entirely to the structural chain.

**Auto-adoption**: the `reasoning-brief`, `curate`, and `run-migrate` skills, the `brief-judge` agent, and the layer-typed `decompose` personas are discovered on plugin load after update; the `acb brief`/`acb milestone-brief`, `run-state migrate-runs`, `scrum decision --kind`, `scrum decision review-stale`, `scrum task cancel --cascade`, `scrum milestone --initiative`, `install bootstrap-identity` (the `/prove:init` charter/team/contributor bootstrap), `scrum gate respond`, and `scrum task acceptance add --scope` surfaces, plus the escalation ranking, tree-aware status, and write-isolated acceptance verification, ship in the CLI; the v11 store columns self-migrate on next open. The **only** manual step is the config schema v7 → v8 stamp — run `/prove:update` to sync.


### Skill validators in `.claude/.prove.json` (config schema v7)

Validators can now invoke an installed **skill** as a gate, alongside the existing `command` and `prompt` kinds.

**New validator field — `skill`**: a validator entry may carry `skill` (e.g. `"claude-skills:comment-audit"`) instead of `command`/`prompt`. The driver session (orchestrator / workflow) invokes the named skill via the Skill tool, scoped to the step diff, and treats its findings as the PASS/FAIL signal — one retry then halt, same as every other validator. A skill that normally edits behind a human gate runs in audit-only mode inside the validation gate (findings only, no auto-apply). The skill must be resolvable by the Skill tool (built-in, `plugin:skill`, or user skill). See `references/validation-config.md` → "Skill Validators".

```jsonc
"validators": [
  { "name": "comment-audit", "skill": "claude-skills:comment-audit", "phase": "llm" }
]
```

**Migration — config schema v6 → v7**: the `skill` field is additive and optional, so the v6→v7 hop is a pure version stamp — no existing validator is rewritten. Run `/prove:update` (or `claude-prove schema migrate --file .claude/.prove.json`) to bump the stamp; configs without a skill validator are unaffected.

**Auto-adoption**: the field ships in the config schema; `/prove:update` migrates the version stamp. No behavior change unless you add a `skill` validator.


### Phase-0 mechanical trust floors on the scrum store

Six engine-owned guards that make the already-shipped v3 data model (reasoning log, acceptance criteria, `parent_id` tree, decisions) *trustworthy*. All mechanical — no new skills or subsystems.

**Story-layer transition floors** (`ScrumStore.updateTaskStatus`, store-enforced so the CLI and the reconciler both inherit them):
- **≥1 acceptance criterion**: a `layer=story` task cannot transition to `ready`/`in_progress`/`done` with zero *active* criteria. Non-story layers are exempt.
- **Synthesis floor**: a `layer=story` task cannot reach `done` when its most-recent linked run carries no `synthesis` reasoning-log entry. Run-gated — a story with no linked run (manually driven, no worker) is exempt; the orchestrator always links a run.

**AC mid-flight freeze**: `task acceptance add|supersede` is rejected while the task is `in_progress` — interrupt the worker (move it off `in_progress`) before amending criteria.

**New CLI — `scrum task cancel <id> [--cascade] [--reason R] [--detail D]`**: cancels a task (or, with `--cascade`, every non-terminal descendant in its `parent_id` subtree) and records terminal provenance. The root carries `terminal_reason` (default `cancelled`); cascade descendants carry `parent_cancelled`. Already-terminal nodes are left untouched but their children are still swept.

**New CLI — `scrum decision review-stale [--days N] [--human]`**: reports decisions whose `recorded_at` is older than `N` days (default 90), oldest-first, excluding superseded rows. **Report-only** — never prunes or mutates.

**Tree-aware `scrum status`**: the JSON payload gains a `task_tree` (the `parent_id` forest, each node carrying its rolled-up `derived_status`), and `--human` renders a nested Task tree section. Flat (parent-less) tasks render as single-node roots — pre-v3 stores are unaffected.

**Migration — scrum store v6→v7** (`scrum_tasks.terminal_reason` + `scrum_tasks.terminal_detail`, both nullable): applied automatically on the next store open (`runMigrations`); no manual step. This is a scrum-store migration, separate from the `.claude/.prove.json` config schema — `CURRENT_SCHEMA_VERSION` is unchanged.

**Auto-adoption**: the new `task cancel`/`decision review-stale` subcommands and the status tree ship in the CLI; the v7 columns migrate on first store open. No config edit required. Run `/prove:update` to sync.


### The `decompose` skill + layered task creation

Lands two structured-agent methodologies as a driver skill on top of the foundation shipped over the prior tasks (scrum hierarchy `parent_id`/`layer`, decision supersession, first-class acceptance criteria + the four verification kinds, and the `acb` reasoning log). You are the driver Claude session — prove emits the scrum tree, the criteria, and the reasoning log, and the Agent tool / native `/workflows` does the fan-out; prove never spawns Claude.

**Breaking change.** Major release consolidating the structured-agent methodology. The bundled schema versions advance: run-state `schema_version` `1`→`3`, prove config `schema_version` →`6`, and scrum store migrations v3–v5 (hierarchy, decision supersession, acceptance criteria). On upgrade, run `/prove:update` to migrate `.claude/.prove.json` and apply `claude-prove store migrate` to the `.prove/prove.db` store.

**New skill — `decompose`** (`skills/decompose/SKILL.md`): two methodologies on prove primitives.
- **Decompose ladder**: top-down `charter/VISION → epic → story → task`. Per layer, a planning subagent emits a child list via a native structured-output schema, each child is written as a layered scrum task (`backlog` ≈ `proposed`), an `AskUserQuestion` accept gate (or `--auto-accept-through <layer>`) promotes `backlog→ready`, and the ladder recurses. Forced bubble-up on a `discovery` finding is documented for both the in-run (branch to re-plan) and across-session (`scrum task status blocked` + reconciler + `next-ready`) paths.
- **AC-gated story-close** (B2): reads a story's acceptance criteria from the scrum store (`scrum task acceptance list`, not the compiled plan), dispatches each by `verifies_by` (`bash`→exit 0, `assert`→expression, `gate`→`AskUserQuestion`, `agent`→`prove:validation-agent`), writes a `verification` reasoning-log entry per criterion plus a closing `synthesis` entry (native Write → `acb log append`, one JSON file per entry), assembles the Review Brief via the existing `acb` PR path (the multipass synthesizer is flagged as a `TODO(reasoning-brief):` future task), and then **delegates** worktree/validation/`principal-architect` review/merge to orchestrator full-mode rather than reimplementing it.

The skill embeds the canonical native `/workflows` (Workflow tool) script for each methodology as runnable-shaped `phase()`/`agent({schema})`/`parallel()`/`AskUserQuestion` control flow, referencing only verified `claude-prove` commands.

**New CLI flags — `scrum task create --parent <id> --layer <epic|story|task>`**: the `task create` action now writes layered children into the `parent_id` containment tree and tags the `layer` tier. `--layer` is validated against the closed `epic|story|task` set (exit 1 on a typo); an unknown `--parent` surfaces the store's `unknown parent_id` error as exit 1. These flags are what the decompose ladder uses to write children — the store layer already accepted `parentId`/`layer`; this wires the CLI surface.

**Migration**: none for the schema — the scrum hierarchy/AC/supersession migrations (v3–v5) shipped in the prior tasks; this release is the additive skill + CLI flags on top of them. Ensure your `.prove/prove.db` is migrated (`claude-prove store migrate`) if you are coming from before v3.

**Auto-adoption**: the `decompose` skill is discovered on plugin load after update; the `scrum task create --parent/--layer` flags ship in the CLI. No config edit required. Run `/prove:update` to sync.

### Declared task bounds: `plan.json tasks[].bounds` + prep-permissions consumes it

Lands per-task `bounds` as **declarations enforced by native permissions**, not a daemon wall.

**New plan field — `plan.json tasks[].bounds`** (run-state schema): an optional per-task block beside `worktree`:

```jsonc
"bounds": {
  "read":  ["src/auth/**"],
  "write": ["src/auth/**"],
  "tools": { "allow": ["Bash(go test *)"], "deny": ["Bash(git push *)"] },
  "budgets": { "tokens": 200000, "tool_calls": 100, "wall_clock_s": 1800 }  // ADVISORY ONLY
}
```

All sub-fields are optional; **absent `bounds` = current behavior** (unbounded). `budgets.*` are **advisory only** — claude-prove has no enforcement daemon; nothing blocks on them.

**Behavior — `prep-permissions` now consumes `tasks[].bounds`** (`skills/prep-permissions/SKILL.md`): `tools.allow`/`tools.deny` merge into native `permissions.allow`/`permissions.deny`; `write[]` is advisory — the git worktree is the write wall (native permission deny rules match a set, not its complement, so no "deny outside X" rule exists); `read[]` and `budgets` render into the task prompt as advisory guidance (no native surface). It emits ONE workspace `settings.local.json` — the **union** of all tasks' rules (known limitation: task A can use task B's tools; per-worktree isolation is deferred). `prep-permissions` is still **operator-invoked** — it is NOT auto-wired into orchestrator/workflow dispatch.

**Migration — run-state schema v1 → v2**: `CURRENT_SCHEMA_VERSION` bumped `'1'` → `'2'`. The hop (`packages/cli/src/topics/run-state/schema-migrate.ts`, `_migrate_v1_to_v2`) is a pure version bump — `bounds` is added as optional, and absent bounds preserves v1 behavior, so no data is rewritten. Existing `plan.json` files keep working unchanged; newly created plans carry `schema_version: "2"`.

**Auto-adoption**: the edited `prep-permissions` skill is picked up on plugin load after update; the new plan field is available to anyone authoring `plan.json` by hand or via `/prove:plan`. No config edit required. Run `/prove:update` to sync.

### Structured plan acceptance criteria: `plan.json tasks[]/steps[].acceptance_criteria` + compile-plan forwards the full criterion

`compile-plan` could previously forward only a criterion's **text** into the plan, dropping the structured shape (`verifies_by`/`check`/`idempotent`/`status`) the scrum store carries — so the orchestrator saw acceptance as opaque strings and could not dispatch a criterion by its verification kind. This lands the structured criterion end-to-end.

**Changed plan field — `plan.json tasks[].acceptance_criteria` and `tasks[].steps[].acceptance_criteria`** (run-state schema): list items changed from bare strings to a structured criterion dict mirroring scrum's `AcceptanceCriterion`:

```jsonc
"acceptance_criteria": [
  { "id": "c1", "text": "builds clean", "verifies_by": "bash", "check": "bun run build", "status": "active", "idempotent": true },
  { "text": "criteria authored by hand only need text" }
]
```

Only `text` is required; everything else is optional, so a bare `{ "text": "..." }` is valid and hand-authored/text-only plans keep working. `verifies_by` is the closed set `bash|assert|gate|agent`; `status` is `active|superseded`. **PRD `acceptance_criteria` are unchanged** — they remain a flat `string[]`; this only restructures the plan-task/step lists.

**Behavior — `scrum compile-plan` now forwards the full criterion**: it emits `id/text/verifies_by/check/status/idempotent` per active criterion (scrum bookkeeping fields `superseded_by`/`reason`/`inherited_from` and the task-level `policy` are not forwarded). Superseded criteria are skipped. The orchestrator task/review prompt renderers now render `text` annotated as `text (verifies_by: check)` when a verification kind is present, and tolerate a legacy v2 string (an unmigrated `plan.json`) by rendering it as its own text.

**Migration — run-state schema v2 → v3**: `CURRENT_SCHEMA_VERSION` bumped `'2'` → `'3'`. The hop (`packages/cli/src/topics/run-state/schema-migrate.ts`, `_migrate_v2_to_v3`) rewrites each plan-task/step `acceptance_criteria` **string** into `{ "text": <string> }` — no data loss, no injected fields; already-structured items pass through (idempotent on v3 data). For `prd`/`state`/`report` artifacts (no plan-task acceptance) it is a pure version bump. A v2 plan with string criteria migrates cleanly to v3, and the run-state validator does not enforce `schema_version` equality, so unmigrated v2 plans keep validating. Run `claude-prove run-state migrate` to advance on-disk artifacts.

**Auto-adoption**: the schema, migrator, and `compile-plan` change ship in the CLI; the edited orchestrator prompt renderers are picked up on plugin load. No config edit required. Run `/prove:update` to sync.

### Scrum `bounds_json` authoring column: `task create --bounds` / `task bounds` + compile-plan forwarding

The deferred scrum half of declared bounds. A scrum task can now carry **declared bounds** so a milestone-authored bound survives `compile-plan` into the plan's `tasks[].bounds` instead of being re-authored every run. Mirrors how acceptance criteria flow.

**New scrum column — `scrum_tasks.bounds_json`** (nullable JSON, matches the `acceptance_json` precedent): decoded to `ScrumTask.bounds` at the row boundary. The shape mirrors the run-state v3 plan-side `tasks[].bounds`:

```jsonc
"bounds": {
  "read":  ["src/auth/**"],
  "write": ["src/auth/**"],
  "tools": { "allow": ["Bash(go test *)"], "deny": ["Bash(git push *)"] },
  "budgets": { "tokens": 200000, "tool_calls": 100, "wall_clock_s": 1800 }
}
```

All top-level keys (`read | write | tools | budgets`) are optional; **NULL column = no authored bounds (absent = unbounded)**, the pre-migration behavior. Write-time validation rejects unknown top-level keys (a typo like `reads` fails loud); sub-field contents are not deeply type-checked (forward-compatible JSON; the run-state plan schema re-validates the forwarded shape). Enforcement is unchanged from the §2 decision: **`tools` is the only native surface** (allow/deny merge into `settings.local.json` permissions via `prep-permissions`); `read`/`write`/`budgets` are **advisory** — the git worktree is the write wall, and there is **no native deny-outside (`Edit(!glob)`) rule**. Bounds are never inherited from a parent task.

**New CLI surface** (`claude-prove scrum task`):

- `task create --title X --bounds '<json>'` — author bounds at create time.
- `task bounds set <id> --bounds '<json>'` — set/replace bounds; pass `--bounds ''` to clear (→ unbounded).
- `task bounds show <id>` — print the task's bounds object (or `null`).

`--bounds` takes a single JSON blob (bounds is a nested dict — no per-field flag explosion). Malformed JSON or an unknown top-level key exits 1.

**Behavior — `scrum compile-plan` now forwards `bounds`**: each scrum task's `bounds` is emitted verbatim into the corresponding `plan.tasks[].bounds` (the run-state v3 plan supports it). A task with no bounds emits **no `bounds` key** (absent = unbounded) — null-bounds tasks never crash compilation.

**Migration — scrum store schema v5 → v6**: a new scrum domain migration appends `ALTER TABLE scrum_tasks ADD COLUMN bounds_json TEXT;`. Append-only — v1–v5 migrations are untouched; the column defaults NULL on every existing row, so no data is rewritten. The unified store migrates on next open (any `claude-prove scrum …` command, or `claude-prove store migrate`). No manual step.

**Auto-adoption**: the column, CLI flags, and `compile-plan` forwarding ship in the CLI; the store self-migrates on next open. No config edit required. Run `/prove:update` to sync.

### Tool toggles now gate hooks: `tools.<name>.enabled:false` omits the install block + the acb hook self-gates

`tools.<name>.enabled` in `.claude/.prove.json` was **inert** for hooks — `writeSettingsHooks` emitted every canonical block regardless of the flag, and the `acb` post-commit hook fired regardless. The only way to disable a tool's hook was hand-editing `.claude/settings.json` out from under the emitter (which then drifts from the canonical shape). This wires the flag to the hook surface so a disabled tool means no hook. Surfaced by a steward audit (the flag looked like a switch but mapped to no mechanism).

**Behavior — `install init` / `install init-hooks` honor `tools.<name>.enabled`**: `writeSettingsHooks` gained a `disabledTools` option (`packages/installer/src/write-settings-hooks.ts`). A tool with `enabled:false` has its prove-owned hook block omitted on a fresh write and **removed** if already present (the event key is dropped only when no user-authored block remains). `init`/`init-hooks` read the disabled set from `.claude/.prove.json` via `disabledToolsFromConfig` (`packages/cli/src/topics/install/disabled-tools.ts`); a missing or malformed config yields an empty set — every tool stays enabled, so a broken config never silently strips hooks. **Absent flag / `enabled:true` = unchanged** (block installed), so existing installs and the byte-shape parity fixture are unaffected.

**Behavior — the `acb` post-commit hook self-gates**: `runHookPostCommit` returns silent when `tools.acb.enabled:false` (read after the commit-detection filters, so the config is touched only on real commits). Defense in depth — a `settings.json` staged while acb was enabled stops firing without a re-install. Default-on preserved: an absent or unreadable flag = enabled.

**Migration**: none — no schema change. To drop a now-disabled tool's hook block from an existing `.claude/settings.json`, re-run `claude-prove install init-hooks` (or `/prove:update`); the acb runtime gate takes effect immediately, no re-install needed.

**Auto-adoption**: the installer + hook changes ship in the CLI. After setting a tool `enabled:false`, re-run `claude-prove install init-hooks` to remove its block; the acb self-gate is automatic. Run `/prove:update` to sync.

---

## v2.8.0 — New `/prove:workflow` command: run a whole milestone (or plan.json) as a parallel fan-out

Adds the `/prove:workflow` command + skill. Point it at a **scrum milestone id** or a **`plan.json`** and it runs the dependency graph as one fan-out execution: it compiles the milestone's tasks + `blocked_by` edges into a `plan.json`, runs the tasks in parallel waves through the orchestrator's existing full-mode machinery (worktrees, validators, `principal-architect` review, sequential merge), and mirrors each task's status back to the scrum store (`task status done|blocked` + `link-run`).

The skill is deliberately thin — it reuses orchestrator full-mode rather than reimplementing it. `prove.db` stays the source of truth; the compiled `plan.json` is an ephemeral, regenerable execution view (mapped back via a `scrum-map.json` sidecar). Flags: `--backend auto|dynamic|native` (on the Claude Opus 4.8 dynamic-workflows runtime it renders a background JS driver, else runs natively), `--max-agents` (per-wave fan-out, default 16 dynamic / 4 native), `--verify <tag>` (force adversarial review on tagged tasks), `--decompose` (per-task step trees via `/prove:plan`), and `--dry-run` (print the wave plan + agent-count estimate, write/dispatch nothing).

**New CLI action — `scrum compile-plan`**: `claude-prove scrum compile-plan --milestone <id> [--out plan.json]` compiles a milestone's actionable tasks (skips `done`/`cancelled`) + `blocked_by` edges into a run-state `plan.json` plus a `scrum-map.json` sidecar. Waves are assigned by longest-path depth; `mode` is `full` at >= 4 tasks; dependency cycles error out. The emitted plan passes `run-state validate --kind plan`. This is the Phase 1 source-compile step for `/prove:workflow`; it's also usable standalone to turn a backlog milestone into an orchestrator-ready plan.

**New CLI action — `orchestrator wave-plan`**: `claude-prove orchestrator wave-plan --run-dir <dir> [--max-agents N] [--format json|md]` emits the read-only dependency-wave dispatch schedule for a compiled plan — waves split into batches capped at `--max-agents`, with `dispatch_rounds` and `peak_concurrency`. This is the substrate-agnostic scheduler both `/prove:workflow` backends consume, and the `--format md` projection backs the skill's `--dry-run`.

**Migration**: none. Net-new command + two CLI actions, no schema or config change.

**Auto-adoption**: automatic — `/prove:workflow` is a `core: true` command discovered on plugin load after update; `scrum compile-plan` and `orchestrator wave-plan` ship in the CLI. No config edit required.

Both backends are Claude Code following the skill — `native` fans out via the `Agent` tool, `dynamic` via Claude Code's dynamic-workflows preview. prove emits artifacts (plan, schedule, prompts) and the CLI commands the subagents run; it never spawns Claude itself, so there is no SDK dependency.

**Merge-conflict auto-rebound**: on a sequential merge-back conflict the workflow rebuilds the task on the updated integration HEAD and retries, up to `--max-rebounds` (default 2), instead of halting. The `claude-prove worktree reset <slug> <task-id>` command resets a task worktree to `orchestrator/<slug>` HEAD so the re-dispatched task fast-forwards on retry. On budget exhaustion it falls back to halt-and-drain (`scrum task status <id> blocked`, independent branches keep merging). Orchestrator full-mode's default halt-on-conflict is unchanged.

**Shell scripts ported to the CLI**: the two helper scripts under `skills/` are gone, replaced by hardened, tested CLI topics. `skills/orchestrator/scripts/manage-worktree.sh` → **`claude-prove worktree <create|remove|remove-all|list|path|branch|reset>`** (git calls now run through arg-arrays — no shell injection; slug/task-id validated against a safe charset; distinct exit codes for usage vs git failure). `skills/task/scripts/gather-context.sh` → **`claude-prove handoff gather --project-root <p> [--plugin-dir <d>]`** (composes Discovery + task-plan steps in-process; fixes a latent unbound-variable crash on repos with no `main`/`master`). The orchestrator, workflow, and task skills and the baked CLI error messages now point at the CLI commands.

**Migration (scripts)**: automatic on `/prove:update` — the CLI ships the new topics and the skills reference them. Any out-of-tree caller of the old `.sh` paths must switch to the `claude-prove worktree` / `claude-prove handoff` commands.

**Known follow-ups**: none for v1 — the feature is complete.

---

## v2.7.1 — Fix: `scrum task add-dep --kind blocked_by` now persists the edge

`add-dep <X> <Y> --kind blocked_by` previously returned `{"added":true}` but wrote a `blocked_by` row that no reader ever queried (`getBlockedBy`/`getBlocking`/`nextReady` all filter `kind='blocks'`), so the edge silently vanished — a data-loss-class bug ([#22](https://github.com/mjmorales/claude-prove/issues/22)). `add-dep`/`remove-dep` now normalize `blocked_by` to its canonical inverse ("X blocked_by Y" === "Y blocks X") before touching the store, so every persisted edge is a `blocks` row that all readers observe.

**Migration**: none. No schema change. Existing graphs built with `--kind blocks` are unaffected; rebuild any `blocked_by` edges that silently dropped under prior versions.

**Auto-adoption**: automatic on `/prove:update` (ships in the CLI).

---

## v2.7.0 — Schema v6: `dev_mode` flag routes codegen between installed-binary and working-tree invocation

Adds top-level `dev_mode: boolean` to `.claude/.prove.json` (schema v6). The v2.6.1 CLAUDE.md directive told user-facing markdown to always say `claude-prove`, which breaks plugin developers running from a git checkout (where `claude-prove` isn't on PATH). This release restores the dev-mode path through config: installed users (`dev_mode: false`, default) see bare `claude-prove <topic>`; plugin developers (`dev_mode: true`) see `bun run ${pluginDir}/packages/cli/bin/run.ts <topic>`. Routing applies to composer-generated CLAUDE.md sections, `composeSubagentContext`, and the ACB PostToolUse hook's MANIFEST_PROMPT.

**Schema**:

- New top-level field `dev_mode: bool` in `PROVE_SCHEMA` (optional, default `false`).
- `CURRENT_SCHEMA_VERSION` bumped to `"6"`; migration `5_to_6` seeds `dev_mode: false` when absent and preserves `dev_mode: true` idempotently.

**Codegen** (`packages/cli/src/topics/claude-md/composer.ts`):

- New `cliPrefix(devMode, pluginDir)` helper: returns `'claude-prove'` for installed mode, `\`bun run ${pluginDir}/packages/cli/bin/run.ts\`` for dev mode.
- `renderDiscovery(prefix)`, `composeSubagentContext(scan, pluginDir)`, and `renderVersionCheck(pluginVersion, prefix)` all take a prefix string. `composeSubagentContext`'s `pluginDir` arg is back (was dropped in v2.6.1) — callers should thread it again.
- Scanner lifts `data.dev_mode === true` into `scan.prove_config.dev_mode` (defaults to `false`).

**ACB hook** (`packages/cli/src/topics/acb/hook.ts`):

- New `readDevMode(workspaceRoot)` helper reads `<workspaceRoot>/.claude/.prove.json::dev_mode` at fire time (no scan cache — users may flip mid-session).
- `ManifestPromptParams` gains a required `devMode: boolean`. Dev-mode emits `bun run ${pluginDir}/packages/cli/bin/run.ts acb save-manifest ...`; installed-mode emits `claude-prove acb save-manifest ...`.

**Migration**:

- Run `/prove:update` (or `claude-prove schema migrate --file .claude/.prove.json`) to bump to schema v6 and seed `dev_mode: false`.
- **Plugin developers (this repo)**: flip the seeded value to `"dev_mode": true` in `.claude/.prove.json`, then re-run `claude-prove claude-md generate --project-root "$(pwd)" --plugin-dir "$(pwd)"` so the managed block of CLAUDE.md uses the working-tree invocation.
- **Installed users**: no action beyond `/prove:update`. The default (`dev_mode: false`) preserves the v2.6.1 bare-`claude-prove` emission.
- **Downstream TS consumers**: `composeSubagentContext(scan)` → `composeSubagentContext(scan, pluginDir)` again. `generateManifestPrompt` callers must pass `devMode: boolean`.

**CLAUDE.md directive update**:

- The **CLI Invocation in User-Facing Output** section now distinguishes three layers: hand-written markdown (always `claude-prove`), codegen (route through `dev_mode`), and runtime agent prompts (read `dev_mode` at fire time). Replaces the v2.6.1 "never thread pluginDir" bullet, which overshot once dev mode became config-routed.

---

## v2.6.1 — User-facing output drops `bun run` + absolute-path hints; `composeSubagentContext` / `renderDiscovery` lose the `pluginDir` param

New CLAUDE.md directive (**CLI Invocation in User-Facing Output**) codifies: agent-facing markdown, generated CLAUDE.md content, docs, and codegen output must invoke the CLI as bare `claude-prove <topic> <args>` — never `bun run <abs-path>/packages/cli/bin/run.ts ...`, never absolute-path pins. Applied across the plugin so the generated output matches the rule.

**Changed — codegen** (`packages/cli/src/topics/claude-md/composer.ts`):

- `renderDiscovery()` no longer takes `pluginDir` — emits `claude-prove cafi context` / `claude-prove cafi lookup <keyword>`.
- `composeSubagentContext(scan)` no longer takes an optional `pluginDir` — emits `claude-prove cafi context` / `claude-prove cafi get <path>`. **Public API change**: drop the second positional arg at call sites (`composeSubagentContext(scan, pluginDir)` → `composeSubagentContext(scan)`). TS consumers outside this repo should update their imports.
- `renderVersionCheck(pluginVersion)` no longer takes `pluginDir` — generated CLAUDE.md now says `if \`claude-prove --version\` does not match vX.Y.Z, run /prove:update` instead of `cat <abs-path>/.claude-plugin/plugin.json | grep version`.

**Changed — user-facing markdown** (bare `claude-prove` everywhere):

- `agents/{code_steward,llm-prompt-engineer,principal-architect}.md` — CAFI discovery hints.
- `commands/{doctor,init,review-ui,update}.md` — CLI invocations in fix-hints and orchestration scripts. `commands/update.md` drops the separate "Dogfooding mode" branch (Step 8); dev-mode users alias `claude-prove` to their working-tree entry point.
- `skills/{docs,index,notify,orchestrator}/SKILL.md` + `skills/orchestrator/references/reporter-protocol.md`.
- `references/claude-prove-reference.md` — invocation section collapses to a single form.

**Migration**:

- **Consumers of `composeSubagentContext(scan, pluginDir)`**: drop the second arg. No behavior change beyond the emitted command shape.
- **CLAUDE.md owners**: re-run `/prove:update` (or `claude-prove claude-md generate --project-root "$(pwd)" --plugin-dir "$PLUGIN_DIR"`) to regenerate the managed block in the new format. User-owned content outside `<!-- prove:managed:start/end -->` is preserved byte-for-byte.
- **Dev-mode users (running the plugin from source)**: `claude-prove` must resolve to your working-tree entry point. Add an alias (`alias claude-prove="bun run /path/to/claude-prove/packages/cli/bin/run.ts"`) or symlink `~/.local/bin/claude-prove` to `packages/cli/bin/run.ts` (with a bun shebang).

**Explicitly out of scope** (left unchanged):

- `packages/installer/src/resolve-binary-path.ts` + the `acb` PostToolUse hook template (`packages/cli/src/topics/acb/hook.ts`) still emit the dev-mode `bun run <plugin>/packages/cli/bin/run.ts ...` form — these are machine-executable commands written into `settings.json` hooks and hook-blocked agent prompts, not user-facing markdown. Dev-mode agents would loop on hook failure if the bare `claude-prove` form were used without a PATH alias.
- `UPDATES.md` historical entries unchanged — they document past behavior.

---

## v2.5.0 — Dep-graph CLI: `scrum task add-dep` / `remove-dep`

The dependency graph in `.prove/prove.db` (`scrum_deps` table) has been readable by `next-ready` since v1, but there was no supported way for operators or agents to *write* edges — `ScrumStore.addDep()` existed only as an internal API. This release exposes it through the `claude-prove scrum task` surface, with idempotent inserts, self-edge rejection, and additive visibility on `scrum task show`.

**New CLI**:

- `claude-prove scrum task add-dep <from> <to> [--kind blocks|blocked_by]` — records an edge in `scrum_deps`. `--kind` defaults to `blocks`, which is the direction `next-ready`/`show` consume. Idempotent on `(from, to, kind)`. Stdout: `{"added":true,"from_task_id","to_task_id","kind"}`.
- `claude-prove scrum task remove-dep <from> <to> [--kind ...]` — deletes the matching row. No-op if the edge is absent (exit 0).

**Changed**:

- `packages/cli/src/topics/scrum/cli/task-cmd.ts` — adds `add-dep` / `remove-dep` actions, `--kind` handling, and augments `show <id>` to include `blocked_by` / `blocking` arrays (pulled from `scrum_deps` with `kind='blocks'`).
- `packages/cli/src/topics/scrum.ts` — wires the `--kind` flag into the scrum dispatcher and updates the `task` sub-action usage hint.
- `agents/scrum-master.md` — documents the dep-graph flow and adds it to the agent's allowed subcommand surface.

**Migration**:

- No schema changes; `scrum_deps` already exists. No `.claude/.prove.json` fields added.
- Consumers of `scrum task show <id>` JSON: the payload gains `blocked_by` and `blocking` keys (arrays of `{from_task_id, to_task_id, kind: 'blocks'}`). Existing keys (`task`, `tags`, `events`, `runs`) are unchanged — strict JSON parsers that whitelist keys will need an update.

**Auto-adoption**:

- CLI surface is live on next `claude-prove` run — no config migration required.

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
