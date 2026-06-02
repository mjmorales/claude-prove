/**
 * Scrum domain schema — migration v1 creates every table the scrum topic
 * needs (tasks, milestones, tags, deps, events, run links, context bundles).
 *
 * Structural mirror of `packages/cli/src/topics/acb/store.ts::ACB_MIGRATION_V1_SQL`
 * plus the `ensureAcbSchemaRegistered` guard pattern. The side-effect call
 * to `registerSchema` at module scope declares the domain once; the named
 * `ensureScrumSchemaRegistered()` helper re-registers idempotently so tests
 * that call `clearRegistry()` can recover.
 *
 * Table-name convention: every domain table carries the `scrum_` prefix to
 * namespace the scrum domain within the shared store. Indexes carry the
 * `idx_scrum_` prefix.
 */

import type { Database } from 'bun:sqlite';
import { listDomains, registerSchema } from '@claude-prove/store';

// ---------------------------------------------------------------------------
// Migration v1 — all 7 tables + 5 indexes in one atomic transaction
// ---------------------------------------------------------------------------

/**
 * Core scrum schema. Order matters — FK-bearing tables reference `scrum_tasks`
 * and `scrum_milestones` which must exist first.
 *
 *   scrum_tasks           — one row per task; FK to milestone (nullable)
 *   scrum_milestones      — one row per milestone
 *   scrum_tags            — composite PK (task_id, tag)
 *   scrum_deps            — composite PK (from_task_id, to_task_id, kind)
 *   scrum_events          — append-only audit log; AUTOINCREMENT id
 *   scrum_run_links       — composite PK (task_id, run_path); links orchestrator runs
 *   scrum_context_bundles — PK task_id; cached denormalized context JSON
 */
export const SCRUM_MIGRATION_V1_SQL = `
CREATE TABLE scrum_milestones (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    target_state TEXT,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    closed_at TEXT
);

CREATE TABLE scrum_tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL,
    milestone_id TEXT REFERENCES scrum_milestones(id),
    created_by_agent TEXT,
    created_at TEXT NOT NULL,
    last_event_at TEXT,
    deleted_at TEXT
);

CREATE TABLE scrum_tags (
    task_id TEXT NOT NULL REFERENCES scrum_tasks(id),
    tag TEXT NOT NULL,
    added_at TEXT NOT NULL,
    PRIMARY KEY (task_id, tag)
);

CREATE TABLE scrum_deps (
    from_task_id TEXT NOT NULL REFERENCES scrum_tasks(id),
    to_task_id TEXT NOT NULL REFERENCES scrum_tasks(id),
    kind TEXT NOT NULL CHECK (kind IN ('blocks', 'blocked_by')),
    PRIMARY KEY (from_task_id, to_task_id, kind)
);

CREATE TABLE scrum_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES scrum_tasks(id),
    ts TEXT NOT NULL,
    kind TEXT NOT NULL,
    agent TEXT,
    payload_json TEXT NOT NULL
);

CREATE TABLE scrum_run_links (
    task_id TEXT NOT NULL REFERENCES scrum_tasks(id),
    run_path TEXT NOT NULL,
    branch TEXT,
    slug TEXT,
    linked_at TEXT NOT NULL,
    PRIMARY KEY (task_id, run_path)
);

CREATE TABLE scrum_context_bundles (
    task_id TEXT PRIMARY KEY REFERENCES scrum_tasks(id),
    rebuilt_at TEXT NOT NULL,
    bundle_json TEXT NOT NULL
);

CREATE INDEX idx_scrum_events_task_ts ON scrum_events(task_id, ts DESC);
CREATE INDEX idx_scrum_tasks_status_event ON scrum_tasks(status, last_event_at DESC);
CREATE INDEX idx_scrum_run_links_path ON scrum_run_links(run_path);
CREATE INDEX idx_scrum_deps_to_task ON scrum_deps(to_task_id);
CREATE INDEX idx_scrum_tags_tag ON scrum_tags(tag);
`;

// ---------------------------------------------------------------------------
// Migration v2 — scrum_decisions (decision-record persistence)
// ---------------------------------------------------------------------------

/**
 * v2: persist decision records as first-class rows in the scrum domain.
 *
 *   scrum_decisions — one row per decision (id = filename slug, e.g.
 *                     `decision-persistence`); `content_sha`
 *                     is `sha256(content)` hex-encoded so downstream
 *                     drift-detection can compare against the working-tree
 *                     file without re-reading it. `source_path` is
 *                     nullable because git-recovered rows may lack a
 *                     working-tree file.
 *
 * `status` defaults to `'accepted'` per decision-record convention. Indexes
 * cover the two filter dimensions used by `listDecisions` — topic and status.
 *
 * Table and index names carry the `scrum_` / `idx_scrum_` prefix per the
 * domain-namespacing contract established in v1.
 */
