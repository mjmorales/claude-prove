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

/**
 * Idempotent scrum-domain registration. Safe to call from the module
 * side-effect AND from tests that previously hit `clearRegistry()` — both
 * paths land a single scrum/v1 entry. Matches `ensureAcbSchemaRegistered`
 * exactly; the guard exists because bun shares module cache across test
 * files, so a module-scoped `registerSchema` runs only once per process
 * and cannot recover after a registry wipe.
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
    ],
  });
}

ensureScrumSchemaRegistered();
