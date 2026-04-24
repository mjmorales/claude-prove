/**
 * Decision persistence tests for the scrum domain (task 1.1).
 *
 * Covers:
 *   1. Fresh DB materializes `scrum_decisions` + both indexes.
 *   2. v1 -> v2 migration preserves existing `scrum_tasks` + `scrum_events`
 *      rows and leaves `scrum_decisions` empty.
 *   3. record + get round-trip; `content_sha` equals `sha256(content)` hex.
 *   4. Upsert on duplicate id replaces content + bumps `recorded_at`.
 *   5. `listDecisions` filters by topic and status.
 *
 * Registry-mutation tests (#2) use `clearRegistry()` + explicit
 * `registerSchema` calls to simulate a v1-only install, then re-open the
 * same file-backed store under a v1+v2 schema. Every test restores the
 * canonical registration in `afterEach` so downstream test files see the
 * full scrum schema.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearRegistry, openStore, registerSchema, runMigrations } from '@claude-prove/store';
import {
  SCRUM_MIGRATION_V1_SQL,
  SCRUM_MIGRATION_V2_SQL,
  ensureScrumSchemaRegistered,
} from './schemas';
import { type ScrumStore, openScrumStore } from './store';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let store: ScrumStore;

beforeEach(() => {
  ensureScrumSchemaRegistered();
  store = openScrumStore({ path: ':memory:' });
});

afterEach(() => {
  store.close();
  // Restore canonical registration so downstream test files see v1+v2.
  ensureScrumSchemaRegistered();
});

// ===========================================================================
// 1. Fresh DB — table + indexes materialize
// ===========================================================================

describe('ScrumStore — decisions: schema materialization', () => {
  test('opening the store creates scrum_decisions + both indexes', () => {
    const names = store
      .getStore()
      .all<{ name: string; type: string }>(
        `SELECT name, type FROM sqlite_master
         WHERE (type = 'table' AND name = 'scrum_decisions')
            OR (type = 'index' AND name LIKE 'idx_scrum_decisions%')
         ORDER BY name`,
      )
      .map((r) => `${r.type}:${r.name}`);
    // SQL name ordering — 'idx_scrum_decisions_*' < 'scrum_decisions'.
    expect(names).toEqual([
      'index:idx_scrum_decisions_status',
      'index:idx_scrum_decisions_topic',
      'table:scrum_decisions',
    ]);
  });

  test('scrum_decisions column shape matches spec', () => {
    const cols = store
      .getStore()
      .all<{ name: string; type: string; notnull: number; dflt_value: string | null }>(
        "SELECT name, type, [notnull], dflt_value FROM pragma_table_info('scrum_decisions') ORDER BY cid",
      )
      .map((c) => `${c.name}:${c.type}:${c.notnull}`);
    expect(cols).toEqual([
      'id:TEXT:0', // PRIMARY KEY without NOT NULL still reports notnull=0 in sqlite pragma
      'title:TEXT:1',
      'topic:TEXT:0',
      'status:TEXT:1',
      'content:TEXT:1',
      'source_path:TEXT:0',
      'content_sha:TEXT:1',
      'recorded_at:TEXT:1',
      'recorded_by_agent:TEXT:0',
    ]);
  });
});

// ===========================================================================
// 2. v1 -> v2 migration preserves existing data
// ===========================================================================

describe('ScrumStore — decisions: v1 -> v2 migration', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'scrum-decision-migrate-'));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  test('v1 -> v2 preserves scrum_tasks + scrum_events and leaves scrum_decisions empty', () => {
    const dbPath = join(projectDir, 'prove.db');

    // -- Phase 1: v1-only registration, seed data ---------------------------
    clearRegistry();
    registerSchema({
      domain: 'scrum',
      migrations: [
        {
          version: 1,
          description: 'v1-only test fixture',
          up: (db) => db.exec(SCRUM_MIGRATION_V1_SQL),
        },
      ],
    });

    const v1Store = openStore({ path: dbPath });
    runMigrations(v1Store);
    v1Store.exec(`
      INSERT INTO scrum_tasks (id, title, status, created_at)
        VALUES ('t-seed', 'Seeded task', 'backlog', '2026-04-01T00:00:00Z');
      INSERT INTO scrum_events (task_id, ts, kind, payload_json)
        VALUES ('t-seed', '2026-04-01T00:00:00Z', 'task_created', '{"title":"Seeded task"}');
    `);
    v1Store.close();

    // -- Phase 2: re-register v1+v2, re-open same file ----------------------
    clearRegistry();
    registerSchema({
      domain: 'scrum',
      migrations: [
        {
          version: 1,
          description: 'v1-only test fixture',
          up: (db) => db.exec(SCRUM_MIGRATION_V1_SQL),
        },
        {
          version: 2,
          description: 'add scrum_decisions',
          up: (db) => db.exec(SCRUM_MIGRATION_V2_SQL),
        },
      ],
    });

    const v2Store = openStore({ path: dbPath });
    const result = runMigrations(v2Store);

    // Only v2 should have landed this run; v1 was already in the log.
    expect(result.applied.filter((a) => a.domain === 'scrum').map((a) => a.version)).toEqual([2]);

    // v1 rows survive the ladder.
    const tasks = v2Store.all<{ id: string; title: string; status: string }>(
      'SELECT id, title, status FROM scrum_tasks',
    );
    expect(tasks).toEqual([{ id: 't-seed', title: 'Seeded task', status: 'backlog' }]);

    const events = v2Store.all<{ task_id: string; kind: string }>(
      'SELECT task_id, kind FROM scrum_events',
    );
    expect(events).toEqual([{ task_id: 't-seed', kind: 'task_created' }]);

    // New table exists and is empty.
    const decisionCount = v2Store.all<{ count: number }>(
      'SELECT COUNT(*) AS count FROM scrum_decisions',
    );
    expect(decisionCount).toEqual([{ count: 0 }]);

    v2Store.close();
  });
});

// ===========================================================================
// 3. record + get round-trip
// ===========================================================================

describe('ScrumStore — decisions: record + get', () => {
  test('recordDecision persists the row and getDecision returns it byte-for-byte', () => {
    const content = '# Adopt SQLite for prove store\n\nFull ADR body here.';
    const expectedSha = createHash('sha256').update(content).digest('hex');

    const recorded = store.recordDecision({
      id: '2026-04-24-adopt-sqlite',
      title: 'Adopt SQLite for prove store',
      topic: 'architecture',
      content,
      sourcePath: '.prove/decisions/2026-04-24-adopt-sqlite.md',
      recordedByAgent: 'scrum-master',
    });

    expect(recorded.content_sha).toBe(expectedSha);
    expect(recorded.status).toBe('accepted'); // default

    const fetched = store.getDecision('2026-04-24-adopt-sqlite');
    expect(fetched).not.toBeNull();
    if (!fetched) throw new Error('expected decision row');
    expect(fetched.id).toBe('2026-04-24-adopt-sqlite');
    expect(fetched.title).toBe('Adopt SQLite for prove store');
    expect(fetched.topic).toBe('architecture');
    expect(fetched.status).toBe('accepted');
    expect(fetched.content).toBe(content);
    expect(fetched.source_path).toBe('.prove/decisions/2026-04-24-adopt-sqlite.md');
    expect(fetched.content_sha).toBe(expectedSha);
    expect(fetched.recorded_by_agent).toBe('scrum-master');
    expect(fetched.recorded_at).toBe(recorded.recorded_at);
  });

  test('getDecision returns null for unknown id', () => {
    expect(store.getDecision('does-not-exist')).toBeNull();
  });

  test('recordDecision defaults nullable fields to null', () => {
    store.recordDecision({
      id: 'minimal',
      title: 'Minimal',
      content: 'body',
    });
    const row = store.getDecision('minimal');
    if (!row) throw new Error('expected row');
    expect(row.topic).toBeNull();
    expect(row.source_path).toBeNull();
    expect(row.recorded_by_agent).toBeNull();
    expect(row.status).toBe('accepted');
  });
});

// ===========================================================================
// 4. Upsert on duplicate id
// ===========================================================================

describe('ScrumStore — decisions: upsert semantics', () => {
  test('recording the same id twice replaces content/title and bumps recorded_at', async () => {
    const first = store.recordDecision({
      id: 'dup-id',
      title: 'First title',
      content: 'first body',
      topic: 'architecture',
    });

    // Sleep ~5ms so the ISO-second-precision timestamp strictly increases.
    // `isoNow()` is millisecond-precision, but be defensive against
    // same-millisecond collisions on fast machines.
    await new Promise((resolve) => setTimeout(resolve, 5));

    const second = store.recordDecision({
      id: 'dup-id',
      title: 'Second title',
      content: 'second body',
      topic: 'architecture',
    });

    // Distinct content -> distinct sha.
    expect(second.content_sha).not.toBe(first.content_sha);
    expect(second.content_sha).toBe(createHash('sha256').update('second body').digest('hex'));

    // Exactly one row after the upsert.
    const row = store.getDecision('dup-id');
    if (!row) throw new Error('expected upserted row');
    expect(row.title).toBe('Second title');
    expect(row.content).toBe('second body');
    expect(row.content_sha).toBe(second.content_sha);

    // recorded_at strictly advances.
    expect(row.recorded_at >= second.recorded_at).toBe(true);
    expect(Date.parse(row.recorded_at)).toBeGreaterThanOrEqual(Date.parse(first.recorded_at));

    const total = store
      .getStore()
      .all<{ count: number }>('SELECT COUNT(*) AS count FROM scrum_decisions');
    expect(total).toEqual([{ count: 1 }]);
  });
});

// ===========================================================================
// 5. listDecisions filters
// ===========================================================================

describe('ScrumStore — decisions: listDecisions', () => {
  test('filters by topic, status, and returns all rows when no filter set', () => {
    store.recordDecision({
      id: 'arch-1',
      title: 'Arch 1',
      topic: 'architecture',
      content: 'a',
    });
    store.recordDecision({
      id: 'arch-2',
      title: 'Arch 2',
      topic: 'architecture',
      status: 'superseded',
      content: 'b',
    });
    store.recordDecision({
      id: 'proc-1',
      title: 'Proc 1',
      topic: 'process',
      content: 'c',
    });

    const all = store.listDecisions();
    expect(all.map((d) => d.id).sort()).toEqual(['arch-1', 'arch-2', 'proc-1']);

    const byTopic = store.listDecisions({ topic: 'architecture' });
    expect(byTopic.map((d) => d.id).sort()).toEqual(['arch-1', 'arch-2']);

    const byStatus = store.listDecisions({ status: 'accepted' });
    expect(byStatus.map((d) => d.id).sort()).toEqual(['arch-1', 'proc-1']);

    const combined = store.listDecisions({ topic: 'architecture', status: 'accepted' });
    expect(combined.map((d) => d.id)).toEqual(['arch-1']);
  });

  test('listDecisions filters are case-insensitive on topic and status', () => {
    // ADRs authored with `**Status**: Accepted` (Title-Case) are stored as-is.
    // Operators filter naturally in lowercase (`--status accepted`); both
    // sides are lower()-normalized so the filter matches regardless of case.
    store.recordDecision({
      id: 'titlecase',
      title: 'Title case',
      topic: 'Architecture',
      status: 'Accepted',
      content: 'body',
    });
    store.recordDecision({
      id: 'lowercase',
      title: 'Lower case',
      topic: 'architecture',
      status: 'accepted',
      content: 'body',
    });
    store.recordDecision({
      id: 'uppercase',
      title: 'Upper case',
      topic: 'ARCHITECTURE',
      status: 'ACCEPTED',
      content: 'body',
    });

    expect(
      store
        .listDecisions({ status: 'accepted' })
        .map((d) => d.id)
        .sort(),
    ).toEqual(['lowercase', 'titlecase', 'uppercase']);
    expect(
      store
        .listDecisions({ topic: 'architecture' })
        .map((d) => d.id)
        .sort(),
    ).toEqual(['lowercase', 'titlecase', 'uppercase']);
    expect(
      store
        .listDecisions({ topic: 'ARCHITECTURE', status: 'Accepted' })
        .map((d) => d.id)
        .sort(),
    ).toEqual(['lowercase', 'titlecase', 'uppercase']);
  });

  test('listDecisions orders results by recorded_at DESC', async () => {
    store.recordDecision({ id: 'first', title: 'First', content: '1' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    store.recordDecision({ id: 'second', title: 'Second', content: '2' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    store.recordDecision({ id: 'third', title: 'Third', content: '3' });

    const rows = store.listDecisions();
    expect(rows.map((r) => r.id)).toEqual(['third', 'second', 'first']);
  });
});
