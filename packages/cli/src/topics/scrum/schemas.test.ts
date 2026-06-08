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
  SCRUM_MIGRATION_V10_SQL,
  SCRUM_MIGRATION_V11_SQL,
  SCRUM_MIGRATION_V12_SQL,
  SCRUM_MIGRATION_V13_SQL,
  SCRUM_MIGRATION_V14_SQL,
  SCRUM_MIGRATION_V15_SQL,
  SCRUM_MIGRATION_V16_SQL,
  SCRUM_MIGRATION_V17_SQL,
  SCRUM_MIGRATION_V18_SQL,
  SCRUM_MIGRATION_V19_SQL,
  SCRUM_MIGRATION_V20_SQL,
  SCRUM_MIGRATION_V21_SQL,
  SCRUM_MIGRATION_V22_SQL,
  SCRUM_MIGRATION_V23_SQL,
  SCRUM_MIGRATION_V24_SQL,
  SCRUM_MIGRATION_V25_SQL,
  SCRUM_MIGRATION_V26_SQL,
  SCRUM_MIGRATION_V27_SQL,
  SCRUM_MIGRATION_V28_SQL,
  SCRUM_SCHEMA_VERSION,
  ensureScrumSchemaRegistered,
} from './schemas';

describe('scrum domain registration', () => {
  beforeEach(async () => {
    // Registry is process-wide and shared across every test file in the run. A
    // sibling file can leave `'scrum'` registered with a PARTIAL migration
    // ladder (the migration-fixture tests register v1-only / v1+v2 defs), in
    // which case a bare `ensureScrumSchemaRegistered()` no-ops and the stale
    // def leaks here — dropping the upper migrations. Clear first, then
    // re-register the canonical full ladder, mirroring `decision.test.ts`.
    clearRegistry();
    ensureScrumSchemaRegistered();
  });

  test("listDomains() includes 'scrum' after module import", async () => {
    expect(listDomains()).toContain('scrum');
  });

  test('SCRUM_MIGRATION_V1_SQL is a non-empty DDL string', async () => {
    expect(SCRUM_MIGRATION_V1_SQL).toContain('CREATE TABLE scrum_tasks');
    expect(SCRUM_MIGRATION_V1_SQL).toContain('CREATE TABLE scrum_milestones');
    expect(SCRUM_MIGRATION_V1_SQL).toContain('CREATE TABLE scrum_tags');
    expect(SCRUM_MIGRATION_V1_SQL).toContain('CREATE TABLE scrum_deps');
    expect(SCRUM_MIGRATION_V1_SQL).toContain('CREATE TABLE scrum_events');
    expect(SCRUM_MIGRATION_V1_SQL).toContain('CREATE TABLE scrum_run_links');
    expect(SCRUM_MIGRATION_V1_SQL).toContain('CREATE TABLE scrum_context_bundles');
  });

  test('SCRUM_MIGRATION_V2_SQL creates scrum_decisions + both indexes', async () => {
    expect(SCRUM_MIGRATION_V2_SQL).toContain('CREATE TABLE scrum_decisions');
    expect(SCRUM_MIGRATION_V2_SQL).toContain('CREATE INDEX idx_scrum_decisions_topic');
    expect(SCRUM_MIGRATION_V2_SQL).toContain('CREATE INDEX idx_scrum_decisions_status');
    // Default status is 'accepted'.
    expect(SCRUM_MIGRATION_V2_SQL).toContain("DEFAULT 'accepted'");
  });

  test('migration creates all 19 scrum_* tables (v1 + v2 + v12 + v13 + v14 + v15 + v16 + v17 + v19 + v20 + v23 + v24)', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);
      const tables = (await raw.all<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'scrum_%' ORDER BY name",
        ))
        .map((r) => r.name);
      expect(tables).toEqual([
        'scrum_annotations',
        'scrum_asks',
        'scrum_context_bundles',
        'scrum_contributors',
        'scrum_decisions',
        'scrum_deps',
        'scrum_escalations',
        'scrum_events',
        'scrum_lores',
        'scrum_milestones',
        'scrum_operator_history',
        'scrum_run_links',
        'scrum_tags',
        'scrum_tasks',
        'scrum_team_accepts',
        'scrum_team_exposes',
        'scrum_team_members',
        'scrum_team_scopes',
        'scrum_teams',
      ]);
    } finally {
      raw.close();
    }
  });

  test('SCRUM_MIGRATION_V3_SQL adds parent_id + layer + idx_scrum_tasks_parent', async () => {
    expect(SCRUM_MIGRATION_V3_SQL).toContain('ALTER TABLE scrum_tasks ADD COLUMN parent_id');
    expect(SCRUM_MIGRATION_V3_SQL).toContain('REFERENCES scrum_tasks(id)');
    expect(SCRUM_MIGRATION_V3_SQL).toContain('ALTER TABLE scrum_tasks ADD COLUMN layer');
    expect(SCRUM_MIGRATION_V3_SQL).toContain(
      'CREATE INDEX idx_scrum_tasks_parent ON scrum_tasks(parent_id)',
    );
  });

  test('migration creates all 22 scrum indexes (v1 + v2 + v3 + v12 + v13 + v14 + v15 + v16 + v17 + v19 + v20 + v23 + v24)', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);
      const indexes = (await raw.all<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_scrum_%' ORDER BY name",
        ))
        .map((r) => r.name);
      expect(indexes).toEqual([
        'idx_scrum_annotations_target',
        'idx_scrum_asks_blocking_artifact',
        'idx_scrum_asks_to_team',
        'idx_scrum_contributors_email',
        'idx_scrum_contributors_github',
        'idx_scrum_decisions_status',
        'idx_scrum_decisions_topic',
        'idx_scrum_deps_to_task',
        'idx_scrum_escalations_task_state',
        'idx_scrum_escalations_walked_up_from',
        'idx_scrum_events_task_ts',
        'idx_scrum_lores_team',
        'idx_scrum_operator_history_interval',
        'idx_scrum_run_links_path',
        'idx_scrum_tags_tag',
        'idx_scrum_tasks_parent',
        'idx_scrum_tasks_status_event',
        'idx_scrum_team_accepts_team',
        'idx_scrum_team_exposes_team',
        'idx_scrum_team_members_team_role',
        'idx_scrum_team_scopes_team',
        'idx_scrum_teams_type',
      ]);
    } finally {
      raw.close();
    }
  });

  test('scrum_tasks column shape matches spec (v3 adds parent_id + layer)', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);
      const cols = (await raw.all<{ name: string; type: string; notnull: number }>(
          "SELECT name, type, [notnull] FROM pragma_table_info('scrum_tasks') ORDER BY cid",
        ))
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
        // v11 executing-worker/run attribution appends after v9, NULL default.
        'worker_id:TEXT:0',
        'run_id:TEXT:0',
        // v27 team binding appends after v11, NULL default.
        'team_slug:TEXT:0',
      ]);
    } finally {
      raw.close();
    }
  });

  test('v3 ADD COLUMN defaults parent_id + layer to NULL on existing rows', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);
      await raw.exec(
        "INSERT INTO scrum_tasks (id, title, status, created_at) VALUES ('t1', 'T1', 'backlog', '2026-01-01T00:00:00Z')",
      );
      const row = await raw.all<{ parent_id: string | null; layer: string | null }>(
        'SELECT parent_id, layer FROM scrum_tasks WHERE id = ?',
        ['t1'],
      );
      expect(row).toEqual([{ parent_id: null, layer: null }]);
    } finally {
      raw.close();
    }
  });

  test('scrum_events is AUTOINCREMENT', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);
      // Verify via sqlite_sequence — it only exists when an AUTOINCREMENT
      // column has been inserted against. Insert a milestone + task + event
      // so the sequence table materializes.
      await raw.exec(`
        INSERT INTO scrum_milestones (id, title, status, created_at) VALUES ('m1', 'M1', 'active', '2026-01-01T00:00:00Z');
        INSERT INTO scrum_tasks (id, title, status, created_at) VALUES ('t1', 'T1', 'backlog', '2026-01-01T00:00:00Z');
        INSERT INTO scrum_events (task_id, ts, kind, payload_json) VALUES ('t1', '2026-01-01T00:00:00Z', 'note', '{}');
      `);
      const seq = await raw.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'",
      );
      expect(seq).toHaveLength(1);
    } finally {
      raw.close();
    }
  });

  test('scrum_deps CHECK constraint rejects invalid kind', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);
      await raw.exec(`
        INSERT INTO scrum_tasks (id, title, status, created_at) VALUES ('a', 'A', 'backlog', '2026-01-01T00:00:00Z');
        INSERT INTO scrum_tasks (id, title, status, created_at) VALUES ('b', 'B', 'backlog', '2026-01-01T00:00:00Z');
      `);
      await expect(
        raw.exec(
          "INSERT INTO scrum_deps (from_task_id, to_task_id, kind) VALUES ('a', 'b', 'bogus')",
        ),
      ).rejects.toThrow();
      // Legal kinds succeed.
      await raw.exec(
        "INSERT INTO scrum_deps (from_task_id, to_task_id, kind) VALUES ('a', 'b', 'blocks')",
      );
    } finally {
      raw.close();
    }
  });

  test('SCRUM_MIGRATION_V4_SQL adds superseded_by (self-FK) + reason', async () => {
    expect(SCRUM_MIGRATION_V4_SQL).toContain(
      'ALTER TABLE scrum_decisions ADD COLUMN superseded_by',
    );
    expect(SCRUM_MIGRATION_V4_SQL).toContain('REFERENCES scrum_decisions(id)');
    expect(SCRUM_MIGRATION_V4_SQL).toContain('ALTER TABLE scrum_decisions ADD COLUMN reason');
  });

  test('scrum_decisions column shape gains v4 superseded_by + reason + v8 kind + v21 gate cols + v22 source_lore_id', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);
      const cols = (await raw.all<{ name: string; type: string; notnull: number }>(
          "SELECT name, type, [notnull] FROM pragma_table_info('scrum_decisions') ORDER BY cid",
        ))
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
        // v21 appends the gated-write columns, NULL default.
        'write_status:TEXT:0',
        'gate_responder:TEXT:0',
        'gate_responded_at:TEXT:0',
        // v22 appends the Lore→Codex promotion provenance, NULL default.
        'source_lore_id:INTEGER:0',
      ]);
    } finally {
      raw.close();
    }
  });

  test('v4 ADD COLUMN defaults superseded_by + reason to NULL on existing rows', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);
      await raw.exec(
        "INSERT INTO scrum_decisions (id, title, status, content, content_sha, recorded_at) VALUES ('d1', 'D1', 'accepted', 'body', 'deadbeef', '2026-01-01T00:00:00Z')",
      );
      const row = await raw.all<{ superseded_by: string | null; reason: string | null }>(
        'SELECT superseded_by, reason FROM scrum_decisions WHERE id = ?',
        ['d1'],
      );
      expect(row).toEqual([{ superseded_by: null, reason: null }]);
    } finally {
      raw.close();
    }
  });

  test('SCRUM_MIGRATION_V24_SQL creates scrum_escalations + both walk-up indexes', async () => {
    expect(SCRUM_MIGRATION_V24_SQL).toContain('CREATE TABLE scrum_escalations');
    expect(SCRUM_MIGRATION_V24_SQL).toContain(
      'walked_up_from INTEGER REFERENCES scrum_escalations',
    );
    expect(SCRUM_MIGRATION_V24_SQL).toContain(
      'CREATE INDEX idx_scrum_escalations_task_state ON scrum_escalations(task_id, state)',
    );
    expect(SCRUM_MIGRATION_V24_SQL).toContain(
      'CREATE INDEX idx_scrum_escalations_walked_up_from ON scrum_escalations(walked_up_from)',
    );
    // Fresh escalations default to the 'open' state.
    expect(SCRUM_MIGRATION_V24_SQL).toContain("DEFAULT 'open'");
  });

  test('scrum_escalations column shape matches the v24+v26 spec (attributes appended by v26)', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);
      const cols = (await raw.all<{ name: string; type: string; notnull: number }>(
          "SELECT name, type, [notnull] FROM pragma_table_info('scrum_escalations') ORDER BY cid",
        ))
        .map((c) => `${c.name}:${c.type}:${c.notnull}`);
      expect(cols).toEqual([
        'id:INTEGER:0',
        'task_id:TEXT:1',
        'escalation_type:TEXT:1',
        'layer:TEXT:1',
        'state:TEXT:1',
        'summary:TEXT:1',
        'raised_by:TEXT:0',
        'resolution_mode:TEXT:0',
        'resolution_note:TEXT:0',
        'resolved_by:TEXT:0',
        'walked_up_from:INTEGER:0',
        'created_at:TEXT:1',
        'resolved_at:TEXT:0',
        // v26 ALTER TABLE ADD COLUMN lands attributes at the end of the table.
        'attributes:TEXT:0',
      ]);
    } finally {
      raw.close();
    }
  });

  test('scrum_escalations is AUTOINCREMENT and defaults a fresh row to open', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);
      await raw.exec(
        "INSERT INTO scrum_escalations (task_id, escalation_type, layer, summary, created_at) VALUES ('t1', 'blocked', 'implementer', 's', '2026-01-01T00:00:00Z')",
      );
      const row = await raw.all<{ id: number; state: string; walked_up_from: number | null }>(
        'SELECT id, state, walked_up_from FROM scrum_escalations',
      );
      expect(row).toEqual([{ id: 1, state: 'open', walked_up_from: null }]);
    } finally {
      raw.close();
    }
  });

  test('SCRUM_MIGRATION_V26_SQL adds the nullable scrum_escalations.attributes column', async () => {
    expect(SCRUM_MIGRATION_V26_SQL).toContain(
      'ALTER TABLE scrum_escalations ADD COLUMN attributes',
    );
  });

  test('v26 ADD COLUMN defaults attributes to NULL on existing escalation rows', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);
      // Row inserted without the v26 column — simulates a pre-v26 escalation
      // carried through the upgrade. The new column must read NULL.
      await raw.exec(
        "INSERT INTO scrum_escalations (task_id, escalation_type, layer, summary, created_at) VALUES ('t1', 'blocked', 'implementer', 's', '2026-01-01T00:00:00Z')",
      );
      const row = await raw.all<{ attributes: string | null }>(
        'SELECT attributes FROM scrum_escalations WHERE task_id = ?',
        ['t1'],
      );
      expect(row).toEqual([{ attributes: null }]);
    } finally {
      raw.close();
    }
  });

  test('SCRUM_MIGRATION_V5_SQL adds scrum_tasks.acceptance_json', async () => {
    expect(SCRUM_MIGRATION_V5_SQL).toContain('ALTER TABLE scrum_tasks ADD COLUMN acceptance_json');
  });

  test('scrum_tasks column shape gains v5 acceptance_json + v6 bounds_json + v7 terminal provenance', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);
      const cols = (await raw.all<{ name: string; type: string; notnull: number }>(
          "SELECT name, type, [notnull] FROM pragma_table_info('scrum_tasks') ORDER BY cid",
        ))
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
        // v11 appends executing-worker/run attribution, NULL default.
        'worker_id:TEXT:0',
        'run_id:TEXT:0',
        // v27 appends the team binding, NULL default.
        'team_slug:TEXT:0',
      ]);
    } finally {
      raw.close();
    }
  });

  test('SCRUM_MIGRATION_V6_SQL adds scrum_tasks.bounds_json', async () => {
    expect(SCRUM_MIGRATION_V6_SQL).toContain('ALTER TABLE scrum_tasks ADD COLUMN bounds_json');
  });

  test('v6 ADD COLUMN defaults bounds_json to NULL on existing rows', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);
      await raw.exec(
        "INSERT INTO scrum_tasks (id, title, status, created_at) VALUES ('t1', 'T1', 'backlog', '2026-01-01T00:00:00Z')",
      );
      const row = await raw.all<{ bounds_json: string | null }>(
        'SELECT bounds_json FROM scrum_tasks WHERE id = ?',
        ['t1'],
      );
      expect(row).toEqual([{ bounds_json: null }]);
    } finally {
      raw.close();
    }
  });

  test('SCRUM_MIGRATION_V7_SQL adds scrum_tasks terminal provenance columns', async () => {
    expect(SCRUM_MIGRATION_V7_SQL).toContain('ALTER TABLE scrum_tasks ADD COLUMN terminal_reason');
    expect(SCRUM_MIGRATION_V7_SQL).toContain('ALTER TABLE scrum_tasks ADD COLUMN terminal_detail');
  });

  test('v7 ADD COLUMN defaults terminal_reason/terminal_detail to NULL on existing rows', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);
      await raw.exec(
        "INSERT INTO scrum_tasks (id, title, status, created_at) VALUES ('t1', 'T1', 'backlog', '2026-01-01T00:00:00Z')",
      );
      const row = await raw.all<{ terminal_reason: string | null; terminal_detail: string | null }>(
        'SELECT terminal_reason, terminal_detail FROM scrum_tasks WHERE id = ?',
        ['t1'],
      );
      expect(row).toEqual([{ terminal_reason: null, terminal_detail: null }]);
    } finally {
      raw.close();
    }
  });

  test('SCRUM_MIGRATION_V8_SQL adds scrum_decisions.kind', async () => {
    expect(SCRUM_MIGRATION_V8_SQL).toContain('ALTER TABLE scrum_decisions ADD COLUMN kind');
  });

  test('v8 ADD COLUMN defaults kind to NULL on existing rows', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);
      await raw.exec(
        "INSERT INTO scrum_decisions (id, title, status, content, content_sha, recorded_at) VALUES ('d1', 'D1', 'accepted', 'body', 'deadbeef', '2026-01-01T00:00:00Z')",
      );
      const row = await raw.all<{ kind: string | null }>(
        'SELECT kind FROM scrum_decisions WHERE id = ?',
        ['d1'],
      );
      expect(row).toEqual([{ kind: null }]);
    } finally {
      raw.close();
    }
  });

  test('SCRUM_MIGRATION_V9_SQL adds scrum_tasks last-touch provenance columns', async () => {
    expect(SCRUM_MIGRATION_V9_SQL).toContain('ALTER TABLE scrum_tasks ADD COLUMN last_modified_by');
    expect(SCRUM_MIGRATION_V9_SQL).toContain('ALTER TABLE scrum_tasks ADD COLUMN last_modified_at');
  });

  test('v9 ADD COLUMN defaults last_modified_by/last_modified_at to NULL on existing rows', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);
      await raw.exec(
        "INSERT INTO scrum_tasks (id, title, status, created_at) VALUES ('t1', 'T1', 'backlog', '2026-01-01T00:00:00Z')",
      );
      const row = await raw.all<{ last_modified_by: string | null; last_modified_at: string | null }>(
        'SELECT last_modified_by, last_modified_at FROM scrum_tasks WHERE id = ?',
        ['t1'],
      );
      expect(row).toEqual([{ last_modified_by: null, last_modified_at: null }]);
    } finally {
      raw.close();
    }
  });

  test('v5 ADD COLUMN defaults acceptance_json to NULL on existing rows', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);
      await raw.exec(
        "INSERT INTO scrum_tasks (id, title, status, created_at) VALUES ('t1', 'T1', 'backlog', '2026-01-01T00:00:00Z')",
      );
      const row = await raw.all<{ acceptance_json: string | null }>(
        'SELECT acceptance_json FROM scrum_tasks WHERE id = ?',
        ['t1'],
      );
      expect(row).toEqual([{ acceptance_json: null }]);
    } finally {
      raw.close();
    }
  });

  test('full migration chain from v0 applies v1..v28 in order', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      const result = await runMigrations(raw);
      expect(result.applied.filter((a) => a.domain === 'scrum').map((a) => a.version)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25,
        26, 27, 28,
      ]);
    } finally {
      raw.close();
    }
  });

  test('migration is idempotent — rerunning does not duplicate log rows', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      const first = await runMigrations(raw);
      expect(first.applied.filter((a) => a.domain === 'scrum').map((a) => a.version)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25,
        26, 27, 28,
      ]);

      const second = await runMigrations(raw);
      expect(second.applied.filter((a) => a.domain === 'scrum')).toEqual([]);

      const versions = await raw.all<{ version: number }>(
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
        { version: 10 },
        { version: 11 },
        { version: 12 },
        { version: 13 },
        { version: 14 },
        { version: 15 },
        { version: 16 },
        { version: 17 },
        { version: 18 },
        { version: 19 },
        { version: 20 },
        { version: 21 },
        { version: 22 },
        { version: 23 },
        { version: 24 },
        { version: 25 },
        { version: 26 },
        { version: 27 },
        { version: 28 },
      ]);
    } finally {
      raw.close();
    }
  });

  test('duplicate migration version within scrum domain throws at register time', async () => {
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

  test('_migrations_log entry description matches registered description', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);
      const log = await raw.all<{ domain: string; version: number; description: string }>(
        'SELECT domain, version, description FROM _migrations_log WHERE domain = ? ORDER BY version',
        ['scrum'],
      );
      expect(log).toHaveLength(28);
      const [
        v1,
        v2,
        v3,
        v4,
        v5,
        v6,
        v7,
        v8,
        v9,
        v10,
        v11,
        v12,
        v13,
        v14,
        v15,
        v16,
        v17,
        v18,
        v19,
        v20,
        v21,
        v22,
        v23,
        v24,
        v25,
        v26,
        v27,
        v28,
      ] = log;
      if (
        !v1 ||
        !v2 ||
        !v3 ||
        !v4 ||
        !v5 ||
        !v6 ||
        !v7 ||
        !v8 ||
        !v9 ||
        !v10 ||
        !v11 ||
        !v12 ||
        !v13 ||
        !v14 ||
        !v15 ||
        !v16 ||
        !v17 ||
        !v18 ||
        !v19 ||
        !v20 ||
        !v21 ||
        !v22 ||
        !v23 ||
        !v24 ||
        !v25 ||
        !v26 ||
        !v27 ||
        !v28
      )
        throw new Error('expected twenty-eight log entries');
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
      expect(v10.domain).toBe('scrum');
      expect(v10.version).toBe(10);
      expect(v10.description).toContain('initiative');
      expect(v11.domain).toBe('scrum');
      expect(v11.version).toBe(11);
      expect(v11.description).toContain('worker_id');
      expect(v12.domain).toBe('scrum');
      expect(v12.version).toBe(12);
      expect(v12.description).toContain('scrum_contributors');
      expect(v13.domain).toBe('scrum');
      expect(v13.version).toBe(13);
      expect(v13.description).toContain('scrum_operator_history');
      expect(v14.domain).toBe('scrum');
      expect(v14.version).toBe(14);
      expect(v14.description).toContain('scrum_teams');
      expect(v15.domain).toBe('scrum');
      expect(v15.version).toBe(15);
      expect(v15.description).toContain('scrum_team_scopes');
      expect(v16.domain).toBe('scrum');
      expect(v16.version).toBe(16);
      expect(v16.description).toContain('scrum_team_members');
      expect(v17.domain).toBe('scrum');
      expect(v17.version).toBe(17);
      expect(v17.description).toContain('scrum_team_accepts');
      expect(v17.description).toContain('scrum_team_exposes');
      expect(v18.domain).toBe('scrum');
      expect(v18.version).toBe(18);
      expect(v18.description).toContain('terminates_on_milestone');
      expect(v18.description).toContain('status');
      expect(v19.domain).toBe('scrum');
      expect(v19.version).toBe(19);
      expect(v19.description).toContain('scrum_lores');
      expect(v20.domain).toBe('scrum');
      expect(v20.version).toBe(20);
      expect(v20.description).toContain('scrum_annotations');
      expect(v21.domain).toBe('scrum');
      expect(v21.version).toBe(21);
      expect(v21.description).toContain('write_status');
      expect(v22.domain).toBe('scrum');
      expect(v22.version).toBe(22);
      expect(v22.description).toContain('source_lore_id');
      expect(v23.domain).toBe('scrum');
      expect(v23.version).toBe(23);
      expect(v23.description).toContain('scrum_asks');
      expect(v24.domain).toBe('scrum');
      expect(v24.version).toBe(24);
      expect(v24.description).toContain('scrum_escalations');
      expect(v25.domain).toBe('scrum');
      expect(v25.version).toBe(25);
      expect(v25.description).toContain('mapped_artifact');
      expect(v26.domain).toBe('scrum');
      expect(v26.version).toBe(26);
      expect(v26.description).toContain('attributes');
      expect(v27.domain).toBe('scrum');
      expect(v27.version).toBe(27);
      expect(v27.description).toContain('team_slug');
      expect(v28.domain).toBe('scrum');
      expect(v28.version).toBe(28);
      expect(v28.description).toContain('superseded_by');
    } finally {
      raw.close();
    }
  });

  test('SCRUM_MIGRATION_V10_SQL adds scrum_milestones.initiative', async () => {
    expect(SCRUM_MIGRATION_V10_SQL).toContain('ALTER TABLE scrum_milestones ADD COLUMN initiative');
  });

  test('v10 ADD COLUMN defaults initiative to NULL on existing milestones', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);
      await raw.exec(
        "INSERT INTO scrum_milestones (id, title, status, created_at) VALUES ('m1', 'M1', 'planned', '2026-01-01T00:00:00Z')",
      );
      const row = await raw.all<{ initiative: string | null }>(
        'SELECT initiative FROM scrum_milestones WHERE id = ?',
        ['m1'],
      );
      expect(row).toEqual([{ initiative: null }]);
    } finally {
      raw.close();
    }
  });

  test('SCRUM_MIGRATION_V11_SQL adds scrum_tasks worker_id + run_id', async () => {
    expect(SCRUM_MIGRATION_V11_SQL).toContain('ALTER TABLE scrum_tasks ADD COLUMN worker_id');
    expect(SCRUM_MIGRATION_V11_SQL).toContain('ALTER TABLE scrum_tasks ADD COLUMN run_id');
  });

  test('SCRUM_MIGRATION_V27_SQL adds scrum_tasks.team_slug', async () => {
    expect(SCRUM_MIGRATION_V27_SQL).toContain('ALTER TABLE scrum_tasks ADD COLUMN team_slug');
  });

  test('v27 ADD COLUMN defaults team_slug to NULL on existing rows', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);
      await raw.exec(
        "INSERT INTO scrum_tasks (id, title, status, created_at) VALUES ('t1', 'T1', 'backlog', '2026-01-01T00:00:00Z')",
      );
      const row = await raw.all<{ team_slug: string | null }>(
        'SELECT team_slug FROM scrum_tasks WHERE id = ?',
        ['t1'],
      );
      expect(row).toEqual([{ team_slug: null }]);
    } finally {
      raw.close();
    }
  });

  test('SCRUM_MIGRATION_V28_SQL adds scrum_lores superseded_by + reason', async () => {
    expect(SCRUM_MIGRATION_V28_SQL).toContain('ALTER TABLE scrum_lores ADD COLUMN superseded_by');
    expect(SCRUM_MIGRATION_V28_SQL).toContain('ALTER TABLE scrum_lores ADD COLUMN reason');
  });

  test('v28 ADD COLUMN defaults supersession columns to NULL on existing Lore (live)', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);
      await raw.exec(
        "INSERT INTO scrum_teams (slug, team_type, created_at) VALUES ('payments', 'stream_aligned', '2026-01-01T00:00:00Z')",
      );
      await raw.exec(
        "INSERT INTO scrum_lores (team_slug, body, author_contributor_id, created_at) VALUES ('payments', 'prefer idempotent migrations', 'CT-lead', '2026-01-01T00:00:00Z')",
      );
      const row = await raw.all<{ superseded_by: string | null; reason: string | null }>(
        'SELECT superseded_by, reason FROM scrum_lores WHERE team_slug = ?',
        ['payments'],
      );
      expect(row).toEqual([{ superseded_by: null, reason: null }]);
    } finally {
      raw.close();
    }
  });

  test('SCRUM_SCHEMA_VERSION tracks the top migration version (28)', async () => {
    expect(SCRUM_SCHEMA_VERSION).toBe(28);
  });

  test('v11 ADD COLUMN defaults worker_id/run_id to NULL on existing rows', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);
      // Row inserted without the v11 columns — simulates a pre-v11 row carried
      // through the upgrade. The new columns must read NULL.
      await raw.exec(
        "INSERT INTO scrum_tasks (id, title, status, created_at) VALUES ('t1', 'T1', 'backlog', '2026-01-01T00:00:00Z')",
      );
      const row = await raw.all<{ worker_id: string | null; run_id: string | null }>(
        'SELECT worker_id, run_id FROM scrum_tasks WHERE id = ?',
        ['t1'],
      );
      expect(row).toEqual([{ worker_id: null, run_id: null }]);
    } finally {
      raw.close();
    }
  });

  test('SCRUM_MIGRATION_V12_SQL creates scrum_contributors + resolution indexes', async () => {
    expect(SCRUM_MIGRATION_V12_SQL).toContain('CREATE TABLE scrum_contributors');
    expect(SCRUM_MIGRATION_V12_SQL).toContain('idx_scrum_contributors_github');
    expect(SCRUM_MIGRATION_V12_SQL).toContain('idx_scrum_contributors_email');
  });

  test('a fresh store has scrum_contributors with the v12 column shape', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);

      const tables = await raw.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'scrum_contributors'",
      );
      expect(tables).toEqual([{ name: 'scrum_contributors' }]);

      // Column shape matches the on-disk contributor.md schema + provenance.
      const cols = (await raw.all<{ name: string }>('PRAGMA table_info(scrum_contributors)'))
        .map((c) => c.name);
      expect(cols).toEqual([
        'id',
        'slug',
        'status',
        'display_name',
        'github',
        'email',
        'created_by',
        'created_at',
        'last_modified_by',
        'last_modified_at',
      ]);
    } finally {
      raw.close();
    }
  });

  test('v12 enforces slug uniqueness on scrum_contributors', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);
      await raw.exec(
        "INSERT INTO scrum_contributors (id, slug, status, created_at) VALUES ('ct-a', 'jane', 'active', '2026-01-01T00:00:00Z')",
      );
      await expect(
        raw.exec(
          "INSERT INTO scrum_contributors (id, slug, status, created_at) VALUES ('ct-b', 'jane', 'active', '2026-01-02T00:00:00Z')",
        ),
      ).rejects.toThrow();
    } finally {
      raw.close();
    }
  });

  test('SCRUM_MIGRATION_V13_SQL creates scrum_operator_history + interval index', async () => {
    expect(SCRUM_MIGRATION_V13_SQL).toContain('CREATE TABLE scrum_operator_history');
    expect(SCRUM_MIGRATION_V13_SQL).toContain('idx_scrum_operator_history_interval');
    expect(SCRUM_MIGRATION_V13_SQL).toContain('REFERENCES scrum_contributors(id)');
  });

  test('a fresh store with scrum_operator_history present', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);

      const tables = await raw.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'scrum_operator_history'",
      );
      expect(tables).toEqual([{ name: 'scrum_operator_history' }]);

      const cols = (await raw.all<{ name: string }>('PRAGMA table_info(scrum_operator_history)'))
        .map((c) => c.name);
      expect(cols).toEqual([
        'id',
        'contributor_id',
        'from_ts',
        'to_ts',
        'created_at',
        'created_by',
      ]);
    } finally {
      raw.close();
    }
  });

  test('v13 to_ts is nullable — an open interval (current holder) is valid', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);
      await raw.exec(
        "INSERT INTO scrum_contributors (id, slug, status, created_at) VALUES ('ct-jane', 'jane', 'active', '2026-01-01T00:00:00Z')",
      );
      await raw.exec(
        "INSERT INTO scrum_operator_history (contributor_id, from_ts, to_ts, created_at) VALUES ('ct-jane', '2026-01-01T00:00:00Z', NULL, '2026-01-01T00:00:00Z')",
      );
      const row = await raw.all<{ to_ts: string | null }>(
        'SELECT to_ts FROM scrum_operator_history WHERE contributor_id = ?',
        ['ct-jane'],
      );
      expect(row).toEqual([{ to_ts: null }]);
    } finally {
      raw.close();
    }
  });

  test('SCRUM_MIGRATION_V14_SQL creates scrum_teams + type index', async () => {
    expect(SCRUM_MIGRATION_V14_SQL).toContain('CREATE TABLE scrum_teams');
    expect(SCRUM_MIGRATION_V14_SQL).toContain('idx_scrum_teams_type');
  });

  test('a fresh store ends at version 28 with scrum_teams present', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);

      const top = await raw.all<{ version: number }>(
        'SELECT MAX(version) AS version FROM _migrations_log WHERE domain = ?',
        ['scrum'],
      );
      expect(top).toEqual([{ version: 28 }]);

      const tables = await raw.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'scrum_teams'",
      );
      expect(tables).toEqual([{ name: 'scrum_teams' }]);

      // v18 appends terminates_on_milestone + status after the v14 base columns
      // (ADD COLUMN lands them at the end), NULL/'active' defaults respectively.
      const cols = (await raw.all<{ name: string }>('PRAGMA table_info(scrum_teams)')).map((c) => c.name);
      expect(cols).toEqual([
        'slug',
        'team_type',
        'charter',
        'lifetime',
        'created_at',
        'terminates_on_milestone',
        'status',
      ]);
    } finally {
      raw.close();
    }
  });

  test('v14 enforces slug uniqueness (primary key) on scrum_teams', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);
      await raw.exec(
        "INSERT INTO scrum_teams (slug, team_type, lifetime, created_at) VALUES ('payments', 'stream_aligned', 'persistent', '2026-01-01T00:00:00Z')",
      );
      await expect(
        raw.exec(
          "INSERT INTO scrum_teams (slug, team_type, lifetime, created_at) VALUES ('payments', 'platform', 'persistent', '2026-01-02T00:00:00Z')",
        ),
      ).rejects.toThrow();
    } finally {
      raw.close();
    }
  });

  test('v14 lifetime defaults to persistent on insert', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);
      await raw.exec(
        "INSERT INTO scrum_teams (slug, team_type, created_at) VALUES ('platform-core', 'platform', '2026-01-01T00:00:00Z')",
      );
      const row = await raw.all<{ lifetime: string; charter: string | null }>(
        'SELECT lifetime, charter FROM scrum_teams WHERE slug = ?',
        ['platform-core'],
      );
      expect(row).toEqual([{ lifetime: 'persistent', charter: null }]);
    } finally {
      raw.close();
    }
  });

  test('SCRUM_MIGRATION_V15_SQL creates scrum_team_scopes + team index', async () => {
    expect(SCRUM_MIGRATION_V15_SQL).toContain('CREATE TABLE scrum_team_scopes');
    expect(SCRUM_MIGRATION_V15_SQL).toContain('idx_scrum_team_scopes_team');
    expect(SCRUM_MIGRATION_V15_SQL).toContain('REFERENCES scrum_teams(slug)');
  });

  test('a fresh store has scrum_team_scopes with the v15 column shape', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);

      const tables = await raw.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'scrum_team_scopes'",
      );
      expect(tables).toEqual([{ name: 'scrum_team_scopes' }]);

      const cols = (await raw.all<{ name: string }>('PRAGMA table_info(scrum_team_scopes)'))
        .map((c) => c.name);
      expect(cols).toEqual(['team_slug', 'kind', 'glob']);
    } finally {
      raw.close();
    }
  });

  test('v15 scope rows round-trip against an existing team', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);
      await raw.exec(
        "INSERT INTO scrum_teams (slug, team_type, created_at) VALUES ('payments', 'stream_aligned', '2026-01-01T00:00:00Z')",
      );
      await raw.exec(
        "INSERT INTO scrum_team_scopes (team_slug, kind, glob) VALUES ('payments', 'write', 'src/payments/**')",
      );
      await raw.exec(
        "INSERT INTO scrum_team_scopes (team_slug, kind, glob) VALUES ('payments', 'read', 'src/shared/**')",
      );
      const rows = await raw.all<{ kind: string; glob: string }>(
        'SELECT kind, glob FROM scrum_team_scopes WHERE team_slug = ? ORDER BY kind, glob',
        ['payments'],
      );
      expect(rows).toEqual([
        { kind: 'read', glob: 'src/shared/**' },
        { kind: 'write', glob: 'src/payments/**' },
      ]);
    } finally {
      raw.close();
    }
  });

  test('SCRUM_MIGRATION_V16_SQL creates scrum_team_members + (team, role) index', async () => {
    expect(SCRUM_MIGRATION_V16_SQL).toContain('CREATE TABLE scrum_team_members');
    expect(SCRUM_MIGRATION_V16_SQL).toContain('idx_scrum_team_members_team_role');
    expect(SCRUM_MIGRATION_V16_SQL).toContain('REFERENCES scrum_teams(slug)');
  });

  test('a fresh store has scrum_team_members with the v16 column shape', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);

      const tables = await raw.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'scrum_team_members'",
      );
      expect(tables).toEqual([{ name: 'scrum_team_members' }]);

      const cols = (await raw.all<{ name: string }>('PRAGMA table_info(scrum_team_members)'))
        .map((c) => c.name);
      expect(cols).toEqual([
        'id',
        'team_slug',
        'role',
        'contributor_id',
        'from_ts',
        'to_ts',
        'reason',
        'created_at',
      ]);
    } finally {
      raw.close();
    }
  });

  test('v16 member rows round-trip against an existing team', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);
      await raw.exec(
        "INSERT INTO scrum_teams (slug, team_type, created_at) VALUES ('payments', 'stream_aligned', '2026-01-01T00:00:00Z')",
      );
      await raw.exec(
        "INSERT INTO scrum_team_members (team_slug, role, contributor_id, from_ts, to_ts, reason, created_at) VALUES ('payments', 'tech_lead', 'ct-jane', '2026-01-01T00:00:00Z', NULL, 'founding lead', '2026-01-01T00:00:00Z')",
      );
      const rows = await raw.all<{ role: string; contributor_id: string; to_ts: string | null }>(
        'SELECT role, contributor_id, to_ts FROM scrum_team_members WHERE team_slug = ?',
        ['payments'],
      );
      expect(rows).toEqual([{ role: 'tech_lead', contributor_id: 'ct-jane', to_ts: null }]);
    } finally {
      raw.close();
    }
  });

  test('SCRUM_MIGRATION_V17_SQL creates both interface tables + per-team indexes', async () => {
    expect(SCRUM_MIGRATION_V17_SQL).toContain('CREATE TABLE scrum_team_accepts');
    expect(SCRUM_MIGRATION_V17_SQL).toContain('CREATE TABLE scrum_team_exposes');
    expect(SCRUM_MIGRATION_V17_SQL).toContain('idx_scrum_team_accepts_team');
    expect(SCRUM_MIGRATION_V17_SQL).toContain('idx_scrum_team_exposes_team');
    expect(SCRUM_MIGRATION_V17_SQL).toContain('REFERENCES scrum_teams(slug)');
    // status defaults to 'active'; the supersession columns are nullable.
    expect(SCRUM_MIGRATION_V17_SQL).toContain("DEFAULT 'active'");
  });

  test('a fresh store has scrum_team_accepts + scrum_team_exposes with the v17 column shape', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);

      const acceptCols = (await raw.all<{ name: string }>('PRAGMA table_info(scrum_team_accepts)'))
        .map((c) => c.name);
      expect(acceptCols).toEqual([
        'id',
        'team_slug',
        'ask_type',
        'status',
        'superseded_by',
        'reason',
        'created_at',
      ]);

      const exposeCols = (await raw.all<{ name: string }>('PRAGMA table_info(scrum_team_exposes)'))
        .map((c) => c.name);
      expect(exposeCols).toEqual([
        'id',
        'team_slug',
        'name',
        'schema_ref',
        'status',
        'superseded_by',
        'reason',
        'created_at',
      ]);
    } finally {
      raw.close();
    }
  });

  test('v17 interface rows round-trip against an existing team and default status active', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);
      await raw.exec(
        "INSERT INTO scrum_teams (slug, team_type, created_at) VALUES ('payments', 'stream_aligned', '2026-01-01T00:00:00Z')",
      );
      await raw.exec(
        "INSERT INTO scrum_team_accepts (team_slug, ask_type, created_at) VALUES ('payments', 'schema-change', '2026-01-01T00:00:00Z')",
      );
      await raw.exec(
        "INSERT INTO scrum_team_exposes (team_slug, name, schema_ref, created_at) VALUES ('payments', 'PaymentEvent', 'schemas/payment-event.json', '2026-01-01T00:00:00Z')",
      );
      const accepts = await raw.all<{ ask_type: string; status: string; superseded_by: number | null }>(
        'SELECT ask_type, status, superseded_by FROM scrum_team_accepts WHERE team_slug = ?',
        ['payments'],
      );
      expect(accepts).toEqual([
        { ask_type: 'schema-change', status: 'active', superseded_by: null },
      ]);
      const exposes = await raw.all<{ name: string; schema_ref: string; status: string }>(
        'SELECT name, schema_ref, status FROM scrum_team_exposes WHERE team_slug = ?',
        ['payments'],
      );
      expect(exposes).toEqual([
        { name: 'PaymentEvent', schema_ref: 'schemas/payment-event.json', status: 'active' },
      ]);
    } finally {
      raw.close();
    }
  });

  test('SCRUM_MIGRATION_V18_SQL adds scrum_teams.terminates_on_milestone + status', async () => {
    expect(SCRUM_MIGRATION_V18_SQL).toContain(
      'ALTER TABLE scrum_teams ADD COLUMN terminates_on_milestone',
    );
    expect(SCRUM_MIGRATION_V18_SQL).toContain('ALTER TABLE scrum_teams ADD COLUMN status');
    expect(SCRUM_MIGRATION_V18_SQL).toContain("DEFAULT 'active'");
  });

  test('v18 ADD COLUMN defaults terminates_on_milestone NULL + status active on existing teams', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);
      // Insert without the v18 columns — simulates a pre-v18 team carried through
      // the upgrade. terminates_on_milestone reads NULL, status reads 'active'.
      await raw.exec(
        "INSERT INTO scrum_teams (slug, team_type, lifetime, created_at) VALUES ('legacy', 'platform', 'persistent', '2026-01-01T00:00:00Z')",
      );
      const row = await raw.all<{ terminates_on_milestone: string | null; status: string }>(
        'SELECT terminates_on_milestone, status FROM scrum_teams WHERE slug = ?',
        ['legacy'],
      );
      expect(row).toEqual([{ terminates_on_milestone: null, status: 'active' }]);
    } finally {
      raw.close();
    }
  });

  test('SCRUM_MIGRATION_V19_SQL creates scrum_lores + team index, FK to scrum_teams', async () => {
    expect(SCRUM_MIGRATION_V19_SQL).toContain('CREATE TABLE scrum_lores');
    expect(SCRUM_MIGRATION_V19_SQL).toContain('idx_scrum_lores_team');
    expect(SCRUM_MIGRATION_V19_SQL).toContain('REFERENCES scrum_teams(slug)');
  });

  test('a fresh store has scrum_lores with the v19 column shape + v28 supersession columns', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);
      const tables = await raw.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'scrum_lores'",
      );
      expect(tables).toEqual([{ name: 'scrum_lores' }]);
      const cols = (await raw.all<{ name: string }>('PRAGMA table_info(scrum_lores)')).map((c) => c.name);
      // v28 appends the supersession pointer + reason after the v19 base
      // columns (ADD COLUMN lands them at the end), NULL defaults.
      expect(cols).toEqual([
        'id',
        'team_slug',
        'body',
        'author_contributor_id',
        'created_at',
        'superseded_by',
        'reason',
      ]);
    } finally {
      raw.close();
    }
  });

  test('v19 Lore rows round-trip against an existing team, oldest-first by id', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);
      await raw.exec(
        "INSERT INTO scrum_teams (slug, team_type, created_at) VALUES ('payments', 'stream_aligned', '2026-01-01T00:00:00Z')",
      );
      await raw.exec(
        "INSERT INTO scrum_lores (team_slug, body, author_contributor_id, created_at) VALUES ('payments', 'prefer idempotent migrations', 'CT-lead', '2026-01-01T00:00:00Z')",
      );
      await raw.exec(
        "INSERT INTO scrum_lores (team_slug, body, author_contributor_id, created_at) VALUES ('payments', 'pin the schema version', 'CT-lead', '2026-01-02T00:00:00Z')",
      );
      const rows = await raw.all<{ id: number; body: string; author_contributor_id: string }>(
        'SELECT id, body, author_contributor_id FROM scrum_lores WHERE team_slug = ? ORDER BY id ASC',
        ['payments'],
      );
      expect(rows).toEqual([
        { id: 1, body: 'prefer idempotent migrations', author_contributor_id: 'CT-lead' },
        { id: 2, body: 'pin the schema version', author_contributor_id: 'CT-lead' },
      ]);
    } finally {
      raw.close();
    }
  });

  test('SCRUM_MIGRATION_V20_SQL creates scrum_annotations + a (target_kind, target_ref) index', async () => {
    expect(SCRUM_MIGRATION_V20_SQL).toContain('CREATE TABLE scrum_annotations');
    expect(SCRUM_MIGRATION_V20_SQL).toContain('idx_scrum_annotations_target');
    // target_ref is a SOFT reference — it spans multiple tables by target_kind,
    // so it carries no foreign key.
    expect(SCRUM_MIGRATION_V20_SQL).not.toContain('REFERENCES');
  });

  test('a fresh store has scrum_annotations with the v20 column shape', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);
      const tables = await raw.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'scrum_annotations'",
      );
      expect(tables).toEqual([{ name: 'scrum_annotations' }]);
      const cols = (await raw.all<{ name: string }>('PRAGMA table_info(scrum_annotations)'))
        .map((c) => c.name);
      expect(cols).toEqual(['id', 'target_kind', 'target_ref', 'body', 'author', 'created_at']);
    } finally {
      raw.close();
    }
  });

  test('v20 Annotation rows round-trip per (target_kind, target_ref), oldest-first by id', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);
      // No team/task/decision row exists — target_ref is a soft reference, so a
      // note attaches without the target's presence.
      await raw.exec(
        "INSERT INTO scrum_annotations (target_kind, target_ref, body, author, created_at) VALUES ('task', 't1', 'watch the off-by-one', 'CT-a', '2026-01-01T00:00:00Z')",
      );
      await raw.exec(
        "INSERT INTO scrum_annotations (target_kind, target_ref, body, author, created_at) VALUES ('task', 't1', 'fixed in follow-up', 'CT-b', '2026-01-02T00:00:00Z')",
      );
      // A different target_kind sharing the same ref does NOT collide.
      await raw.exec(
        "INSERT INTO scrum_annotations (target_kind, target_ref, body, author, created_at) VALUES ('team', 't1', 'team note', 'CT-c', '2026-01-03T00:00:00Z')",
      );
      const rows = await raw.all<{ id: number; body: string; author: string }>(
        'SELECT id, body, author FROM scrum_annotations WHERE target_kind = ? AND target_ref = ? ORDER BY id ASC',
        ['task', 't1'],
      );
      expect(rows).toEqual([
        { id: 1, body: 'watch the off-by-one', author: 'CT-a' },
        { id: 2, body: 'fixed in follow-up', author: 'CT-b' },
      ]);
    } finally {
      raw.close();
    }
  });

  test('SCRUM_MIGRATION_V21_SQL adds the three gated-write columns to scrum_decisions', async () => {
    expect(SCRUM_MIGRATION_V21_SQL).toContain(
      'ALTER TABLE scrum_decisions ADD COLUMN write_status',
    );
    expect(SCRUM_MIGRATION_V21_SQL).toContain(
      'ALTER TABLE scrum_decisions ADD COLUMN gate_responder',
    );
    expect(SCRUM_MIGRATION_V21_SQL).toContain(
      'ALTER TABLE scrum_decisions ADD COLUMN gate_responded_at',
    );
  });

  test('a fresh store has scrum_decisions with the v21 column shape appended', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);
      const cols = (await raw.all<{ name: string; type: string; notnull: number }>(
          "SELECT name, type, [notnull] FROM pragma_table_info('scrum_decisions') ORDER BY cid",
        ))
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
        'superseded_by:TEXT:0',
        'reason:TEXT:0',
        'kind:TEXT:0',
        // v21 gated-write columns append at the end, NULL default.
        'write_status:TEXT:0',
        'gate_responder:TEXT:0',
        'gate_responded_at:TEXT:0',
        // v22 Lore→Codex promotion provenance appends, NULL default.
        'source_lore_id:INTEGER:0',
      ]);
    } finally {
      raw.close();
    }
  });

  test('v21 ADD COLUMN defaults the gated-write columns to NULL on existing rows', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);
      // A decision inserted without the v21 columns — simulates a pre-v21 row
      // carried through the upgrade. The new columns must read NULL.
      await raw.exec(
        "INSERT INTO scrum_decisions (id, title, status, content, content_sha, recorded_at) VALUES ('d1', 'D1', 'accepted', 'body', 'sha', '2026-01-01T00:00:00Z')",
      );
      const row = await raw.all<{
        write_status: string | null;
        gate_responder: string | null;
        gate_responded_at: string | null;
      }>(
        'SELECT write_status, gate_responder, gate_responded_at FROM scrum_decisions WHERE id = ?',
        ['d1'],
      );
      expect(row).toEqual([{ write_status: null, gate_responder: null, gate_responded_at: null }]);
    } finally {
      raw.close();
    }
  });

  test('SCRUM_MIGRATION_V22_SQL adds source_lore_id referencing scrum_lores', async () => {
    expect(SCRUM_MIGRATION_V22_SQL).toContain(
      'ALTER TABLE scrum_decisions ADD COLUMN source_lore_id',
    );
    expect(SCRUM_MIGRATION_V22_SQL).toContain('REFERENCES scrum_lores(id)');
  });

  test('v22 ADD COLUMN defaults source_lore_id to NULL on existing rows', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);
      // A decision inserted without the v22 column — simulates a pre-v22 row
      // carried through the upgrade. The new column must read NULL.
      await raw.exec(
        "INSERT INTO scrum_decisions (id, title, status, content, content_sha, recorded_at) VALUES ('d1', 'D1', 'accepted', 'body', 'sha', '2026-01-01T00:00:00Z')",
      );
      const row = await raw.all<{ source_lore_id: number | null }>(
        'SELECT source_lore_id FROM scrum_decisions WHERE id = ?',
        ['d1'],
      );
      expect(row).toEqual([{ source_lore_id: null }]);
    } finally {
      raw.close();
    }
  });

  test('SCRUM_MIGRATION_V23_SQL creates scrum_asks + both indexes with the two team FKs + artifact FK', async () => {
    expect(SCRUM_MIGRATION_V23_SQL).toContain('CREATE TABLE scrum_asks');
    expect(SCRUM_MIGRATION_V23_SQL).toContain(
      'from_team TEXT NOT NULL REFERENCES scrum_teams(slug)',
    );
    expect(SCRUM_MIGRATION_V23_SQL).toContain('to_team TEXT NOT NULL REFERENCES scrum_teams(slug)');
    expect(SCRUM_MIGRATION_V23_SQL).toContain(
      'blocking_artifact TEXT NOT NULL REFERENCES scrum_tasks(id)',
    );
    expect(SCRUM_MIGRATION_V23_SQL).toContain("DEFAULT 'filed'");
    expect(SCRUM_MIGRATION_V23_SQL).toContain('idx_scrum_asks_to_team');
    expect(SCRUM_MIGRATION_V23_SQL).toContain('idx_scrum_asks_blocking_artifact');
  });

  test('v23 scrum_asks persists a filed row and defaults state to filed', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);
      await raw.exec(
        "INSERT INTO scrum_teams (slug, team_type, lifetime, created_at) VALUES ('payments', 'stream_aligned', 'persistent', '2026-01-01T00:00:00Z')",
      );
      await raw.exec(
        "INSERT INTO scrum_teams (slug, team_type, lifetime, created_at) VALUES ('identity', 'platform', 'persistent', '2026-01-01T00:00:00Z')",
      );
      await raw.exec(
        "INSERT INTO scrum_tasks (id, title, status, created_at) VALUES ('blocked-1', 'B', 'todo', '2026-01-01T00:00:00Z')",
      );
      // No explicit state column — the DEFAULT 'filed' must apply.
      await raw.exec(
        "INSERT INTO scrum_asks (from_team, to_team, ask_type, blocking_artifact, created_at) VALUES ('payments', 'identity', 'schema-change', 'blocked-1', '2026-01-01T00:00:00Z')",
      );
      const row = await raw.all<{ state: string; to_team: string }>(
        'SELECT state, to_team FROM scrum_asks',
      );
      expect(row).toEqual([{ state: 'filed', to_team: 'identity' }]);
    } finally {
      raw.close();
    }
  });

  test('SCRUM_MIGRATION_V25_SQL adds the three ask-response columns', async () => {
    expect(SCRUM_MIGRATION_V25_SQL).toContain('ALTER TABLE scrum_asks ADD COLUMN mapped_artifact');
    expect(SCRUM_MIGRATION_V25_SQL).toContain('ALTER TABLE scrum_asks ADD COLUMN rejected_reason');
    expect(SCRUM_MIGRATION_V25_SQL).toContain('ALTER TABLE scrum_asks ADD COLUMN counter_proposal');
  });

  test('v25 ADD COLUMN defaults the three response columns to NULL on a filed row', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);
      await raw.exec(
        "INSERT INTO scrum_teams (slug, team_type, lifetime, created_at) VALUES ('payments', 'stream_aligned', 'persistent', '2026-01-01T00:00:00Z')",
      );
      await raw.exec(
        "INSERT INTO scrum_teams (slug, team_type, lifetime, created_at) VALUES ('identity', 'platform', 'persistent', '2026-01-01T00:00:00Z')",
      );
      await raw.exec(
        "INSERT INTO scrum_tasks (id, title, status, created_at) VALUES ('blocked-1', 'B', 'todo', '2026-01-01T00:00:00Z')",
      );
      await raw.exec(
        "INSERT INTO scrum_asks (from_team, to_team, ask_type, blocking_artifact, created_at) VALUES ('payments', 'identity', 'schema-change', 'blocked-1', '2026-01-01T00:00:00Z')",
      );
      const row = await raw.all<{
        mapped_artifact: string | null;
        rejected_reason: string | null;
        counter_proposal: string | null;
      }>('SELECT mapped_artifact, rejected_reason, counter_proposal FROM scrum_asks');
      expect(row).toEqual([
        { mapped_artifact: null, rejected_reason: null, counter_proposal: null },
      ]);
    } finally {
      raw.close();
    }
  });
});