export const SCRUM_MIGRATION_V2_SQL = `
CREATE TABLE scrum_decisions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    topic TEXT,
    status TEXT NOT NULL DEFAULT 'accepted',
    content TEXT NOT NULL,
    source_path TEXT,
    content_sha TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    recorded_by_agent TEXT
);

CREATE INDEX idx_scrum_decisions_topic ON scrum_decisions(topic);
CREATE INDEX idx_scrum_decisions_status ON scrum_decisions(status);
`;

// ---------------------------------------------------------------------------
// Migration v3 — optional containment tree + layer tagging on scrum_tasks
// ---------------------------------------------------------------------------

/**
 * v3: add an OPTIONAL hierarchy to `scrum_tasks`. Two nullable columns plus a
 * parent index:
 *
 *   parent_id — self-FK; the containment tree (epic→story→task). Separate
 *               from `scrum_deps`, which stays purely for blocking edges.
 *               NULL = a flat, parent-less task (the unlayered shape).
 *   layer     — 'epic' | 'story' | 'task'; NULL = untiered/flat. No CHECK
 *               constraint so older databases stay forward-compatible and
 *               the vocabulary can extend without a migration.
 *
 * SQLite permits `ADD COLUMN ... REFERENCES` only because the added column's
 * default is NULL (no existing row needs a parent), so both ALTERs are safe
 * on a populated table. The parent index backs `getChildren` /
 * `derivedStatus` tree walks.
 *
 * Depth is optional: flat tasks (parent_id NULL, layer NULL) keep their exact
 * unlayered behavior.
 */
export const SCRUM_MIGRATION_V3_SQL = `
ALTER TABLE scrum_tasks ADD COLUMN parent_id TEXT REFERENCES scrum_tasks(id);
ALTER TABLE scrum_tasks ADD COLUMN layer TEXT;
CREATE INDEX idx_scrum_tasks_parent ON scrum_tasks(parent_id);
`;

// ---------------------------------------------------------------------------
// Migration v4 — append-only supersession on scrum_decisions
// ---------------------------------------------------------------------------

/**
 * v4: add append-only supersession to `scrum_decisions` — a retired record is
 * never hard-deleted; the replacement supersedes and the original stays
 * auditable. Two nullable columns, no hard-delete path:
 *
 *   superseded_by — self-FK to the replacement decision's `id`. NULL = the
 *                   decision is current (not retired). When set, the row's
 *                   `status` flips to `'superseded'` and this points at the
 *                   replacement, so the supersession graph is explicit and
 *                   the original stays auditable.
 *   reason        — free-text rationale recorded at supersession time. NULL
 *                   on every legacy row and on any decision never superseded.
 *
 * SQLite permits `ADD COLUMN ... REFERENCES` only because the added column's
 * default is NULL (no existing row needs a replacement), so the ALTER is safe
 * on a populated table. No CHECK on `status` — the column stays forward-
 * compatible TEXT (matches the v2 convention); the closed vocabulary
 * `accepted | superseded | deprecated` is documented on `DecisionRow`.
 */
export const SCRUM_MIGRATION_V4_SQL = `
ALTER TABLE scrum_decisions ADD COLUMN superseded_by TEXT REFERENCES scrum_decisions(id);
ALTER TABLE scrum_decisions ADD COLUMN reason TEXT;
`;

// ---------------------------------------------------------------------------
// Migration v5 — first-class acceptance criteria on scrum_tasks
// ---------------------------------------------------------------------------

/**
 * v5: add first-class acceptance criteria to `scrum_tasks`. One nullable JSON
 * column, matching the `scrum_context_bundles.bundle_json` JSON-column
 * precedent (no new table):
 *
 *   acceptance_json — JSON-encoded `Acceptance` object
 *                     `{ criteria: AcceptanceCriterion[], policy?: AcceptancePolicy }`.
 *                     NULL = a task with no authored acceptance (the
 *                     criteria-free shape). Decoded to `ScrumTask.acceptance`
 *                     at the row boundary in `store.ts`.
 *
 * Criteria are append-only: a retired criterion is never removed from the
 * array. Instead its `status` flips to `'superseded'` with a `reason` and an
 * optional `superseded_by` pointer — the supersession discipline mirrors v4's
 * `scrum_decisions`.
 *
 * `ADD COLUMN` with a NULL default is safe on a populated table (no existing
 * row needs acceptance). No CHECK constraint — the column stays
 * forward-compatible TEXT, with the closed `verifies_by` / `status` / policy
 * vocabularies documented on the `Acceptance` types in `types.ts`.
 */
export const SCRUM_MIGRATION_V5_SQL = `
ALTER TABLE scrum_tasks ADD COLUMN acceptance_json TEXT;
`;

// ---------------------------------------------------------------------------
// Migration v6 — optional declared bounds on scrum_tasks
// ---------------------------------------------------------------------------

