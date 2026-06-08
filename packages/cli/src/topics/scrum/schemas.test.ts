/**
 * Schema tests for the scrum domain — the redesigned sync-safe v1 schema.
 *
 * Every test opens a fresh `:memory:` store so registration + the single v1
 * migration run end-to-end. The schema is a from-scratch base (no incremental
 * chain), and every primary key is a distinct collision-free value (ULID TEXT,
 * natural slug, or composite key) — NO AUTOINCREMENT, no INTEGER rowid alias —
 * so two concurrent inserts both survive whole-transaction sync replay.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import {
  type SchemaDef,
  clearRegistry,
  listDomains,
  openStore,
  registerSchema,
  runMigrations,
  ulid,
} from '@claude-prove/store';
import {
  SCRUM_MIGRATION_V1_SQL,
  SCRUM_SCHEMA_VERSION,
  ensureScrumSchemaRegistered,
} from './schemas';

describe('scrum domain registration', () => {
  beforeEach(async () => {
    // Registry is process-wide and shared across every test file in the run. A
    // sibling file can leave 'scrum' registered with a partial def, in which
    // case a bare ensureScrumSchemaRegistered() no-ops and the stale def leaks
    // here. Clear first, then re-register the canonical v1 def.
    clearRegistry();
    ensureScrumSchemaRegistered();
  });

  test("listDomains() includes 'scrum' after module import", async () => {
    expect(listDomains()).toContain('scrum');
  });

  test('SCRUM_MIGRATION_V1_SQL creates every scrum_* table', async () => {
    for (const table of [
      'scrum_tasks',
      'scrum_milestones',
      'scrum_tags',
      'scrum_deps',
      'scrum_events',
      'scrum_run_links',
      'scrum_context_bundles',
      'scrum_decisions',
      'scrum_contributors',
      'scrum_operator_history',
      'scrum_teams',
      'scrum_team_scopes',
      'scrum_team_members',
      'scrum_team_accepts',
      'scrum_team_exposes',
      'scrum_lores',
      'scrum_annotations',
      'scrum_asks',
      'scrum_escalations',
    ]) {
      expect(SCRUM_MIGRATION_V1_SQL).toContain(`CREATE TABLE ${table}`);
    }
  });

  test('SCRUM_SCHEMA_VERSION is the fresh v1 reset', async () => {
    expect(SCRUM_SCHEMA_VERSION).toBe(1);
  });

  test('the v1 DDL carries zero AUTOINCREMENT', async () => {
    expect(SCRUM_MIGRATION_V1_SQL).not.toContain('AUTOINCREMENT');
  });

  test('migration creates all 19 scrum_* tables', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);
      const tables = (
        await raw.all<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'scrum_%' ORDER BY name",
        )
      ).map((r) => r.name);
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

  test('migration creates all 22 scrum indexes', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);
      const indexes = (
        await raw.all<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_scrum_%' ORDER BY name",
        )
      ).map((r) => r.name);
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

  // -- No-AUTOINCREMENT / TEXT-PK shape ------------------------------------

  test('every scrum_* table PK column is TEXT or composite — no INTEGER rowid alias', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);
      const tables = (
        await raw.all<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'scrum_%'",
        )
      ).map((r) => r.name);
      for (const table of tables) {
        const cols = await raw.all<{ name: string; type: string; pk: number }>(
          `PRAGMA table_info(${table})`,
        );
        const pkCols = cols.filter((c) => c.pk > 0);
        // Every PK column is declared TEXT; a single-INTEGER PK would be a
        // rowid alias (the exact shape sync replay loses a row on).
        for (const pk of pkCols) {
          expect(pk.type).toBe('TEXT');
        }
      }
    } finally {
      raw.close();
    }
  });

  test('no scrum_* table is AUTOINCREMENT — sqlite_sequence never materializes', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);
      // sqlite_sequence is created only when an AUTOINCREMENT column exists.
      // Insert across the formerly-AUTOINCREMENT tables; the sequence table
      // must never appear.
      await raw.exec(`
        INSERT INTO scrum_milestones (id, title, status, created_at) VALUES ('m1', 'M1', 'active', '2026-01-01T00:00:00Z');
        INSERT INTO scrum_tasks (id, title, status, created_at) VALUES ('t1', 'T1', 'backlog', '2026-01-01T00:00:00Z');
        INSERT INTO scrum_events (id, task_id, ts, kind, payload_json) VALUES ('${ulid()}', 't1', '2026-01-01T00:00:00Z', 'note', '{}');
        INSERT INTO scrum_escalations (id, task_id, escalation_type, layer, summary, created_at) VALUES ('${ulid()}', 't1', 'blocked', 'implementer', 's', '2026-01-01T00:00:00Z');
      `);
      const seq = await raw.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'",
      );
      expect(seq).toEqual([]);
    } finally {
      raw.close();
    }
  });

  // -- scrum_tasks ----------------------------------------------------------

  test('scrum_tasks column shape matches the redesigned spec', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);
      const cols = (
        await raw.all<{ name: string; type: string; notnull: number }>(
          "SELECT name, type, [notnull] FROM pragma_table_info('scrum_tasks') ORDER BY cid",
        )
      ).map((c) => `${c.name}:${c.type}:${c.notnull}`);
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
        'parent_id:TEXT:0',
        'layer:TEXT:0',
        'acceptance_json:TEXT:0',
        'bounds_json:TEXT:0',
        'terminal_reason:TEXT:0',
        'terminal_detail:TEXT:0',
        'last_modified_by:TEXT:0',
        'last_modified_at:TEXT:0',
        'worker_id:TEXT:0',
        'run_id:TEXT:0',
        'team_slug:TEXT:0',
      ]);
    } finally {
      raw.close();
    }
  });

  test('scrum_tasks optional columns default to NULL on a bare insert', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);
      await raw.exec(
        "INSERT INTO scrum_tasks (id, title, status, created_at) VALUES ('t1', 'T1', 'backlog', '2026-01-01T00:00:00Z')",
      );
      const row = await raw.all<Record<string, unknown>>(
        'SELECT parent_id, layer, acceptance_json, bounds_json, terminal_reason, terminal_detail, last_modified_by, last_modified_at, worker_id, run_id, team_slug FROM scrum_tasks WHERE id = ?',
        ['t1'],
      );
      expect(row).toEqual([
        {
          parent_id: null,
          layer: null,
          acceptance_json: null,
          bounds_json: null,
          terminal_reason: null,
          terminal_detail: null,
          last_modified_by: null,
          last_modified_at: null,
          worker_id: null,
          run_id: null,
          team_slug: null,
        },
      ]);
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
      await raw.exec(
        "INSERT INTO scrum_deps (from_task_id, to_task_id, kind) VALUES ('a', 'b', 'blocks')",
      );
    } finally {
      raw.close();
    }
  });

  // -- scrum_decisions ------------------------------------------------------

  test('scrum_decisions column shape; source_lore_id is TEXT (cross-domain FK to scrum_lores)', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);
      const cols = (
        await raw.all<{ name: string; type: string; notnull: number }>(
          "SELECT name, type, [notnull] FROM pragma_table_info('scrum_decisions') ORDER BY cid",
        )
      ).map((c) => `${c.name}:${c.type}:${c.notnull}`);
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
        'write_status:TEXT:0',
        'gate_responder:TEXT:0',
        'gate_responded_at:TEXT:0',
        // The Lore→Codex promotion provenance is now a TEXT ULID ref.
        'source_lore_id:TEXT:0',
      ]);
    } finally {
      raw.close();
    }
  });

  test('scrum_decisions defaults status to accepted; optional columns NULL', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);
      await raw.exec(
        "INSERT INTO scrum_decisions (id, title, content, content_sha, recorded_at) VALUES ('d1', 'D1', 'body', 'deadbeef', '2026-01-01T00:00:00Z')",
      );
      const row = await raw.all<{
        status: string;
        superseded_by: string | null;
        source_lore_id: string | null;
      }>('SELECT status, superseded_by, source_lore_id FROM scrum_decisions WHERE id = ?', ['d1']);
      expect(row).toEqual([{ status: 'accepted', superseded_by: null, source_lore_id: null }]);
    } finally {
      raw.close();
    }
  });

  // -- scrum_escalations ----------------------------------------------------

  test('scrum_escalations column shape; id + walked_up_from are TEXT', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);
      const cols = (
        await raw.all<{ name: string; type: string; notnull: number }>(
          "SELECT name, type, [notnull] FROM pragma_table_info('scrum_escalations') ORDER BY cid",
        )
      ).map((c) => `${c.name}:${c.type}:${c.notnull}`);
      expect(cols).toEqual([
        'id:TEXT:0',
        'task_id:TEXT:1',
        'escalation_type:TEXT:1',
        'layer:TEXT:1',
        'state:TEXT:1',
        'summary:TEXT:1',
        'raised_by:TEXT:0',
        'resolution_mode:TEXT:0',
        'resolution_note:TEXT:0',
        'resolved_by:TEXT:0',
        'walked_up_from:TEXT:0',
        'attributes:TEXT:0',
        'created_at:TEXT:1',
        'resolved_at:TEXT:0',
      ]);
    } finally {
      raw.close();
    }
  });

  test('scrum_escalations defaults a fresh row to open with a TEXT id', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);
      const id = ulid();
      await raw.exec(
        `INSERT INTO scrum_escalations (id, task_id, escalation_type, layer, summary, created_at) VALUES ('${id}', 't1', 'blocked', 'implementer', 's', '2026-01-01T00:00:00Z')`,
      );
      const row = await raw.all<{ id: string; state: string; walked_up_from: string | null }>(
        'SELECT id, state, walked_up_from FROM scrum_escalations',
      );
      expect(row).toEqual([{ id, state: 'open', walked_up_from: null }]);
    } finally {
      raw.close();
    }
  });

  // -- migration runner behavior -------------------------------------------

  test('migration applies the single scrum v1 hop', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      const result = await runMigrations(raw);
      expect(result.applied.filter((a) => a.domain === 'scrum').map((a) => a.version)).toEqual([1]);
    } finally {
      raw.close();
    }
  });

  test('migration is idempotent — rerunning does not duplicate log rows', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      const first = await runMigrations(raw);
      expect(first.applied.filter((a) => a.domain === 'scrum').map((a) => a.version)).toEqual([1]);

      const second = await runMigrations(raw);
      expect(second.applied.filter((a) => a.domain === 'scrum')).toEqual([]);

      const versions = await raw.all<{ version: number }>(
        'SELECT version FROM _migrations_log WHERE domain = ? ORDER BY version',
        ['scrum'],
      );
      expect(versions).toEqual([{ version: 1 }]);
    } finally {
      raw.close();
    }
  });

  test('duplicate migration version within scrum domain throws at register time', async () => {
    clearRegistry();
    const def: SchemaDef = {
      domain: 'scrum',
      migrations: [
        { version: 1, description: 'a', up: () => {} },
        { version: 1, description: 'b', up: () => {} },
      ],
    };
    expect(() => registerSchema(def)).toThrow(/duplicate migration version 1/);
    clearRegistry();
    ensureScrumSchemaRegistered();
  });

  test('_migrations_log entry description matches the registered v1 description', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);
      const log = await raw.all<{ domain: string; version: number; description: string }>(
        'SELECT domain, version, description FROM _migrations_log WHERE domain = ? ORDER BY version',
        ['scrum'],
      );
      expect(log).toHaveLength(1);
      const [v1] = log;
      if (!v1) throw new Error('expected one log entry');
      expect(v1.domain).toBe('scrum');
      expect(v1.version).toBe(1);
      expect(v1.description).toContain('scrum schema');
    } finally {
      raw.close();
    }
  });

  // -- registry / contributors / operator history --------------------------

  test('scrum_contributors enforces slug uniqueness', async () => {
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

  test('scrum_operator_history has a TEXT id and a nullable open interval', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);
      const cols = (
        await raw.all<{ name: string; type: string; pk: number }>(
          'PRAGMA table_info(scrum_operator_history)',
        )
      ).map((c) => `${c.name}:${c.type}:${c.pk}`);
      expect(cols).toEqual([
        'id:TEXT:1',
        'contributor_id:TEXT:0',
        'from_ts:TEXT:0',
        'to_ts:TEXT:0',
        'created_at:TEXT:0',
        'created_by:TEXT:0',
      ]);
      await raw.exec(
        "INSERT INTO scrum_contributors (id, slug, status, created_at) VALUES ('ct-jane', 'jane', 'active', '2026-01-01T00:00:00Z')",
      );
      await raw.exec(
        `INSERT INTO scrum_operator_history (id, contributor_id, from_ts, to_ts, created_at) VALUES ('${ulid()}', 'ct-jane', '2026-01-01T00:00:00Z', NULL, '2026-01-01T00:00:00Z')`,
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

  // -- teams / scopes / members / interface --------------------------------

  test('scrum_teams enforces slug uniqueness and defaults lifetime/status', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);
      await raw.exec(
        "INSERT INTO scrum_teams (slug, team_type, created_at) VALUES ('platform-core', 'platform', '2026-01-01T00:00:00Z')",
      );
      await expect(
        raw.exec(
          "INSERT INTO scrum_teams (slug, team_type, created_at) VALUES ('platform-core', 'platform', '2026-01-02T00:00:00Z')",
        ),
      ).rejects.toThrow();
      const row = await raw.all<{
        lifetime: string;
        status: string;
        terminates_on_milestone: string | null;
      }>(
        'SELECT lifetime, status, terminates_on_milestone FROM scrum_teams WHERE slug = ?',
        ['platform-core'],
      );
      expect(row).toEqual([{ lifetime: 'persistent', status: 'active', terminates_on_milestone: null }]);
    } finally {
      raw.close();
    }
  });

  test('scrum_team_scopes carries an explicit composite PK (team_slug, kind, glob)', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);
      const cols = (
        await raw.all<{ name: string; pk: number }>('PRAGMA table_info(scrum_team_scopes)')
      ).filter((c) => c.pk > 0);
      // All three columns participate in the composite PK (pk index order set).
      expect(cols.map((c) => c.name).sort()).toEqual(['glob', 'kind', 'team_slug']);

      await raw.exec(
        "INSERT INTO scrum_teams (slug, team_type, created_at) VALUES ('payments', 'stream_aligned', '2026-01-01T00:00:00Z')",
      );
      await raw.exec(
        "INSERT INTO scrum_team_scopes (team_slug, kind, glob) VALUES ('payments', 'write', 'src/payments/**')",
      );
      // The same (team, kind, glob) triple is rejected by the composite PK.
      await expect(
        raw.exec(
          "INSERT INTO scrum_team_scopes (team_slug, kind, glob) VALUES ('payments', 'write', 'src/payments/**')",
        ),
      ).rejects.toThrow();
    } finally {
      raw.close();
    }
  });

  test('scrum_team_members has a TEXT id and round-trips against a team', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);
      await raw.exec(
        "INSERT INTO scrum_teams (slug, team_type, created_at) VALUES ('payments', 'stream_aligned', '2026-01-01T00:00:00Z')",
      );
      await raw.exec(
        `INSERT INTO scrum_team_members (id, team_slug, role, contributor_id, from_ts, to_ts, reason, created_at) VALUES ('${ulid()}', 'payments', 'tech_lead', 'ct-jane', '2026-01-01T00:00:00Z', NULL, 'founding lead', '2026-01-01T00:00:00Z')`,
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

  test('scrum_team_accepts/exposes have TEXT id + TEXT self-FK superseded_by, default status active', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);
      const acceptCols = (
        await raw.all<{ name: string; type: string }>('PRAGMA table_info(scrum_team_accepts)')
      ).map((c) => `${c.name}:${c.type}`);
      expect(acceptCols).toEqual([
        'id:TEXT',
        'team_slug:TEXT',
        'ask_type:TEXT',
        'status:TEXT',
        'superseded_by:TEXT',
        'reason:TEXT',
        'created_at:TEXT',
      ]);
      const exposeCols = (
        await raw.all<{ name: string; type: string }>('PRAGMA table_info(scrum_team_exposes)')
      ).map((c) => `${c.name}:${c.type}`);
      expect(exposeCols).toEqual([
        'id:TEXT',
        'team_slug:TEXT',
        'name:TEXT',
        'schema_ref:TEXT',
        'status:TEXT',
        'superseded_by:TEXT',
        'reason:TEXT',
        'created_at:TEXT',
      ]);

      await raw.exec(
        "INSERT INTO scrum_teams (slug, team_type, created_at) VALUES ('payments', 'stream_aligned', '2026-01-01T00:00:00Z')",
      );
      await raw.exec(
        `INSERT INTO scrum_team_accepts (id, team_slug, ask_type, created_at) VALUES ('${ulid()}', 'payments', 'schema-change', '2026-01-01T00:00:00Z')`,
      );
      const accepts = await raw.all<{ ask_type: string; status: string; superseded_by: string | null }>(
        'SELECT ask_type, status, superseded_by FROM scrum_team_accepts WHERE team_slug = ?',
        ['payments'],
      );
      expect(accepts).toEqual([{ ask_type: 'schema-change', status: 'active', superseded_by: null }]);
    } finally {
      raw.close();
    }
  });

  // -- lores / annotations --------------------------------------------------

  test('scrum_lores has a TEXT id + supersession columns; ULID order tracks insert order', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);
      const cols = (await raw.all<{ name: string; type: string }>('PRAGMA table_info(scrum_lores)')).map(
        (c) => `${c.name}:${c.type}`,
      );
      expect(cols).toEqual([
        'id:TEXT',
        'team_slug:TEXT',
        'body:TEXT',
        'author_contributor_id:TEXT',
        'created_at:TEXT',
        'superseded_by:TEXT',
        'reason:TEXT',
      ]);

      await raw.exec(
        "INSERT INTO scrum_teams (slug, team_type, created_at) VALUES ('payments', 'stream_aligned', '2026-01-01T00:00:00Z')",
      );
      const first = ulid();
      const second = ulid();
      // first < second lexicographically (monotonic), so ORDER BY id ASC keeps
      // insert order — the AUTOINCREMENT ordering semantics, preserved.
      await raw.exec(
        `INSERT INTO scrum_lores (id, team_slug, body, author_contributor_id, created_at) VALUES ('${first}', 'payments', 'prefer idempotent migrations', 'CT-lead', '2026-01-01T00:00:00Z')`,
      );
      await raw.exec(
        `INSERT INTO scrum_lores (id, team_slug, body, author_contributor_id, created_at) VALUES ('${second}', 'payments', 'pin the schema version', 'CT-lead', '2026-01-02T00:00:00Z')`,
      );
      const rows = await raw.all<{ body: string; superseded_by: string | null }>(
        'SELECT body, superseded_by FROM scrum_lores WHERE team_slug = ? ORDER BY id ASC',
        ['payments'],
      );
      expect(rows).toEqual([
        { body: 'prefer idempotent migrations', superseded_by: null },
        { body: 'pin the schema version', superseded_by: null },
      ]);
    } finally {
      raw.close();
    }
  });

  test('scrum_annotations target_ref is a soft reference (no FK) and id is TEXT', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);
      // The DDL fragment for this table declares no REFERENCES on target_ref.
      const annotationDDL = SCRUM_MIGRATION_V1_SQL.slice(
        SCRUM_MIGRATION_V1_SQL.indexOf('CREATE TABLE scrum_annotations'),
        SCRUM_MIGRATION_V1_SQL.indexOf('CREATE TABLE scrum_asks'),
      );
      expect(annotationDDL).not.toContain('REFERENCES');

      // No target row needs to exist — a note attaches by (kind, ref).
      await raw.exec(
        `INSERT INTO scrum_annotations (id, target_kind, target_ref, body, author, created_at) VALUES ('${ulid()}', 'task', 't1', 'watch the off-by-one', 'CT-a', '2026-01-01T00:00:00Z')`,
      );
      const rows = await raw.all<{ body: string; author: string }>(
        'SELECT body, author FROM scrum_annotations WHERE target_kind = ? AND target_ref = ?',
        ['task', 't1'],
      );
      expect(rows).toEqual([{ body: 'watch the off-by-one', author: 'CT-a' }]);
    } finally {
      raw.close();
    }
  });

  // -- asks -----------------------------------------------------------------

  test('scrum_asks persists a filed row with team + artifact FKs and defaults state to filed', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);
      await raw.exec(
        "INSERT INTO scrum_teams (slug, team_type, created_at) VALUES ('payments', 'stream_aligned', '2026-01-01T00:00:00Z')",
      );
      await raw.exec(
        "INSERT INTO scrum_teams (slug, team_type, created_at) VALUES ('identity', 'platform', '2026-01-01T00:00:00Z')",
      );
      await raw.exec(
        "INSERT INTO scrum_tasks (id, title, status, created_at) VALUES ('blocked-1', 'B', 'todo', '2026-01-01T00:00:00Z')",
      );
      await raw.exec(
        `INSERT INTO scrum_asks (id, from_team, to_team, ask_type, blocking_artifact, created_at) VALUES ('${ulid()}', 'payments', 'identity', 'schema-change', 'blocked-1', '2026-01-01T00:00:00Z')`,
      );
      const row = await raw.all<{
        state: string;
        to_team: string;
        mapped_artifact: string | null;
        rejected_reason: string | null;
        counter_proposal: string | null;
      }>(
        'SELECT state, to_team, mapped_artifact, rejected_reason, counter_proposal FROM scrum_asks',
      );
      expect(row).toEqual([
        {
          state: 'filed',
          to_team: 'identity',
          mapped_artifact: null,
          rejected_reason: null,
          counter_proposal: null,
        },
      ]);
    } finally {
      raw.close();
    }
  });
});
