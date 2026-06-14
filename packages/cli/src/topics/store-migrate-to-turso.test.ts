/**
 * Exercises the legacy → Turso-v1 transform end to end on tempfile stores (no
 * network). A synthetic legacy-shaped database is built with the pre-Turso
 * shapes that matter for the transform — TEXT-id tables, integer-AUTOINCREMENT
 * tables, a self-referential FK, a dangling FK, and a task carrying an
 * `acceptance_json` blob — then migrated and asserted row-for-row.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Store, isUlid, openStore, runMigrations } from '@claude-prove/store';
import { ensureAcbSchemaRegistered } from './acb/store';
import { ensureScrumSchemaRegistered } from './scrum/schemas';
import { migrateLegacyToV1 } from './store-migrate-to-turso';

// Minimal subset of the legacy (pre-Turso) schema covering each transform case.
const LEGACY_DDL = `
CREATE TABLE _migrations_log (domain TEXT, version INTEGER, description TEXT, applied_at TEXT, PRIMARY KEY (domain, version));
CREATE TABLE scrum_milestones (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT, target_state TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, closed_at TEXT, initiative TEXT);
CREATE TABLE scrum_tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT, status TEXT NOT NULL, milestone_id TEXT, created_by_agent TEXT, created_at TEXT NOT NULL, last_event_at TEXT, deleted_at TEXT, parent_id TEXT, layer TEXT, acceptance_json TEXT, bounds_json TEXT, terminal_reason TEXT, terminal_detail TEXT, last_modified_by TEXT, last_modified_at TEXT, worker_id TEXT, run_id TEXT, team_slug TEXT);
CREATE TABLE scrum_tags (task_id TEXT NOT NULL, tag TEXT NOT NULL, added_at TEXT NOT NULL, PRIMARY KEY (task_id, tag));
CREATE TABLE scrum_events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, ts TEXT NOT NULL, kind TEXT NOT NULL, agent TEXT, payload_json TEXT NOT NULL);
CREATE TABLE scrum_escalations (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, escalation_type TEXT NOT NULL, layer TEXT NOT NULL, state TEXT NOT NULL, summary TEXT NOT NULL, raised_by TEXT, resolution_mode TEXT, resolution_note TEXT, resolved_by TEXT, walked_up_from INTEGER, attributes TEXT, created_at TEXT NOT NULL, resolved_at TEXT);
CREATE TABLE acb_acb_documents (id INTEGER PRIMARY KEY AUTOINCREMENT, branch TEXT NOT NULL UNIQUE, data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE acb_group_verdicts (slug TEXT NOT NULL, group_id TEXT NOT NULL, verdict TEXT NOT NULL, note TEXT, fix_prompt TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (slug, group_id));
`;

let dir: string;
let legacyPath: string;
let v1Path: string;

async function buildLegacy(): Promise<Store> {
  const store = await openStore({ path: legacyPath });
  await store.exec('PRAGMA foreign_keys = OFF');
  await store.exec(LEGACY_DDL);
  await store.run(
    "INSERT INTO _migrations_log VALUES ('scrum', 28, 'legacy', '2026-01-01T00:00:00Z'), ('acb', 4, 'legacy', '2026-01-01T00:00:00Z')",
  );
  await store.run(
    "INSERT INTO scrum_milestones (id, title, status, created_at) VALUES ('m1', 'Milestone', 'active', '2026-01-01T00:00:00Z')",
  );
  // Task with two acceptance criteria in the legacy blob shape.
  const acceptance = JSON.stringify({
    criteria: [
      {
        id: 'crit-one',
        text: 'builds clean',
        verifies_by: 'bash',
        check: 'bun run build',
        status: 'active',
        idempotent: true,
      },
      {
        id: 'crit-two',
        text: 'reviewed',
        verifies_by: 'gate',
        check: 'human review',
        status: 'active',
        idempotent: false,
      },
    ],
  });
  await store.run(
    'INSERT INTO scrum_tasks (id, title, status, milestone_id, created_at, acceptance_json) VALUES (?, ?, ?, ?, ?, ?)',
    ['t1', 'Task one', 'in_progress', 'm1', '2026-01-02T00:00:00Z', acceptance],
  );
  await store.run(
    "INSERT INTO scrum_tasks (id, title, status, created_at) VALUES ('t2', 'Task two', 'backlog', '2026-01-03T00:00:00Z')",
  );
  await store.run("INSERT INTO scrum_tags VALUES ('t1', 'backend', '2026-01-02T00:00:00Z')");
  // Three events out of chronological insert order to prove the ULID remap
  // re-derives time order from `ts`.
  await store.run(
    `INSERT INTO scrum_events (task_id, ts, kind, payload_json) VALUES
       ('t1', '2026-01-02T10:00:00Z', 'task_created', '{}'),
       ('t1', '2026-01-02T12:00:00Z', 'status_changed', '{}'),
       ('t2', '2026-01-03T09:00:00Z', 'task_created', '{}')`,
  );
  // Two escalations: the second walks up FROM the first (self-FK, int id), and
  // a third points at a non-existent legacy id (dangling → orphan nulled).
  await store.run(
    `INSERT INTO scrum_escalations (id, task_id, escalation_type, layer, state, summary, walked_up_from, created_at) VALUES
       (1, 't1', 'blocker', 'task', 'open', 'first', NULL, '2026-01-02T11:00:00Z'),
       (2, 't1', 'blocker', 'story', 'open', 'second', 1, '2026-01-02T11:30:00Z'),
       (3, 't2', 'blocker', 'task', 'open', 'dangling', 999, '2026-01-03T09:30:00Z')`,
  );
  await store.run(
    "INSERT INTO acb_acb_documents (branch, data, created_at, updated_at) VALUES ('main', '{\"doc\":1}', '2026-01-01T00:00:00Z', '2026-01-04T00:00:00Z')",
  );
  // Legacy verdict row carrying ONLY `updated_at` — the v1 schema makes
  // `created_at` NOT NULL, so the transform must backfill it from `updated_at`.
  await store.run(
    "INSERT INTO acb_group_verdicts (slug, group_id, verdict, note, updated_at) VALUES ('add-login', 'g1', 'pass', 'looks good', '2026-01-05T00:00:00Z')",
  );
  return store;
}

async function buildV1Target(): Promise<Store> {
  ensureScrumSchemaRegistered();
  ensureAcbSchemaRegistered();
  const store = await openStore({ path: v1Path });
  await runMigrations(store);
  return store;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'prove-migrate-turso-'));
  legacyPath = join(dir, 'legacy.db');
  v1Path = join(dir, 'v1.db');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('migrateLegacyToV1', () => {
  test('preserves row counts, explodes acceptance criteria, and reports no FK violations', async () => {
    const legacy = await buildLegacy();
    const target = await buildV1Target();
    try {
      const report = await migrateLegacyToV1(legacy, target);

      expect(report.fkViolations).toBe(0);
      expect(report.criteriaExploded).toBe(2);

      const byTable = new Map(report.tables.map((t) => [t.table, t]));
      expect(byTable.get('scrum_tasks')?.v1Rows).toBe(2);
      expect(byTable.get('scrum_events')?.v1Rows).toBe(3);
      expect(byTable.get('scrum_escalations')?.v1Rows).toBe(3);
      // The dangling walked_up_from (→ 999) is the only orphan.
      expect(byTable.get('scrum_escalations')?.orphansNulled).toBe(1);

      const taskCount = await target.get<{ n: number }>('SELECT COUNT(*) AS n FROM scrum_tasks');
      expect(taskCount?.n).toBe(2);
      const critCount = await target.get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM scrum_acceptance_criteria',
      );
      expect(critCount?.n).toBe(2);
    } finally {
      legacy.close();
      target.close();
    }
  });

  test('remaps integer event ids to ULIDs in chronological order', async () => {
    const legacy = await buildLegacy();
    const target = await buildV1Target();
    try {
      await migrateLegacyToV1(legacy, target);
      const events = await target.all<{ id: string; ts: string }>(
        'SELECT id, ts FROM scrum_events ORDER BY id',
      );
      expect(events).toHaveLength(3);
      for (const e of events) expect(isUlid(e.id)).toBe(true);
      // ULID order must equal timestamp order.
      const byTs = [...events].sort((a, b) => a.ts.localeCompare(b.ts));
      expect(events.map((e) => e.id)).toEqual(byTs.map((e) => e.id));
    } finally {
      legacy.close();
      target.close();
    }
  });

  test('rewrites a self-referential FK to the remapped ULID and nulls a dangling one', async () => {
    const legacy = await buildLegacy();
    const target = await buildV1Target();
    try {
      await migrateLegacyToV1(legacy, target);
      const esc = await target.all<{ id: string; summary: string; walked_up_from: string | null }>(
        'SELECT id, summary, walked_up_from FROM scrum_escalations ORDER BY id',
      );
      const first = esc.find((e) => e.summary === 'first');
      const second = esc.find((e) => e.summary === 'second');
      const dangling = esc.find((e) => e.summary === 'dangling');

      expect(first?.walked_up_from).toBeNull();
      // The self-FK now points at the FIRST escalation's minted ULID.
      expect(second?.walked_up_from).toBe(first?.id as string);
      expect(isUlid(second?.walked_up_from as string)).toBe(true);
      // The dangling reference (legacy id 999, no such row) is nulled.
      expect(dangling?.walked_up_from).toBeNull();
    } finally {
      legacy.close();
      target.close();
    }
  });

  test('backfills a verdict-row created_at from updated_at when the legacy table lacks it', async () => {
    const legacy = await buildLegacy();
    const target = await buildV1Target();
    try {
      const report = await migrateLegacyToV1(legacy, target);
      expect(report.fkViolations).toBe(0);

      const verdict = await target.get<{ id: string; verdict: string; created_at: string }>(
        'SELECT id, verdict, created_at FROM acb_group_verdicts WHERE slug = ? AND group_id = ?',
        ['add-login', 'g1'],
      );
      expect(verdict?.verdict).toBe('pass');
      expect(isUlid(verdict?.id as string)).toBe(true);
      // created_at is filled from the legacy updated_at, never NULL.
      expect(verdict?.created_at).toBe('2026-01-05T00:00:00Z');
    } finally {
      legacy.close();
      target.close();
    }
  });

  test('re-keys an ACB document blob to a ULID-id revision row', async () => {
    const legacy = await buildLegacy();
    const target = await buildV1Target();
    try {
      await migrateLegacyToV1(legacy, target);
      const doc = await target.get<{ id: string; branch: string; data: string }>(
        'SELECT id, branch, data FROM acb_acb_documents',
      );
      expect(isUlid(doc?.id as string)).toBe(true);
      expect(doc?.branch).toBe('main');
      expect(doc?.data).toBe('{"doc":1}');
      // The head view resolves the single revision as the branch head.
      const head = await target.get<{ branch: string }>(
        'SELECT branch FROM acb_acb_documents_head WHERE branch = ?',
        ['main'],
      );
      expect(head?.branch).toBe('main');
    } finally {
      legacy.close();
      target.close();
    }
  });
});