/**
 * v6: add an OPTIONAL declared-bounds authoring column to `scrum_tasks` — the
 * milestone-side half of per-task bounds. One nullable JSON column, matching
 * the v5 `acceptance_json` JSON-column precedent (no new table):
 *
 *   bounds_json — JSON-encoded `TaskBounds` object
 *                 `{ read?, write?, tools?: { allow?, deny? },
 *                    budgets?: { tokens?, tool_calls?, wall_clock_s? } }`.
 *                 NULL = a task with no authored bounds (the unbounded shape).
 *                 Decoded to `ScrumTask.bounds` at the row boundary in
 *                 `store.ts`.
 *
 * The column is the optional milestone-authored authoring SOURCE: a bound set
 * here survives `compile-plan` into the emitted plan's `tasks[].bounds`
 * (mirroring the run-state v3 `TASK_PLAN_SPEC.bounds` shape) instead of being
 * re-authored every run. The canonical ENFORCEMENT input stays the ephemeral
 * `plan.json tasks[].bounds`; this column only feeds it. Enforcement split:
 * `write[]`/`read[]`/`budgets` are advisory (the git worktree is the write
 * wall), `tools` map to native permissions — there is NO native deny-outside
 * rule.
 *
 * `ADD COLUMN` with a NULL default is safe on a populated table (no existing
 * row needs bounds). No CHECK constraint — the column stays
 * forward-compatible TEXT, with the closed shape documented on the
 * `TaskBounds` type in `types.ts` and validated on write in `store.ts`.
 */
export const SCRUM_MIGRATION_V6_SQL = `
ALTER TABLE scrum_tasks ADD COLUMN bounds_json TEXT;
`;

// ---------------------------------------------------------------------------
// Migration v7 — terminal provenance on scrum_tasks
// ---------------------------------------------------------------------------

/**
 * v7: record WHY a task reached a terminal status — terminal cancel provenance
 * as a `{reason, detail}` pair. Two nullable TEXT columns, no new table:
 *
 *   terminal_reason — coarse cause, written when a task is cancelled. The
 *                     canonical closed vocabulary is `cancelled` (a direct
 *                     `task cancel`) and `parent_cancelled` (swept by a
 *                     `--cascade` walk from an ancestor). NULL on every live
 *                     task and on `done` tasks (success carries no reason).
 *   terminal_detail — free-text elaboration recorded at cancel time (e.g.
 *                     "parent 'epic-1' cancelled"). NULL when no detail given.
 *
 * `ADD COLUMN` with a NULL default is safe on a populated table (no existing
 * row needs provenance). No CHECK constraint — the column stays
 * forward-compatible TEXT, matching the v2–v6 convention; the closed
 * `terminal_reason` vocabulary is documented on `ScrumTask` in `types.ts`.
 *
 * Scope note (Phase-0): the cancel cascade + this provenance land now;
 * supersede→re-decompose (lift-vs-cancel-per-child judgment) is a later-phase
 * follow-up and writes no new column here.
 */
export const SCRUM_MIGRATION_V7_SQL = `
ALTER TABLE scrum_tasks ADD COLUMN terminal_reason TEXT;
ALTER TABLE scrum_tasks ADD COLUMN terminal_detail TEXT;
`;

// ---------------------------------------------------------------------------
// Migration v8 — Codex kind taxonomy on scrum_decisions
// ---------------------------------------------------------------------------

/**
 * v8: add an OPTIONAL `kind` to `scrum_decisions` — the decision subtype
 * taxonomy. One nullable TEXT column:
 *
 *   kind — the Codex subtype a decision belongs to. Canonical closed
 *          vocabulary `adr | glossary | pattern`; NULL = an untyped/legacy
 *          decision (every legacy row). The curation step (model-owned) sets
 *          it when promoting a reasoning-log finding into a durable decision.
 *
 * `ADD COLUMN` with a NULL default is safe on a populated table (no existing
 * row needs a kind). No CHECK constraint — the column stays forward-compatible
 * TEXT, matching the v2–v7 convention; the closed vocabulary is documented on
 * `DecisionRow` in `types.ts`.
 */
export const SCRUM_MIGRATION_V8_SQL = `
ALTER TABLE scrum_decisions ADD COLUMN kind TEXT;
`;

// ---------------------------------------------------------------------------
// Migration v9 — last-touch provenance on scrum_tasks
// ---------------------------------------------------------------------------

/**
 * v9: record WHO/WHEN last modified a task. Two nullable TEXT columns, no new
 * table:
 *
 *   last_modified_by — the agent of the most recent row mutation, where the
 *                      store method receives one (status/milestone/cancel).
 *                      NULL when the mutation carried no agent (acceptance/
 *                      bounds/soft-delete edits) or on every legacy row.
 *   last_modified_at — ISO-8601 timestamp stamped on every task-row write.
 *                      Distinct from `last_event_at` (bumped on any event
 *                      append); a future mutation that does not append an
 *                      event still moves `last_modified_at`.
 *
 * `ADD COLUMN` with a NULL default is safe on a populated table (no existing
 * row needs provenance). No CHECK — the columns stay forward-compatible TEXT,
 * matching the v2–v8 convention. `createTask` seeds the pair to
 * (`created_by_agent`, `created_at`) so a freshly-created task already carries
 * coherent last-touch provenance.
 */
