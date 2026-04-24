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
    // Default status is 'accepted' per ADR convention.
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

  test('migration creates all 7 scrum indexes (v1 + v2)', () => {
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
        'idx_scrum_tasks_status_event',
      ]);
    } finally {
      raw.close();
    }
  });

  test('scrum_tasks column shape matches spec', () => {
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
      ]);
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

  test('migration is idempotent — rerunning does not duplicate log rows', () => {
    const raw = openStore({ path: ':memory:' });
    try {
      const first = runMigrations(raw);
      expect(first.applied.filter((a) => a.domain === 'scrum').map((a) => a.version)).toEqual([
        1, 2,
      ]);

      const second = runMigrations(raw);
      expect(second.applied.filter((a) => a.domain === 'scrum')).toEqual([]);

      const versions = raw.all<{ version: number }>(
        'SELECT version FROM _migrations_log WHERE domain = ? ORDER BY version',
        ['scrum'],
      );
      expect(versions).toEqual([{ version: 1 }, { version: 2 }]);
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
      expect(log).toHaveLength(2);
      const [v1, v2] = log;
      if (!v1 || !v2) throw new Error('expected two log entries');
      expect(v1.domain).toBe('scrum');
      expect(v1.version).toBe(1);
      expect(v1.description).toContain('scrum_tasks');
      expect(v2.domain).toBe('scrum');
      expect(v2.version).toBe(2);
      expect(v2.description).toContain('scrum_decisions');
    } finally {
      raw.close();
    }
  });
});
