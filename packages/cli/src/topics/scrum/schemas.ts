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
 * Table-name convention: every domain table carries the `scrum_` prefix per
 * `.prove/decisions/2026-04-21-unified-prove-store.md` § "Schema
 * namespacing". Indexes carry the `idx_scrum_` prefix.
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
// Migration v2 — scrum_decisions (ADR-style decision persistence)
// ---------------------------------------------------------------------------

/**
 * v2: persist decision records as first-class rows in the scrum domain.
 *
 *   scrum_decisions — one row per decision (id = filename slug, e.g.
 *                     `2026-04-24-decision-persistence`); `content_sha`
 *                     is `sha256(content)` hex-encoded so downstream
 *                     drift-detection can compare against the working-tree
 *                     file without re-reading it. `source_path` is
 *                     nullable because git-recovered rows may lack a
 *                     working-tree file.
 *
 * `status` defaults to `'accepted'` per ADR convention. Indexes cover the
 * two filter dimensions used by `listDecisions` — topic and status.
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
 * v3: add an OPTIONAL hierarchy to `scrum_tasks` (audit §3.4/§5.4). Two
 * nullable columns plus a parent index:
 *
 *   parent_id — self-FK; the containment tree (epic→story→task). Separate
 *               from `scrum_deps`, which stays purely for blocking edges.
 *               NULL = a flat, parent-less task (the pre-v3 shape).
 *   layer     — 'epic' | 'story' | 'task'; NULL = untiered/flat. No CHECK
 *               constraint so older databases stay forward-compatible and
 *               the vocabulary can extend without a migration.
 *
 * SQLite permits `ADD COLUMN ... REFERENCES` only because the added column's
 * default is NULL (no existing row needs a parent), so both ALTERs are safe
 * on a populated table. The parent index backs `getChildren` /
 * `derivedStatus` tree walks.
 *
 * Depth is optional: existing flat tasks (parent_id NULL, layer NULL) keep
 * their exact pre-v3 behavior.
 */
export const SCRUM_MIGRATION_V3_SQL = `
ALTER TABLE scrum_tasks ADD COLUMN parent_id TEXT REFERENCES scrum_tasks(id);
ALTER TABLE scrum_tasks ADD COLUMN layer TEXT;
CREATE INDEX idx_scrum_tasks_parent ON scrum_tasks(parent_id);
`;

// ---------------------------------------------------------------------------
// Migration v4 — append-only supersession on scrum_decisions (audit §5.3)
// ---------------------------------------------------------------------------

/**
 * v4: add append-only supersession to `scrum_decisions` (audit §5.3,
 * design-principles §4). Two nullable columns, no hard-delete path:
 *
 *   superseded_by — self-FK to the replacement decision's `id`. NULL = the
 *                   decision is current (not retired). When set, the row's
 *                   `status` flips to `'superseded'` and this points at the
 *                   replacement, so the supersession graph is explicit and
 *                   the original stays auditable.
 *   reason        — free-text rationale recorded at supersession time. NULL
 *                   on every pre-v4 row and on any decision never superseded.
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
// Migration v5 — first-class acceptance criteria on scrum_tasks (audit §5.2)
// ---------------------------------------------------------------------------

/**
 * v5: add first-class acceptance criteria to `scrum_tasks` (audit §5.2). One
 * nullable JSON column, matching the `scrum_context_bundles.bundle_json`
 * JSON-column precedent (no new table):
 *
 *   acceptance_json — JSON-encoded `Acceptance` object
 *                     `{ criteria: AcceptanceCriterion[], policy?: AcceptancePolicy }`.
 *                     NULL = a task with no authored acceptance (the pre-v5
 *                     shape). Decoded to `ScrumTask.acceptance` at the row
 *                     boundary in `store.ts`.
 *
 * Criteria are append-only (audit §5.2 / §5.3, design-principles §4): a
 * retired criterion is never removed from the array. Instead its `status`
 * flips to `'superseded'` with a `reason` and an optional `superseded_by`
 * pointer — the supersession discipline mirrors v4's `scrum_decisions`.
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
// Migration v6 — optional declared bounds on scrum_tasks (declared-bounds §2)
// ---------------------------------------------------------------------------

/**
 * v6: add an OPTIONAL declared-bounds authoring column to `scrum_tasks`
 * (decision `.prove/decisions/2026-05-31-declared-bounds-home.md` §2 — the
 * deferred scrum half). One nullable JSON column, matching the v5
 * `acceptance_json` JSON-column precedent (no new table):
 *
 *   bounds_json — JSON-encoded `TaskBounds` object
 *                 `{ read?, write?, tools?: { allow?, deny? },
 *                    budgets?: { tokens?, tool_calls?, wall_clock_s? } }`.
 *                 NULL = a task with no authored bounds (the pre-v6 shape,
 *                 absent = unbounded). Decoded to `ScrumTask.bounds` at the
 *                 row boundary in `store.ts`.
 *
 * The column is the optional milestone-authored authoring SOURCE: a bound set
 * here survives `compile-plan` into the emitted plan's `tasks[].bounds`
 * (mirroring the run-state v3 `TASK_PLAN_SPEC.bounds` shape) instead of being
 * re-authored every run. The canonical ENFORCEMENT input stays the ephemeral
 * `plan.json tasks[].bounds`; this column only feeds it. Per the decision's
 * post-implementation correction: `write[]`/`read[]`/`budgets` are advisory
 * (the git worktree is the write wall), `tools` map to native permissions —
 * there is NO native deny-outside rule.
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
// Migration v7 — terminal provenance on scrum_tasks (onleash §14.4–14.6)
// ---------------------------------------------------------------------------

/**
 * v7: record WHY a task reached a terminal status (onleash terminal:{reason,
 * detail}). Two nullable TEXT columns, no new table:
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

/**
 * Idempotent scrum-domain registration. Safe to call from the module
 * side-effect AND from tests that previously hit `clearRegistry()` — both
 * paths land a single scrum/{v1..v7} entry set. Matches
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
    ],
  });
}

ensureScrumSchemaRegistered();