export const SCRUM_MIGRATION_V9_SQL = `
ALTER TABLE scrum_tasks ADD COLUMN last_modified_by TEXT;
ALTER TABLE scrum_tasks ADD COLUMN last_modified_at TEXT;
`;

// ---------------------------------------------------------------------------
// Migration v10 — initiative grouping on scrum_milestones (the tier above milestone)
// ---------------------------------------------------------------------------

/**
 * v10: add an OPTIONAL `initiative` grouping to `scrum_milestones` — the tier
 * above milestone. One nullable TEXT column:
 *
 *   initiative — a free-text label tying several milestones to one outcome
 *                bet. NULL = the milestone belongs to no initiative (the flat
 *                default).
 *
 * `ADD COLUMN` with a NULL default is safe on a populated table (no existing
 * milestone needs an initiative). No CHECK — the column stays forward-compatible
 * TEXT, matching the grouping/subtype columns on the other tables.
 */
export const SCRUM_MIGRATION_V10_SQL = `
ALTER TABLE scrum_milestones ADD COLUMN initiative TEXT;
`;

// ---------------------------------------------------------------------------
// Migration v11 — executing-worker/run attribution on scrum_tasks
// ---------------------------------------------------------------------------

/**
 * v11: record WHICH worker/run last wrote a task — executing attribution. Two
 * nullable TEXT columns, no new table:
 *
 *   worker_id — opaque id of the executing unit (leaf worker / driver session)
 *               that last wrote the row. NULL when no worker context was in
 *               scope (a bare CLI edit) or on every legacy row.
 *   run_id    — the orchestrator run slug the write happened under. NULL when
 *               no run context was in scope or on every legacy row.
 *
 * This pair extends the last-touch provenance (`last_modified_by`/`_at`, which
 * carry the mutating AGENT and TIMESTAMP) with the executing UNIT and RUN, so a
 * task row alone answers "who, when, under which worker and run". The CLI
 * sources both from the run env the orchestrator sets at dispatch
 * (`PROVE_WORKER_ID` / `PROVE_RUN_SLUG`), defaulting NULL when absent.
 *
 * `ADD COLUMN` with a NULL default is safe on a populated table (no existing
 * row needs attribution). No CHECK — the columns stay forward-compatible TEXT,
 * matching the v2–v10 convention.
 */
export const SCRUM_MIGRATION_V11_SQL = `
ALTER TABLE scrum_tasks ADD COLUMN worker_id TEXT;
ALTER TABLE scrum_tasks ADD COLUMN run_id TEXT;
`;

// ---------------------------------------------------------------------------
// Migration v12 — contributor registry (scrum_contributors)
// ---------------------------------------------------------------------------

/**
 * v12: a contributor registry — one row per stable contributor identity, the
 * backing for role rosters, attribution, and PR-comment author matching. A new
 * table (not a column on an existing one) because a contributor is its own
 * entity, referenced from many task rows rather than owned by one:
 *
 *   scrum_contributors — `id` is a CT-prefixed stable contributor id (a
 *                        CT-UUID, e.g. `ct-jane-doe-…`) that never changes once
 *                        minted, so attribution survives a renamed handle or
 *                        email. `slug` is the human-friendly handle; `status`
 *                        is the registry lifecycle (`active`/`inactive`).
 *                        `github` and `email` are the two resolution keys —
 *                        `resolve` matches an executing worker / event author
 *                        by github first, then falls back to email.
 *
 * The row carries the same provenance columns as the on-disk `contributor.md`
 * identity artifact (`created_by`/`created_at`/`last_modified_by`/
 * `last_modified_at`) so the table and the file mirror one shape. No CHECK on
 * `status` — the column stays forward-compatible TEXT, matching the v2–v11
 * convention; the closed `active | inactive` vocabulary is documented on the
 * `Contributor` type in `types.ts`.
 *
 * Indexes back the two resolution lookups (`github`, `email`) plus the
 * `slug` uniqueness probe. Table and index names carry the `scrum_` /
 * `idx_scrum_` prefix per the domain-namespacing contract established in v1.
 */
export const SCRUM_MIGRATION_V12_SQL = `
CREATE TABLE scrum_contributors (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'active',
    display_name TEXT,
    github TEXT,
    email TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL,
    last_modified_by TEXT,
    last_modified_at TEXT
);

CREATE INDEX idx_scrum_contributors_github ON scrum_contributors(github);
CREATE INDEX idx_scrum_contributors_email ON scrum_contributors(email);
`;

