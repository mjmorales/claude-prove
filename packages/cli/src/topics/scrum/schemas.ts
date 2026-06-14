/**
 * Scrum domain schema — a single fresh v1 migration that creates every table
 * the scrum topic needs in its redesigned, sync-safe shape.
 *
 * Sync-safety rewrite: the store runs on a local engine that syncs whole
 * transactions with a single winner (REBASE_LOCAL), not a per-row CRDT. Two
 * writers that both allocate the next AUTOINCREMENT rowid collide on the same
 * integer and one row is silently lost on rebase. Every primary key here is
 * therefore a distinct collision-free value the minting writer decides — a
 * ULID TEXT id on append-only tables, or a natural/composite key — so two
 * concurrent inserts both survive the rebase. NO table uses AUTOINCREMENT or
 * an INTEGER rowid alias.
 *
 * Clean v1: this is a from-scratch base schema, not an incremental chain. A
 * pre-v1 store carrying the legacy multi-version lineage is incompatible and
 * is handled by a separate reset or migrate-to-turso path, never auto-migrated
 * through this module.
 *
 * Table-name convention: every domain table carries the `scrum_` prefix to
 * namespace the scrum domain within the shared store. Indexes carry the
 * `idx_scrum_` prefix. ULID ids stay lexicographically time-ordered, so an
 * `ORDER BY id ASC` over a ULID column reproduces insert-order reads.
 */

import { listDomains, registerSchema } from '@claude-prove/store';

// ---------------------------------------------------------------------------
// Migration v1 — the entire redesigned scrum schema in one atomic transaction
// ---------------------------------------------------------------------------

