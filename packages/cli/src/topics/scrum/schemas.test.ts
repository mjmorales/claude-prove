/**
 * Schema migration tests for the scrum domain.
 *
 * Mirrors `packages/cli/src/topics/acb/store.test.ts::'acb domain registration'`
 * shape. Every test opens a fresh `:memory:` store so registration + migration
 * paths run end-to-end.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import {
  type SchemaDef,
  clearRegistry,
  listDomains,
  openStore,
  registerSchema,
  runMigrations,
} from '@claude-prove/store';
import {
  SCRUM_MIGRATION_V1_SQL,
  SCRUM_MIGRATION_V2_SQL,
  SCRUM_MIGRATION_V3_SQL,
  SCRUM_MIGRATION_V4_SQL,
  SCRUM_MIGRATION_V5_SQL,
  SCRUM_MIGRATION_V6_SQL,
  SCRUM_MIGRATION_V7_SQL,
  SCRUM_MIGRATION_V8_SQL,
  SCRUM_MIGRATION_V9_SQL,
  ensureScrumSchemaRegistered,
} from './schemas';

describe('scrum domain registration', () => {
  beforeEach(() => {
    // Registry is process-wide; re-register defensively in case a prior
    // test file called `clearRegistry()`.
    ensureScrumSchemaRegistered();
  });

  test("listDomains() includes 'scrum' after module import", () => {
    expect(listDomains()).toContain('scrum');
  });

  test('SCRUM_MIGRATION_V1_SQL is a non-empty DDL string', () => {
    expect(SCRUM_MIGRATION_V1_SQL).toContain('CREATE TABLE scrum_tasks');
    expect(SCRUM_MIGRATION_V1_SQL).toContain('CREATE TABLE scrum_milestones');
    expect(SCRUM_MIGRATION_V1_SQL).toContain('CREATE TABLE scrum_tags');
    expect(SCRUM_MIGRATION_V1_SQL).toContain('CREATE TABLE scrum_deps');
    expect(SCRUM_MIGRATION_V1_SQL).toContain('CREATE TABLE scrum_events');
    expect(SCRUM_MIGRATION_V1_SQL).toContain('CREATE TABLE scrum_run_links');
    expect(SCRUM_MIGRATION_V1_SQL).toContain('CREATE TABLE scrum_context_bundles');
  });

  test('SCRUM_MIGRATION_V2_SQL creates scrum_decisions + both indexes', () => {
    expect(SCRUM_MIGRATION_V2_SQL).toContain('CREATE TABLE scrum_decisions');
    expect(SCRUM_MIGRATION_V2_SQL).toContain('CREATE INDEX idx_scrum_decisions_topic');
    expect(SCRUM_MIGRATION_V2_SQL).toContain('CREATE INDEX idx_scrum_decisions_status');
    // Default status is 'accepted'.
    expect(SCRUM_MIGRATION_V2_SQL).toContain("DEFAULT 'accepted'");
  });

  test('migration creates all 8 scrum_* tables (v1 + v2)', () => {
    const raw = openStore({ path: ':memory:' });
    try {
      runMigrations(raw);
      const tables = raw
        .all<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'scrum_%' ORDER BY name",
        )
        .map((r) => r.name);
      expect(tables).toEqual([
        'scrum_context_bundles',
        'scrum_decisions',
        'scrum_deps',
        'scrum_events',
        'scrum_milestones',
        'scrum_run_links',
        'scrum_tags',
        'scrum_tasks',
      ]);
    } finally {
      raw.close();
    }
  });

  test('SCRUM_MIGRATION_V3_SQL adds parent_id + layer + idx_scrum_tasks_parent', () => {
    expect(SCRUM_MIGRATION_V3_SQL).toContain('ALTER TABLE scrum_tasks ADD COLUMN parent_id');
    expect(SCRUM_MIGRATION_V3_SQL).toContain('REFERENCES scrum_tasks(id)');
    expect(SCRUM_MIGRATION_V3_SQL).toContain('ALTER TABLE scrum_tasks ADD COLUMN layer');
    expect(SCRUM_MIGRATION_V3_SQL).toContain(
      'CREATE INDEX idx_scrum_tasks_parent ON scrum_tasks(parent_id)',
    );
  });

  test('migration creates all 8 scrum indexes (v1 + v2 + v3)', () => {
    const raw = openStore({ path: ':memory:' });
    try {
      runMigrations(raw);
      const indexes = raw
        .all<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_scrum_%' ORDER BY name",
        )
        .map((r) => r.name);
      expect(indexes).toEqual([
        'idx_scrum_decisions_status',
        'idx_scrum_decisions_topic',
        'idx_scrum_deps_to_task',
        'idx_scrum_events_task_ts',
        'idx_scrum_run_links_path',
        'idx_scrum_tags_tag',
        'idx_scrum_tasks_parent',
        'idx_scrum_tasks_status_event',
      ]);
    } finally {
      raw.close();
    }
  });

  test('scrum_tasks column shape matches spec (v3 adds parent_id + layer)', () => {
    const raw = openStore({ path: ':memory:' });
    try {
      runMigrations(raw);
      const cols = raw
        .all<{ name: string; type: string; notnull: number }>(
          "SELECT name, type, [notnull] FROM pragma_table_info('scrum_tasks') ORDER BY cid",
        )
        .map((c) => `${c.name}:${c.type}:${c.notnull}`);
      expect(cols).toEqual([
        'id:TEXT:0', // PRIMARY KEY without NOT NULL keyword still gets notnull=0 in pragma
        'title:TEXT:1',
        'description:TEXT:0',
        'status:TEXT:1',
        'milestone_id:TEXT:0',
        'created_by_agent:TEXT:0',
        'created_at:TEXT:1',
        'last_event_at:TEXT:0',
        'deleted_at:TEXT:0',
        // v3 columns are appended (ADD COLUMN lands them at the end), NULL default.
        'parent_id:TEXT:0',
        'layer:TEXT:0',
        // v5 acceptance_json appends after v3, NULL default.
        'acceptance_json:TEXT:0',
        // v6 bounds_json appends after v5, NULL default.
        'bounds_json:TEXT:0',
        // v7 terminal provenance appends after v6, NULL default.
        'terminal_reason:TEXT:0',
        'terminal_detail:TEXT:0',
        // v9 last-touch provenance appends after v7, NULL default.
        'last_modified_by:TEXT:0',
        'last_modified_at:TEXT:0',
      ]);
    } finally {
      raw.close();
    }
  });

  test('v3 ADD COLUMN defaults parent_id + layer to NULL on existing rows', () => {
    const raw = openStore({ path: ':memory:' });
    try {
      runMigrations(raw);
      raw.exec(
        "INSERT INTO scrum_tasks (id, title, status, created_at) VALUES ('t1', 'T1', 'backlog', '2026-01-01T00:00:00Z')",
      );
      const row = raw.all<{ parent_id: string | null; layer: string | null }>(
        'SELECT parent_id, layer FROM scrum_tasks WHERE id = ?',
        ['t1'],
      );
      expect(row).toEqual([{ parent_id: null, layer: null }]);
    } finally {
      raw.close();
    }
  });

  test('scrum_events is AUTOINCREMENT', () => {
    const raw = openStore({ path: ':memory:' });
    try {
      runMigrations(raw);
      // Verify via sqlite_sequence — it only exists when an AUTOINCREMENT
      // column has been inserted against. Insert a milestone + task + event
      // so the sequence table materializes.
      raw.exec(`
        INSERT INTO scrum_milestones (id, title, status, created_at) VALUES ('m1', 'M1', 'active', '2026-01-01T00:00:00Z');
        INSERT INTO scrum_tasks (id, title, status, created_at) VALUES ('t1', 'T1', 'backlog', '2026-01-01T00:00:00Z');
        INSERT INTO scrum_events (task_id, ts, kind, payload_json) VALUES ('t1', '2026-01-01T00:00:00Z', 'note', '{}');
      `);
      const seq = raw.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'",
      );
      expect(seq).toHaveLength(1);
    } finally {
      raw.close();
    }
  });

  test('scrum_deps CHECK constraint rejects invalid kind', () => {
    const raw = openStore({ path: ':memory:' });
    try {
      runMigrations(raw);
      raw.exec(`
        INSERT INTO scrum_tasks (id, title, status, created_at) VALUES ('a', 'A', 'backlog', '2026-01-01T00:00:00Z');
        INSERT INTO scrum_tasks (id, title, status, created_at) VALUES ('b', 'B', 'backlog', '2026-01-01T00:00:00Z');
      `);
      expect(() => {
        raw.exec(
          "INSERT INTO scrum_deps (from_task_id, to_task_id, kind) VALUES ('a', 'b', 'bogus')",
        );
      }).toThrow();
      // Legal kinds succeed.
      raw.exec(
        "INSERT INTO scrum_deps (from_task_id, to_task_id, kind) VALUES ('a', 'b', 'blocks')",
      );
    } finally {
      raw.close();
    }
  });

  test('SCRUM_MIGRATION_V4_SQL adds superseded_by (self-FK) + reason', () => {
    expect(SCRUM_MIGRATION_V4_SQL).toContain(
      'ALTER TABLE scrum_decisions ADD COLUMN superseded_by',
    );
    expect(SCRUM_MIGRATION_V4_SQL).toContain('REFERENCES scrum_decisions(id)');
    expect(SCRUM_MIGRATION_V4_SQL).toContain('ALTER TABLE scrum_decisions ADD COLUMN reason');
  });

  test('scrum_decisions column shape gains v4 superseded_by + reason + v8 kind', () => {
    const raw = openStore({ path: ':memory:' });
    try {
      runMigrations(raw);
      const cols = raw
        .all<{ name: string; type: string; notnull: number }>(
          "SELECT name, type, [notnull] FROM pragma_table_info('scrum_decisions') ORDER BY cid",
        )
        .map((c) => `${c.name}:${c.type}:${c.notnull}`);
      expect(cols).toEqual([
        'id:TEXT:0',
        'title:TEXT:1',
        'topic:TEXT:0',
        'status:TEXT:1',
        'content:TEXT:1',
        'source_path:TEXT:0',
        'content_sha:TEXT:1',
        'recorded_at:TEXT:1',
        'recorded_by_agent:TEXT:0',
        // v4 appends, NULL default.
        'superseded_by:TEXT:0',
        'reason:TEXT:0',
        // v8 appends the Codex subtype, NULL default.
        'kind:TEXT:0',
      ]);
    } finally {
      raw.close();
    }
  });

  test('v4 ADD COLUMN defaults superseded_by + reason to NULL on existing rows', () => {
    const raw = openStore({ path: ':memory:' });
    try {
      runMigrations(raw);
      raw.exec(
        "INSERT INTO scrum_decisions (id, title, status, content, content_sha, recorded_at) VALUES ('d1', 'D1', 'accepted', 'body', 'deadbeef', '2026-01-01T00:00:00Z')",
      );
      const row = raw.all<{ superseded_by: string | null; reason: string | null }>(
        'SELECT superseded_by, reason FROM scrum_decisions WHERE id = ?',
        ['d1'],
      );
      expect(row).toEqual([{ superseded_by: null, reason: null }]);
    } finally {
      raw.close();
    }
  });

  test('SCRUM_MIGRATION_V5_SQL adds scrum_tasks.acceptance_json', () => {
    expect(SCRUM_MIGRATION_V5_SQL).toContain('ALTER TABLE scrum_tasks ADD COLUMN acceptance_json');
  });

  test('scrum_tasks column shape gains v5 acceptance_json + v6 bounds_json + v7 terminal provenance', () => {
    const raw = openStore({ path: ':memory:' });
    try {
      runMigrations(raw);
      const cols = raw
        .all<{ name: string; type: string; notnull: number }>(
          "SELECT name, type, [notnull] FROM pragma_table_info('scrum_tasks') ORDER BY cid",
        )
        .map((c) => `${c.name}:${c.type}:${c.notnull}`);
      expect(cols).toEqual([
        'id:TEXT:0',
        'title:TEXT:1',
        'description:TEXT:0',
        'status:TEXT:1',
        'milestone_id:TEXT:0',
        'created_by_agent:TEXT:0',
        'created_at:TEXT:1',
        'last_event_at:TEXT:0',
        'deleted_at:TEXT:0',
        // v3 columns.
        'parent_id:TEXT:0',
        'layer:TEXT:0',
        // v5 appends, NULL default.
        'acceptance_json:TEXT:0',
        // v6 appends after v5, NULL default.
        'bounds_json:TEXT:0',
        // v7 appends terminal provenance, NULL default.
        'terminal_reason:TEXT:0',
        'terminal_detail:TEXT:0',
        // v9 appends last-touch provenance, NULL default.
        'last_modified_by:TEXT:0',
        'last_modified_at:TEXT:0',
      ]);
    } finally {
      raw.close();
    }
  });

  test('SCRUM_MIGRATION_V6_SQL adds scrum_tasks.bounds_json', () => {
    expect(SCRUM_MIGRATION_V6_SQL).toContain('ALTER TABLE scrum_tasks ADD COLUMN bounds_json');
  });

  test('v6 ADD COLUMN defaults bounds_json to NULL on existing rows', () => {
    const raw = openStore({ path: ':memory:' });
    try {
      runMigrations(raw);
      raw.exec(
        "INSERT INTO scrum_tasks (id, title, status, created_at) VALUES ('t1', 'T1', 'backlog', '2026-01-01T00:00:00Z')",
      );
      const row = raw.all<{ bounds_json: string | null }>(
        'SELECT bounds_json FROM scrum_tasks WHERE id = ?',
        ['t1'],
      );
      expect(row).toEqual([{ bounds_json: null }]);
    } finally {
      raw.close();
    }
  });

  test('SCRUM_MIGRATION_V7_SQL adds scrum_tasks terminal provenance columns', () => {
    expect(SCRUM_MIGRATION_V7_SQL).toContain('ALTER TABLE scrum_tasks ADD COLUMN terminal_reason');
    expect(SCRUM_MIGRATION_V7_SQL).toContain('ALTER TABLE scrum_tasks ADD COLUMN terminal_detail');
  });

  test('v7 ADD COLUMN defaults terminal_reason/terminal_detail to NULL on existing rows', () => {
    const raw = openStore({ path: ':memory:' });
    try {
      runMigrations(raw);
      raw.exec(
        "INSERT INTO scrum_tasks (id, title, status, created_at) VALUES ('t1', 'T1', 'backlog', '2026-01-01T00:00:00Z')",
      );
      const row = raw.all<{ terminal_reason: string | null; terminal_detail: string | null }>(
        'SELECT terminal_reason, terminal_detail FROM scrum_tasks WHERE id = ?',
        ['t1'],
      );
      expect(row).toEqual([{ terminal_reason: null, terminal_detail: null }]);
    } finally {
      raw.close();
    }
  });

  test('SCRUM_MIGRATION_V8_SQL adds scrum_decisions.kind', () => {
    expect(SCRUM_MIGRATION_V8_SQL).toContain('ALTER TABLE scrum_decisions ADD COLUMN kind');
  });

  test('v8 ADD COLUMN defaults kind to NULL on existing rows', () => {
    const raw = openStore({ path: ':memory:' });
    try {
      runMigrations(raw);
      raw.exec(
        "INSERT INTO scrum_decisions (id, title, status, content, content_sha, recorded_at) VALUES ('d1', 'D1', 'accepted', 'body', 'deadbeef', '2026-01-01T00:00:00Z')",
      );
      const row = raw.all<{ kind: string | null }>(
        'SELECT kind FROM scrum_decisions WHERE id = ?',
        ['d1'],
      );
      expect(row).toEqual([{ kind: null }]);
    } finally {
      raw.close();
    }
  });

  test('SCRUM_MIGRATION_V9_SQL adds scrum_tasks last-touch provenance columns', () => {
    expect(SCRUM_MIGRATION_V9_SQL).toContain('ALTER TABLE scrum_tasks ADD COLUMN last_modified_by');
    expect(SCRUM_MIGRATION_V9_SQL).toContain('ALTER TABLE scrum_tasks ADD COLUMN last_modified_at');
  });

  test('v9 ADD COLUMN defaults last_modified_by/last_modified_at to NULL on existing rows', () => {
    const raw = openStore({ path: ':memory:' });
    try {
      runMigrations(raw);
      raw.exec(
        "INSERT INTO scrum_tasks (id, title, status, created_at) VALUES ('t1', 'T1', 'backlog', '2026-01-01T00:00:00Z')",
      );
      const row = raw.all<{ last_modified_by: string | null; last_modified_at: string | null }>(
        'SELECT last_modified_by, last_modified_at FROM scrum_tasks WHERE id = ?',
        ['t1'],
      );
      expect(row).toEqual([{ last_modified_by: null, last_modified_at: null }]);
    } finally {
      raw.close();
    }
  });

  test('v5 ADD COLUMN defaults acceptance_json to NULL on existing rows', () => {
    const raw = openStore({ path: ':memory:' });
    try {
      runMigrations(raw);
      raw.exec(
        "INSERT INTO scrum_tasks (id, title, status, created_at) VALUES ('t1', 'T1', 'backlog', '2026-01-01T00:00:00Z')",
      );
      const row = raw.all<{ acceptance_json: string | null }>(
        'SELECT acceptance_json FROM scrum_tasks WHERE id = ?',
        ['t1'],
      );
      expect(row).toEqual([{ acceptance_json: null }]);
    } finally {
      raw.close();
    }
  });

  test('full migration chain from v0 applies v1..v9 in order', () => {
    const raw = openStore({ path: ':memory:' });
    try {
      const result = runMigrations(raw);
      expect(result.applied.filter((a) => a.domain === 'scrum').map((a) => a.version)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9,
      ]);
    } finally {
      raw.close();
    }
  });

  test('migration is idempotent — rerunning does not duplicate log rows', () => {
    const raw = openStore({ path: ':memory:' });
    try {
      const first = runMigrations(raw);
      expect(first.applied.filter((a) => a.domain === 'scrum').map((a) => a.version)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9,
      ]);

      const second = runMigrations(raw);
      expect(second.applied.filter((a) => a.domain === 'scrum')).toEqual([]);

      const versions = raw.all<{ version: number }>(
        'SELECT version FROM _migrations_log WHERE domain = ? ORDER BY version',
        ['scrum'],
      );
      expect(versions).toEqual([
        { version: 1 },
        { version: 2 },
        { version: 3 },
        { version: 4 },
        { version: 5 },
        { version: 6 },
        { version: 7 },
        { version: 8 },
        { version: 9 },
      ]);
    } finally {
      raw.close();
    }
  });

  test('duplicate migration version within scrum domain throws at register time', () => {
    // Registry throws when the same (domain, version) pair is registered twice.
    clearRegistry();
    const def: SchemaDef = {
      domain: 'scrum',
      migrations: [
        { version: 1, description: 'a', up: () => {} },
        { version: 1, description: 'b', up: () => {} },
      ],
    };
    expect(() => registerSchema(def)).toThrow(/duplicate migration version 1/);
    // Leave the registry in a clean state for downstream tests.
    clearRegistry();
    ensureScrumSchemaRegistered();
  });

  test('_migrations_log entry description matches registered description', () => {
    const raw = openStore({ path: ':memory:' });
    try {
      runMigrations(raw);
      const log = raw.all<{ domain: string; version: number; description: string }>(
        'SELECT domain, version, description FROM _migrations_log WHERE domain = ? ORDER BY version',
        ['scrum'],
      );
      expect(log).toHaveLength(9);
      const [v1, v2, v3, v4, v5, v6, v7, v8, v9] = log;
      if (!v1 || !v2 || !v3 || !v4 || !v5 || !v6 || !v7 || !v8 || !v9)
        throw new Error('expected nine log entries');
      expect(v1.domain).toBe('scrum');
      expect(v1.version).toBe(1);
      expect(v1.description).toContain('scrum_tasks');
      expect(v2.domain).toBe('scrum');
      expect(v2.version).toBe(2);
      expect(v2.description).toContain('scrum_decisions');
      expect(v3.domain).toBe('scrum');
      expect(v3.version).toBe(3);
      expect(v3.description).toContain('parent_id');
      expect(v4.domain).toBe('scrum');
      expect(v4.version).toBe(4);
      expect(v4.description).toContain('superseded_by');
      expect(v5.domain).toBe('scrum');
      expect(v5.version).toBe(5);
      expect(v5.description).toContain('acceptance_json');
      expect(v6.domain).toBe('scrum');
      expect(v6.version).toBe(6);
      expect(v6.description).toContain('bounds_json');
      expect(v7.domain).toBe('scrum');
      expect(v7.version).toBe(7);
      expect(v7.description).toContain('terminal_reason');
      expect(v8.domain).toBe('scrum');
      expect(v8.version).toBe(8);
      expect(v8.description).toContain('kind');
      expect(v9.domain).toBe('scrum');
      expect(v9.version).toBe(9);
      expect(v9.description).toContain('last_modified_by');
    } finally {
      raw.close();
    }
  });
});