// ---------------------------------------------------------------------------
// Migration v13 — operator-of-record position history (scrum_operator_history)
// ---------------------------------------------------------------------------

/**
 * v13: an append-only position-history table for the operator-of-record role —
 * who held it over time, so attribution can be POINT-IN-TIME rather than
 * current-holder-only. A new table (not a column) because the role's holder is
 * a time-series of intervals, not a single value:
 *
 *   scrum_operator_history — one row per held interval. `contributor_id` is a
 *                            CT-UUID (a `scrum_contributors.id`) — the holder.
 *                            `from_ts` is when the holder took the role;
 *                            `to_ts` is when they handed it off, or NULL for the
 *                            CURRENT (open) holder. Resolving an action at
 *                            timestamp `t` returns the row whose half-open
 *                            interval `[from_ts, to_ts)` contains `t` — i.e.
 *                            `from_ts <= t AND (to_ts IS NULL OR t < to_ts)`.
 *
 * Invariant: at most one open row (`to_ts IS NULL`) at a time — setting a new
 * holder first closes the prior open row's `to_ts` to the new `from_ts`, then
 * appends the new open row. Enforced in `store.ts::setOperatorOfRecord`, not by
 * a partial unique index, so the closing-then-appending sequence stays one
 * transaction. History is append-only: a prior interval is never mutated except
 * to stamp its `to_ts` once on handoff.
 *
 * This is the single role slot that exists — a degenerate one-row roster. A
 * later multi-role roster generalizes it (more roles, each a parallel interval
 * series); this table is the strict subset that widens, not a throwaway.
 *
 * `id` is an AUTOINCREMENT surrogate (the row has no natural key — a contributor
 * may hold the role across several disjoint intervals). `created_at` records
 * when the row was appended (distinct from `from_ts`, which can be backdated to
 * the real handoff instant). Index backs the point-in-time resolve scan.
 */
export const SCRUM_MIGRATION_V13_SQL = `
CREATE TABLE scrum_operator_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contributor_id TEXT NOT NULL REFERENCES scrum_contributors(id),
    from_ts TEXT NOT NULL,
    to_ts TEXT,
    created_at TEXT NOT NULL,
    created_by TEXT
);

CREATE INDEX idx_scrum_operator_history_interval ON scrum_operator_history(from_ts, to_ts);
`;

// ---------------------------------------------------------------------------
// Migration v14 — team registry (scrum_teams)
// ---------------------------------------------------------------------------

/**
 * v14: a team registry — one row per team, the unit a body of work and the
 * artifacts it owns are organized around. A new table (not a column on an
 * existing one) because a team is its own entity, referenced from many rows
 * rather than owned by one:
 *
 *   scrum_teams — `slug` is the human-friendly handle and primary key, unique
 *                 across the registry. `team_type` is the team's interaction
 *                 archetype (`stream_aligned`/`platform`/`enabling`/
 *                 `complicated_subsystem`). `charter` is a one-line mission
 *                 statement. `lifetime` is the team's expected longevity
 *                 (`persistent` — stands indefinitely; `terminates_on_milestone`
 *                 — disbands when its goal milestone closes).
 *
 * No CHECK on `team_type` or `lifetime` — the columns stay forward-compatible
 * TEXT, matching the v2–v13 convention; the closed `team_type` and `lifetime`
 * vocabularies are documented on the `TeamType`/`TeamLifetime` types in
 * `types.ts` and enforced at the store boundary in `store.ts::createTeam`.
 *
 * The registry is the minimal foundation: scope globs, a roster, accept/expose
 * contracts, and the concrete terminating-milestone target are appended by
 * later additive migrations (own columns or own tables) on top of this base —
 * the table and index names carry the `scrum_` / `idx_scrum_` prefix per the
 * domain-namespacing contract established in v1.
 */
export const SCRUM_MIGRATION_V14_SQL = `
CREATE TABLE scrum_teams (
    slug TEXT PRIMARY KEY,
    team_type TEXT NOT NULL,
    charter TEXT,
    lifetime TEXT NOT NULL DEFAULT 'persistent',
    created_at TEXT NOT NULL
);

CREATE INDEX idx_scrum_teams_type ON scrum_teams(team_type);
`;

// ---------------------------------------------------------------------------
// Migration v15 — per-team read/write scope globs (scrum_team_scopes)
// ---------------------------------------------------------------------------