/**
 * Order matters — FK-bearing tables reference `scrum_tasks`, `scrum_milestones`,
 * `scrum_teams`, `scrum_contributors`, and `scrum_lores`, which must exist
 * first.
 *
 *   scrum_milestones      — one row per milestone; `initiative` is the optional
 *                           tier above the milestone.
 *   scrum_tasks           — one row per task. TEXT PK (an external slug-style id).
 *                           Optional containment tree (`parent_id`/`layer`),
 *                           the task-level acceptance `policy` (`acceptance_policy_json`
 *                           — the criteria themselves are normalized out into
 *                           `scrum_acceptance_criteria`), declared bounds
 *                           (`bounds_json`), terminal/last-touch/executing
 *                           provenance, an optional `team_slug` binding, and
 *                           `status_event_id` — a forward FK to the
 *                           `scrum_events` row (kind `status_changed`) that set
 *                           the current authored status. Treating the event as
 *                           the primary fact, the status column is a fold and
 *                           this pointer is its provenance: every transition
 *                           stamps the column with the id of the same event it
 *                           appends, in one transaction. NULL until the first
 *                           transition.
 *   scrum_acceptance_criteria — one row per acceptance criterion. PK is a minted
 *                           ULID surrogate (`id`); the criterion's author-given
 *                           external id rides as `criterion_id`, unique only
 *                           WITHIN a task — an inherited copy reuses the same
 *                           external id on a different task, so the external id
 *                           cannot be the global PK. Carries the criterion
 *                           DEFINITION; the gate/verification VERDICT is NOT
 *                           stored here — it lives append-only in
 *                           scrum_criterion_verdicts (whose `criterion_id`
 *                           references THIS surrogate, not the external id).
 *                           Supersession is an append+flip (status='superseded'
 *                           + superseded_by pointer to a replacement external
 *                           id), never a delete. `ord` is a per-row minted ULID
 *                           preserving authored array order (the external id is
 *                           a slug, not lexically insert-ordered, so it cannot
 *                           carry the ordering).
 *   scrum_criterion_verdicts — APPEND-ONLY verdict log; ULID TEXT PK. One new
 *                           row per gate response AND per bash/agent/assert
 *                           verification — a re-verify APPENDS, it never updates.
 *                           `channel` distinguishes a gate response ('gate')
 *                           from a recorded verification ('verification'). The
 *                           latest verdict per criterion is the head (max id),
 *                           surfaced by the scrum_criterion_head view. This
 *                           append-then-head shape is what makes a verdict
 *                           commute under whole-transaction sync replay: two
 *                           writers each append a distinct ULID-keyed row and
 *                           both survive the rebase, where a single mutable
 *                           verdict column would have one writer clobber the
 *                           other.
 *   scrum_criterion_head  — VIEW: the latest verdict row per criterion_id
 *                           (max(id), since a ULID id is monotonic so the
 *                           lexically-greatest id is the most-recently appended).
 *                           The story-close floor and the task-detail read
 *                           consult this for each criterion's current verdict.
 *   scrum_ready_eligible  — VIEW: the base actionable task set — every non-deleted
 *                           task in `ready` or `backlog`. This is the candidate
 *                           floor `nextReady` ranks on top of; the multi-factor
 *                           SCORING (unblock-depth, hotness, tag/escalation boosts)
 *                           stays in TS and is intentionally NOT pushed into SQL.
 *                           Defining the eligible predicate once here keeps every
 *                           reader (the CLI ranking and the review-ui boundary)
 *                           on a single shared definition.
 *   scrum_current_operator— VIEW: the operator-of-record's CURRENT holder, derived
 *                           as the LATEST OPEN interval — the single max-fold row
 *                           `WHERE to_ts IS NULL ORDER BY from_ts DESC, id DESC
 *                           LIMIT 1` over the APPEND-ONLY position-history rows. The
 *                           previous read took every `to_ts IS NULL` row and assumed
 *                           the set-then-append kept exactly one; that assumption
 *                           breaks under concurrent offline transfers — each appends
 *                           an open interval and BOTH land on rebase (Class A
 *                           inserts), leaving TWO open rows the old read could not
 *                           collapse. Folding those opens to the one with the
 *                           greatest `(from_ts, id)` makes the single-holder
 *                           invariant survive by construction: every replica sees the
 *                           same merged rows and the fold is deterministic, so all
 *                           converge to the same later holder regardless of push
 *                           order. A vacate (close with no successor) leaves zero
 *                           open rows → the fold yields no holder, the correct
 *                           "slot empty" reading. Resolution AT an arbitrary past
 *                           instant stays a parameterized interval scan
 *                           (`operatorOfRecordAt`); only the shared "who holds it
 *                           now" derivation lives in this view.
 *   scrum_tags            — composite PK (task_id, tag).
 *   scrum_deps            — composite PK (from_task_id, to_task_id, kind).
 *   scrum_events          — append-only audit log; ULID TEXT PK.
 *   scrum_run_links       — composite PK (task_id, run_path).
 *   scrum_context_bundles — PK task_id; cached denormalized context JSON.
 *   scrum_decisions       — Codex records; TEXT PK (filename slug). Append-only
 *                           with supersession; gated write protocol; Lore→Codex
 *                           promotion provenance (`source_lore_id` → scrum_lores).
 *                           Carries a nullable `embedding F32_BLOB(32)` — a
 *                           fixed-32-dim float vector the engine can populate
 *                           with `vector32(...)` and search with
 *                           `vector_distance_cos(...)`. The column ships unpopulated
 *                           (every row NULL); a later phase backfills it and adds
 *                           semantic search. Nullable so a write that has no
 *                           embedding to attach simply leaves it NULL.
 *   scrum_contributors    — CT-UUID registry; TEXT PK.
 *   scrum_operator_history— operator-of-record position history; ULID TEXT PK.
 *   scrum_teams           — team registry; TEXT slug PK.
 *   scrum_team_scopes     — per-team read/write globs; composite PK
 *                           (team_slug, kind, glob).
 *   scrum_team_members    — per-team three-role roster + position history;
 *                           ULID TEXT PK.
 *   scrum_team_accepts    — per-team accepted ask types; ULID TEXT PK,
 *                           self-superseding (`superseded_by` → ULID).
 *   scrum_team_exposes    — per-team exposed outputs; ULID TEXT PK,
 *                           self-superseding.
 *   scrum_lores           — per-team append-only Lore; ULID TEXT PK; compaction
 *                           supersession pointer. Carries the same nullable
 *                           `embedding F32_BLOB(32)` as scrum_decisions, unpopulated
 *                           at this layer for a later semantic-search phase.
 *   scrum_annotations     — per-artifact append-only notes; ULID TEXT PK.
 *   scrum_asks            — cross-team ask protocol; ULID TEXT PK.
 *   scrum_escalations     — typed escalation walk-up chain; ULID TEXT PK,
 *                           self-FK (`walked_up_from` → ULID) + the serialized
 *                           `attributes.linked_escalation` ULID forward pointer.
 */