/**
 * v15: per-team scope globs — the path globs a team reads from and writes to.
 * A new table (not columns on `scrum_teams`) because scope is one-to-many: a
 * team carries an arbitrary number of read and write globs, so each is its own
 * row rather than a column on the registry. Mirrors how the operator position
 * history landed as its own table rather than a column on the contributor.
 *
 *   scrum_team_scopes — one row per (team, kind, glob). `team_slug` is an FK to
 *                       `scrum_teams.slug` — the owning team. `kind` is the
 *                       scope side (`read`/`write`); the column carries no CHECK,
 *                       so this closed set is documented on the `TeamScopeKind`
 *                       type and enforced at the store boundary, matching the
 *                       v2–v14 forward-compatible-TEXT convention. `glob` is a
 *                       single path glob (e.g. `src/auth/**`).
 *
 * Single-writer-per-path is the standing rule on the WRITE side: across the
 * whole registry, no two teams may declare write globs that could match the
 * same path. READ globs may overlap freely. The disjointness is validated at
 * the store boundary (a load-time cross-team check), not by a SQL constraint —
 * glob overlap is not expressible as a UNIQUE index.
 *
 * Index backs the per-team scope fetch (`team_slug`). Table and index names
 * carry the `scrum_` / `idx_scrum_` prefix per the domain-namespacing contract
 * established in v1.
 */
export const SCRUM_MIGRATION_V15_SQL = `
CREATE TABLE scrum_team_scopes (
    team_slug TEXT NOT NULL REFERENCES scrum_teams(slug),
    kind TEXT NOT NULL,
    glob TEXT NOT NULL
);

CREATE INDEX idx_scrum_team_scopes_team ON scrum_team_scopes(team_slug);
`;

// ---------------------------------------------------------------------------
// Migration v16 — per-team three-role roster + position history
//                 (scrum_team_members)
// ---------------------------------------------------------------------------

/**
 * v16: a per-team role roster with position history. Every team has exactly
 * three role slots (`tech_lead`/`engineer`/`implementer`), and each slot is an
 * append-only series of held intervals — who filled it over time, so a slot's
 * holder is POINT-IN-TIME, not current-holder-only. This is the per-(team, role)
 * generalization of the single-slot operator position history: the same
 * close-then-append rotation, parallelized across (team, role) pairs.
 *
 *   scrum_team_members — one row per held interval of one (team, role) slot.
 *                        `team_slug` is the owning team (a `scrum_teams.slug`).
 *                        `role` is which of the three slots the interval fills;
 *                        the column carries no CHECK, so the closed `TeamRole`
 *                        vocabulary is documented on the type and enforced at the
 *                        store boundary, matching the v2–v15 forward-compatible-
 *                        TEXT convention. `contributor_id` is a CT-UUID — a SOFT
 *                        reference (no foreign key), stored exactly as the
 *                        operator history stores its holder. `from_ts` is when
 *                        the holder took the slot; `to_ts` is when they vacated
 *                        it, or NULL for the CURRENT (open) holder. `reason` is a
 *                        free-text rotation rationale, or NULL.
 *
 * Invariant: at most one open row (`to_ts IS NULL`) per (team_slug, role) —
 * rotating a slot first closes its prior open row's `to_ts` to the new holder's
 * `from_ts`, then appends the new open row. Enforced in
 * `store.ts::rotateTeamMember`, not by a partial unique index, so the
 * close-then-append sequence stays one transaction. The same contributor MAY
 * fill multiple slots on a team — that is the team-of-one case and is permitted
 * (the store warns but never rejects).
 *
 * `id` is an AUTOINCREMENT surrogate (a contributor may hold a slot across
 * several disjoint intervals). `created_at` records when the row was appended
 * (distinct from `from_ts`, which can be backdated to the real rotation instant).
 * Index backs the per-(team, role) interval scan. Table and index names carry
 * the `scrum_` / `idx_scrum_` prefix per the domain-namespacing contract
 * established in v1.
 */
export const SCRUM_MIGRATION_V16_SQL = `
CREATE TABLE scrum_team_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_slug TEXT NOT NULL REFERENCES scrum_teams(slug),
    role TEXT NOT NULL,
    contributor_id TEXT NOT NULL,
    from_ts TEXT NOT NULL,
    to_ts TEXT,
    reason TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX idx_scrum_team_members_team_role ON scrum_team_members(team_slug, role);
`;

// ---------------------------------------------------------------------------
// Migration v17 — per-team accept/expose interface, append-only with
//                 supersession (scrum_team_accepts + scrum_team_exposes)
// ---------------------------------------------------------------------------

/**
 * v17: a team's published interface — the ask types it ACCEPTS and the outputs
 * it EXPOSES. Two new tables (not columns on `scrum_teams`) because the
 * interface is one-to-many: a team accepts an arbitrary number of ask types and
 * exposes an arbitrary number of outputs, so each is its own row rather than a
 * column on the registry. Mirrors how the scope globs landed as their own table.
 *
 *   scrum_team_accepts — one row per (team, ask_type) the team handles.
 *                        `team_slug` is an FK to `scrum_teams.slug` — the owning
 *                        team. `ask_type` is a closed kebab-case ask type
 *                        (e.g. `schema-change`, `api-review`); the FORMAT is
 *                        validated at the store boundary (`^[a-z0-9]+(-[a-z0-9]+)*$`),
 *                        not by a SQL constraint.
 *   scrum_team_exposes — one row per (team, name, schema_ref) output other teams
 *                        consume. `team_slug` is the FK; `name` is the output's
 *                        handle and `schema_ref` points at its shape — both free
 *                        text.
 *
 * Both tables are APPEND-ONLY WITH SUPERSESSION: a published interface entry is
 * never hard-deleted — removing it is an explicit edit that flips `status` from
 * `active` to `superseded`, records a `reason`, and optionally points
 * `superseded_by` at a replacement row's id. The retired row stays for audit,
 * mirroring the supersession discipline on `scrum_decisions` and the per-task
 * acceptance criteria. Removing a published interface is a backward-compatibility
 * hazard, so the history must survive. `status` is a closed `active | superseded`
 * enum guarded at the store boundary; the column carries no SQL CHECK, matching
 * the v2–v16 forward-compatible-TEXT convention.
 *
 * `id` is an AUTOINCREMENT surrogate (a team may accept the same ask type across
 * several supersession generations). `created_at` records when the row was
 * appended. Indexes back the per-team interface fetch (`team_slug`). Table and
 * index names carry the `scrum_` / `idx_scrum_` prefix per the domain-namespacing
 * contract established in v1.
 */
export const SCRUM_MIGRATION_V17_SQL = `
CREATE TABLE scrum_team_accepts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_slug TEXT NOT NULL REFERENCES scrum_teams(slug),
    ask_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    superseded_by INTEGER REFERENCES scrum_team_accepts(id),
    reason TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE scrum_team_exposes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_slug TEXT NOT NULL REFERENCES scrum_teams(slug),
    name TEXT NOT NULL,
    schema_ref TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    superseded_by INTEGER REFERENCES scrum_team_exposes(id),
    reason TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX idx_scrum_team_accepts_team ON scrum_team_accepts(team_slug);
CREATE INDEX idx_scrum_team_exposes_team ON scrum_team_exposes(team_slug);
`;

// ---------------------------------------------------------------------------
// Migration v18 — team lifecycle: terminating-milestone target + active/inactive
//                 status (additive columns on scrum_teams)
// ---------------------------------------------------------------------------

/**
 * v18: two additive columns on `scrum_teams` completing the team lifecycle.
 * Both are `ALTER TABLE ... ADD COLUMN` so the migration is forward-only and
 * preserves every existing row — pre-v18 teams read `terminates_on_milestone`
 * NULL and `status` 'active', exactly the persistent-and-live default.
 *
 *   terminates_on_milestone — the concrete milestone id this team disbands on,
 *                             for a `lifetime = 'terminates_on_milestone'` team;
 *                             NULL for a `persistent` team. The base registry
 *                             (v14) carries only the `lifetime` archetype; this
 *                             column is the concrete target the archetype names.
 *                             A team carrying a target is disbanded when that
 *                             milestone closes (the milestone-close trigger).
 *                             The lifetime↔target consistency rule (a
 *                             terminates_on_milestone team must carry a target; a
 *                             persistent team must not) is enforced at the store
 *                             boundary, not by a SQL constraint — it spans two
 *                             columns and tolerates the gradual create-then-set
 *                             flow only at the boundary.
 *   status                  — the team's lifecycle state, a closed
 *                             `active | inactive` enum. `active` is the default a
 *                             live team carries; `inactive` is the terminal state
 *                             a disbanded team is flipped to (its scope released,
 *                             exposes superseded, roster vacated). The column
 *                             carries no CHECK, so the closed set is documented on
 *                             the `TeamStatus` type and guarded at the store
 *                             boundary, matching the v2–v17 forward-compatible-
 *                             TEXT convention.
 *
 * `terminates_on_milestone` is NOT a foreign key to `scrum_milestones`: a team
 * may name a target milestone that is created later, and the soft reference
 * mirrors how the roster's `contributor_id` and the operator history hold their
 * referents without an FK.
 */
export const SCRUM_MIGRATION_V18_SQL = `
ALTER TABLE scrum_teams ADD COLUMN terminates_on_milestone TEXT;
ALTER TABLE scrum_teams ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
`;

/**
 * Current scrum-domain store version — the highest migration version this
 * module registers. Stamped as the per-artifact `schema_version` on the
 * reusable provenance block (see `taskProvenance` in `store.ts`), so every
 * scrum row reports the schema it was read under. Bump in lockstep with the
 * top migration version on every additive hop.
 */
export const SCRUM_SCHEMA_VERSION = 18;

/**
 * Idempotent scrum-domain registration. Safe to call from the module
 * side-effect AND from tests that have hit `clearRegistry()` — both
 * paths land a single scrum/{v1..v18} entry set. Matches
 * `ensureAcbSchemaRegistered` exactly; the guard exists because bun shares
 * module cache across test files, so a module-scoped `registerSchema` runs
 * only once per process and cannot recover after a registry wipe.
 */