export const SCRUM_MIGRATION_V1_SQL = `
CREATE TABLE scrum_milestones (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    target_state TEXT,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    closed_at TEXT,
    initiative TEXT
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
    deleted_at TEXT,
    parent_id TEXT REFERENCES scrum_tasks(id),
    layer TEXT,
    acceptance_policy_json TEXT,
    bounds_json TEXT,
    terminal_reason TEXT,
    terminal_detail TEXT,
    last_modified_by TEXT,
    last_modified_at TEXT,
    worker_id TEXT,
    run_id TEXT,
    team_slug TEXT,
    status_event_id TEXT REFERENCES scrum_events(id)
);

CREATE TABLE scrum_acceptance_criteria (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES scrum_tasks(id),
    criterion_id TEXT NOT NULL,
    ord TEXT NOT NULL,
    text TEXT NOT NULL,
    verifies_by TEXT NOT NULL CHECK (verifies_by IN ('bash', 'assert', 'gate', 'agent')),
    check_payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded')),
    idempotent INTEGER NOT NULL DEFAULT 0,
    scope TEXT,
    timeout TEXT,
    superseded_by TEXT,
    reason TEXT,
    inherited_from TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (task_id, criterion_id)
);

CREATE TABLE scrum_criterion_verdicts (
    id TEXT PRIMARY KEY,
    criterion_id TEXT NOT NULL REFERENCES scrum_acceptance_criteria(id),
    channel TEXT NOT NULL CHECK (channel IN ('gate', 'verification')),
    verdict TEXT NOT NULL,
    reason TEXT,
    by_whom TEXT,
    comment TEXT,
    at TEXT NOT NULL
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
    id TEXT PRIMARY KEY,
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

CREATE TABLE scrum_decisions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    topic TEXT,
    status TEXT NOT NULL DEFAULT 'accepted',
    content TEXT NOT NULL,
    source_path TEXT,
    content_sha TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    recorded_by_agent TEXT,
    superseded_by TEXT REFERENCES scrum_decisions(id),
    reason TEXT,
    kind TEXT,
    write_status TEXT,
    gate_responder TEXT,
    gate_responded_at TEXT,
    source_lore_id TEXT REFERENCES scrum_lores(id),
    embedding F32_BLOB(32)
);

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

CREATE TABLE scrum_operator_history (
    id TEXT PRIMARY KEY,
    contributor_id TEXT NOT NULL REFERENCES scrum_contributors(id),
    from_ts TEXT NOT NULL,
    to_ts TEXT,
    created_at TEXT NOT NULL,
    created_by TEXT
);

CREATE TABLE scrum_teams (
    slug TEXT PRIMARY KEY,
    team_type TEXT NOT NULL,
    charter TEXT,
    lifetime TEXT NOT NULL DEFAULT 'persistent',
    created_at TEXT NOT NULL,
    terminates_on_milestone TEXT,
    status TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE scrum_team_scopes (
    team_slug TEXT NOT NULL REFERENCES scrum_teams(slug),
    kind TEXT NOT NULL,
    glob TEXT NOT NULL,
    PRIMARY KEY (team_slug, kind, glob)
);

CREATE TABLE scrum_team_members (
    id TEXT PRIMARY KEY,
    team_slug TEXT NOT NULL REFERENCES scrum_teams(slug),
    role TEXT NOT NULL,
    contributor_id TEXT NOT NULL,
    from_ts TEXT NOT NULL,
    to_ts TEXT,
    reason TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE scrum_team_accepts (
    id TEXT PRIMARY KEY,
    team_slug TEXT NOT NULL REFERENCES scrum_teams(slug),
    ask_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    superseded_by TEXT REFERENCES scrum_team_accepts(id),
    reason TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE scrum_team_exposes (
    id TEXT PRIMARY KEY,
    team_slug TEXT NOT NULL REFERENCES scrum_teams(slug),
    name TEXT NOT NULL,
    schema_ref TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    superseded_by TEXT REFERENCES scrum_team_exposes(id),
    reason TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE scrum_lores (
    id TEXT PRIMARY KEY,
    team_slug TEXT NOT NULL REFERENCES scrum_teams(slug),
    body TEXT NOT NULL,
    author_contributor_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    superseded_by TEXT,
    reason TEXT,
    embedding F32_BLOB(32)
);

CREATE TABLE scrum_annotations (
    id TEXT PRIMARY KEY,
    target_kind TEXT NOT NULL,
    target_ref TEXT NOT NULL,
    body TEXT NOT NULL,
    author TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE scrum_asks (
    id TEXT PRIMARY KEY,
    from_team TEXT NOT NULL REFERENCES scrum_teams(slug),
    to_team TEXT NOT NULL REFERENCES scrum_teams(slug),
    ask_type TEXT NOT NULL,
    blocking_artifact TEXT NOT NULL REFERENCES scrum_tasks(id),
    state TEXT NOT NULL DEFAULT 'filed',
    created_at TEXT NOT NULL,
    mapped_artifact TEXT,
    rejected_reason TEXT,
    counter_proposal TEXT
);

CREATE TABLE scrum_escalations (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    escalation_type TEXT NOT NULL,
    layer TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'open',
    summary TEXT NOT NULL,
    raised_by TEXT,
    resolution_mode TEXT,
    resolution_note TEXT,
    resolved_by TEXT,
    walked_up_from TEXT REFERENCES scrum_escalations(id),
    attributes TEXT,
    created_at TEXT NOT NULL,
    resolved_at TEXT
);

CREATE VIEW scrum_criterion_head AS
SELECT v.criterion_id, v.channel, v.verdict, v.reason, v.by_whom, v.comment, v.at
FROM scrum_criterion_verdicts v
WHERE v.id = (
    SELECT MAX(v2.id) FROM scrum_criterion_verdicts v2 WHERE v2.criterion_id = v.criterion_id
);

CREATE VIEW scrum_ready_eligible AS
SELECT id FROM scrum_tasks WHERE deleted_at IS NULL AND status IN ('ready', 'backlog');

CREATE VIEW scrum_current_operator AS
SELECT contributor_id, from_ts, to_ts, created_at, created_by
FROM scrum_operator_history
WHERE to_ts IS NULL
ORDER BY from_ts DESC, id DESC
LIMIT 1;

CREATE INDEX idx_scrum_acceptance_criteria_task ON scrum_acceptance_criteria(task_id);
CREATE INDEX idx_scrum_criterion_verdicts_criterion ON scrum_criterion_verdicts(criterion_id);
CREATE INDEX idx_scrum_events_task_ts ON scrum_events(task_id, ts DESC);
CREATE INDEX idx_scrum_tasks_status_event ON scrum_tasks(status, last_event_at DESC);
CREATE INDEX idx_scrum_run_links_path ON scrum_run_links(run_path);
CREATE INDEX idx_scrum_deps_to_task ON scrum_deps(to_task_id);
CREATE INDEX idx_scrum_tags_tag ON scrum_tags(tag);
CREATE INDEX idx_scrum_tasks_parent ON scrum_tasks(parent_id);
CREATE INDEX idx_scrum_decisions_topic ON scrum_decisions(topic);
CREATE INDEX idx_scrum_decisions_status ON scrum_decisions(status);
CREATE INDEX idx_scrum_contributors_github ON scrum_contributors(github);
CREATE INDEX idx_scrum_contributors_email ON scrum_contributors(email);
CREATE INDEX idx_scrum_operator_history_interval ON scrum_operator_history(from_ts, to_ts);
CREATE INDEX idx_scrum_teams_type ON scrum_teams(team_type);
CREATE INDEX idx_scrum_team_scopes_team ON scrum_team_scopes(team_slug);
CREATE INDEX idx_scrum_team_members_team_role ON scrum_team_members(team_slug, role);
CREATE INDEX idx_scrum_team_accepts_team ON scrum_team_accepts(team_slug);
CREATE INDEX idx_scrum_team_exposes_team ON scrum_team_exposes(team_slug);
CREATE INDEX idx_scrum_lores_team ON scrum_lores(team_slug);
CREATE INDEX idx_scrum_annotations_target ON scrum_annotations(target_kind, target_ref);
CREATE INDEX idx_scrum_asks_to_team ON scrum_asks(to_team);
CREATE INDEX idx_scrum_asks_blocking_artifact ON scrum_asks(blocking_artifact);
CREATE INDEX idx_scrum_escalations_task_state ON scrum_escalations(task_id, state);
CREATE INDEX idx_scrum_escalations_walked_up_from ON scrum_escalations(walked_up_from);
`;

/**
 * Current scrum-domain store version. The redesigned base schema is a fresh
 * v1; there is no incremental chain. Stamped as the per-artifact
 * `schema_version` on the reusable provenance block (see `taskProvenance` in
 * `store.ts`), so every scrum row reports the schema it was read under.
 */
export const SCRUM_SCHEMA_VERSION = 1;

/**
 * Idempotent scrum-domain registration. Safe to call from the module
 * side-effect AND from tests that have hit `clearRegistry()` — both paths land
 * a single scrum/v1 entry. The guard exists because bun shares module cache
 * across test files, so a module-scoped `registerSchema` runs only once per
 * process and cannot recover after a registry wipe.
 */
export function ensureScrumSchemaRegistered(): void {
  if (listDomains().includes('scrum')) return;
  registerSchema({
    domain: 'scrum',
    migrations: [
      {
        version: 1,
        description: 'create the redesigned sync-safe scrum schema (ULID/composite PKs, no rowid)',
        up: async (store) => {
          await store.exec(SCRUM_MIGRATION_V1_SQL);
        },
      },
    ],
  });
}

ensureScrumSchemaRegistered();