export function ensureScrumSchemaRegistered(): void {
  if (listDomains().includes('scrum')) return;
  registerSchema({
    domain: 'scrum',
    migrations: [
      {
        version: 1,
        description:
          'create scrum_tasks + scrum_milestones + scrum_tags + scrum_deps + scrum_events + scrum_run_links + scrum_context_bundles',
        up: (db: Database) => {
          db.exec(SCRUM_MIGRATION_V1_SQL);
        },
      },
      {
        version: 2,
        description:
          'create scrum_decisions + idx_scrum_decisions_topic + idx_scrum_decisions_status',
        up: (db: Database) => {
          db.exec(SCRUM_MIGRATION_V2_SQL);
        },
      },
      {
        version: 3,
        description:
          'add scrum_tasks.parent_id (self-FK) + scrum_tasks.layer + idx_scrum_tasks_parent',
        up: (db: Database) => {
          db.exec(SCRUM_MIGRATION_V3_SQL);
        },
      },
      {
        version: 4,
        description:
          'add scrum_decisions.superseded_by (self-FK) + scrum_decisions.reason for append-only supersession',
        up: (db: Database) => {
          db.exec(SCRUM_MIGRATION_V4_SQL);
        },
      },
      {
        version: 5,
        description:
          'add scrum_tasks.acceptance_json (nullable JSON) for first-class acceptance criteria',
        up: (db: Database) => {
          db.exec(SCRUM_MIGRATION_V5_SQL);
        },
      },
      {
        version: 6,
        description:
          'add scrum_tasks.bounds_json (nullable JSON) for milestone-authored declared bounds',
        up: (db: Database) => {
          db.exec(SCRUM_MIGRATION_V6_SQL);
        },
      },
      {
        version: 7,
        description:
          'add scrum_tasks.terminal_reason + scrum_tasks.terminal_detail for cancel provenance',
        up: (db: Database) => {
          db.exec(SCRUM_MIGRATION_V7_SQL);
        },
      },
      {
        version: 8,
        description: 'add scrum_decisions.kind (nullable) for the Codex subtype taxonomy',
        up: (db: Database) => {
          db.exec(SCRUM_MIGRATION_V8_SQL);
        },
      },
      {
        version: 9,
        description:
          'add scrum_tasks.last_modified_by + scrum_tasks.last_modified_at for last-touch provenance',
        up: (db: Database) => {
          db.exec(SCRUM_MIGRATION_V9_SQL);
        },
      },
      {
        version: 10,
        description: 'add scrum_milestones.initiative (nullable) for the initiative grouping tier',
        up: (db: Database) => {
          db.exec(SCRUM_MIGRATION_V10_SQL);
        },
      },
      {
        version: 11,
        description:
          'add scrum_tasks.worker_id + scrum_tasks.run_id for executing-worker/run attribution',
        up: (db: Database) => {
          db.exec(SCRUM_MIGRATION_V11_SQL);
        },
      },
      {
        version: 12,
        description:
          'create scrum_contributors (CT-UUID registry) + idx_scrum_contributors_github + idx_scrum_contributors_email',
        up: (db: Database) => {
          db.exec(SCRUM_MIGRATION_V12_SQL);
        },
      },
      {
        version: 13,
        description:
          'create scrum_operator_history (operator-of-record position history) + idx_scrum_operator_history_interval',
        up: (db: Database) => {
          db.exec(SCRUM_MIGRATION_V13_SQL);
        },
      },
      {
        version: 14,
        description: 'create scrum_teams (team registry) + idx_scrum_teams_type',
        up: (db: Database) => {
          db.exec(SCRUM_MIGRATION_V14_SQL);
        },
      },
      {
        version: 15,
        description:
          'create scrum_team_scopes (per-team read/write scope globs) + idx_scrum_team_scopes_team',
        up: (db: Database) => {
          db.exec(SCRUM_MIGRATION_V15_SQL);
        },
      },
      {
        version: 16,
        description:
          'create scrum_team_members (per-team three-role roster + position history) + idx_scrum_team_members_team_role',
        up: (db: Database) => {
          db.exec(SCRUM_MIGRATION_V16_SQL);
        },
      },
      {
        version: 17,
        description:
          'create scrum_team_accepts + scrum_team_exposes (per-team accept/expose interface, append-only with supersession) + idx_scrum_team_accepts_team + idx_scrum_team_exposes_team',
        up: (db: Database) => {
          db.exec(SCRUM_MIGRATION_V17_SQL);
        },
      },
      {
        version: 18,
        description:
          'add scrum_teams.terminates_on_milestone (nullable target) + scrum_teams.status (active|inactive) for the team lifecycle',
        up: (db: Database) => {
          db.exec(SCRUM_MIGRATION_V18_SQL);
        },
      },
    ],
  });
}

ensureScrumSchemaRegistered();
