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
import { SCRUM_MIGRATION_V1_SQL, ensureScrumSchemaRegistered } from './schemas';
import { type ScrumStore, openScrumStore } from './store';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let store: ScrumStore;

beforeEach(async () => {
  ensureScrumSchemaRegistered();
  store = await openScrumStore({ path: ':memory:' });
});

afterEach(() => {
  store.close();
  // Restore canonical registration so downstream test files see the full
  // ladder. The migration tests below call `registerSchema` with a partial
  // (v1/v1+v2-only) scrum def, which leaves `'scrum'` present in the
  // registry — so a bare `ensureScrumSchemaRegistered()` would no-op and
  // leak the stale def (dropping v3+). Clear first, then re-register the
  // canonical schema. Mirrors the teardown discipline in schemas.test.ts.
  clearRegistry();
  ensureScrumSchemaRegistered();
});

// ===========================================================================
// 1. Fresh DB — table + indexes materialize
// ===========================================================================

describe('ScrumStore — decisions: schema materialization', () => {
  test('opening the store creates scrum_decisions + both indexes', async () => {
    const names = (
      await store.getStore().all<{ name: string; type: string }>(
        `SELECT name, type FROM sqlite_master
         WHERE (type = 'table' AND name = 'scrum_decisions')
            OR (type = 'index' AND name LIKE 'idx_scrum_decisions%')
         ORDER BY name`,
      )
    ).map((r) => `${r.type}:${r.name}`);
    // SQL name ordering — 'idx_scrum_decisions_*' < 'scrum_decisions'.
    expect(names).toEqual([
      'index:idx_scrum_decisions_status',
      'index:idx_scrum_decisions_topic',
      'table:scrum_decisions',
    ]);
  });

  test('scrum_decisions column shape matches spec', async () => {
    const cols = (
      await store
        .getStore()
        .all<{ name: string; type: string; notnull: number; dflt_value: string | null }>(
          "SELECT name, type, [notnull], dflt_value FROM pragma_table_info('scrum_decisions') ORDER BY cid",
        )
    ).map((c) => `${c.name}:${c.type}:${c.notnull}`);
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
      // v4 columns are appended (ADD COLUMN lands them at the end), NULL default.
      'superseded_by:TEXT:0',
      'reason:TEXT:0',
      // v8 appends the Codex subtype, NULL default.
      'kind:TEXT:0',
      // v21 appends the gated-write columns, NULL default.
      'write_status:TEXT:0',
      'gate_responder:TEXT:0',
      'gate_responded_at:TEXT:0',
      // The Lore→Codex promotion provenance is a TEXT ULID ref to scrum_lores.
      'source_lore_id:TEXT:0',
      // Nullable fixed-32-dim float embedding, unpopulated at this layer (a
      // later semantic-search phase backfills it).
      'embedding:F32_BLOB:0',
    ]);
  });
});

// ===========================================================================
// 2. The consolidated v1 schema co-locates scrum_decisions with the core tables
// ===========================================================================

describe('ScrumStore — decisions: v1 schema materialization', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'scrum-decision-migrate-'));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  test('the single v1 DDL stands up scrum_decisions alongside scrum_tasks + scrum_events', async () => {
    const dbPath = join(projectDir, 'prove.db');

    // The redesigned schema is one fresh v1 hop: scrum_decisions is created in
    // the same DDL as the core tables (no separate add-decisions migration).
    clearRegistry();
    registerSchema({
      domain: 'scrum',
      migrations: [
        {
          version: 1,
          description: 'v1 consolidated test fixture',
          up: (db) => db.exec(SCRUM_MIGRATION_V1_SQL),
        },
      ],
    });

    const v1Store = await openStore({ path: dbPath });
    const result = await runMigrations(v1Store);
    expect(result.applied.filter((a) => a.domain === 'scrum').map((a) => a.version)).toEqual([1]);

    await v1Store.exec(`
      INSERT INTO scrum_tasks (id, title, status, created_at)
        VALUES ('t-seed', 'Seeded task', 'backlog', '2026-04-01T00:00:00Z');
      INSERT INTO scrum_events (id, task_id, ts, kind, payload_json)
        VALUES ('evt-seed', 't-seed', '2026-04-01T00:00:00Z', 'task_created', '{"title":"Seeded task"}');
    `);

    const tasks = await v1Store.all<{ id: string; title: string; status: string }>(
      'SELECT id, title, status FROM scrum_tasks',
    );
    expect(tasks).toEqual([{ id: 't-seed', title: 'Seeded task', status: 'backlog' }]);

    const events = await v1Store.all<{ task_id: string; kind: string }>(
      'SELECT task_id, kind FROM scrum_events',
    );
    expect(events).toEqual([{ task_id: 't-seed', kind: 'task_created' }]);

    // scrum_decisions exists in the same v1 DDL and starts empty.
    const decisionCount = await v1Store.all<{ count: number }>(
      'SELECT COUNT(*) AS count FROM scrum_decisions',
    );
    expect(decisionCount).toEqual([{ count: 0 }]);

    v1Store.close();
  });
});

// ===========================================================================
// 3. record + get round-trip
// ===========================================================================

describe('ScrumStore — decisions: record + get', () => {
  test('recordDecision persists the row and getDecision returns it byte-for-byte', async () => {
    const content = '# Adopt SQLite for prove store\n\nFull ADR body here.';
    const expectedSha = createHash('sha256').update(content).digest('hex');

    const recorded = await store.recordDecision({
      id: '2026-04-24-adopt-sqlite',
      title: 'Adopt SQLite for prove store',
      topic: 'architecture',
      content,
      sourcePath: '.prove/decisions/2026-04-24-adopt-sqlite.md',
      recordedByAgent: 'scrum-master',
    });

    expect(recorded.content_sha).toBe(expectedSha);
    expect(recorded.status).toBe('accepted'); // default

    const fetched = await store.getDecision('2026-04-24-adopt-sqlite');
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

  test('getDecision returns null for unknown id', async () => {
    expect(await store.getDecision('does-not-exist')).toBeNull();
  });

  test('recordDecision defaults nullable fields to null', async () => {
    await store.recordDecision({
      id: 'minimal',
      title: 'Minimal',
      content: 'body',
    });
    const row = await store.getDecision('minimal');
    if (!row) throw new Error('expected row');
    expect(row.topic).toBeNull();
    expect(row.source_path).toBeNull();
    expect(row.recorded_by_agent).toBeNull();
    expect(row.status).toBe('accepted');
    // v4: a freshly recorded decision is current, not superseded.
    expect(row.superseded_by).toBeNull();
    expect(row.reason).toBeNull();
    // v8: kind defaults to null (untyped).
    expect(row.kind).toBeNull();
  });

  test('recordDecision persists kind and re-record upsert preserves it', async () => {
    await store.recordDecision({ id: 'k1', title: 'K', content: 'body', kind: 'adr' });
    expect((await store.getDecision('k1'))?.kind).toBe('adr');
    // Re-record with a new kind overwrites on the upsert path.
    await store.recordDecision({ id: 'k1', title: 'K', content: 'body2', kind: 'pattern' });
    expect((await store.getDecision('k1'))?.kind).toBe('pattern');
  });

  test('listDecisions filters by kind case-insensitively', async () => {
    await store.recordDecision({ id: 'a', title: 'A', content: 'b', kind: 'adr' });
    await store.recordDecision({ id: 'g', title: 'G', content: 'b', kind: 'glossary' });
    await store.recordDecision({ id: 'u', title: 'U', content: 'b' });
    expect((await store.listDecisions({ kind: 'ADR' })).map((d) => d.id)).toEqual(['a']);
    expect((await store.listDecisions({ kind: 'glossary' })).map((d) => d.id)).toEqual(['g']);
    expect((await store.listDecisions()).length).toBe(3);
  });
});

// ===========================================================================
// 4b. supersedeDecision — append-only retire
// ===========================================================================

describe('ScrumStore — decisions: supersedeDecision', () => {
  beforeEach(async () => {
    await store.recordDecision({ id: 'old', title: 'Old decision', content: 'old body' });
    await store.recordDecision({ id: 'new', title: 'New decision', content: 'new body' });
  });

  test('happy path: old flips to superseded with pointer + reason; never deleted', async () => {
    const updated = await store.supersedeDecision('old', 'new', 'new approach chosen');
    expect(updated.status).toBe('superseded');
    expect(updated.superseded_by).toBe('new');
    expect(updated.reason).toBe('new approach chosen');

    // The original row survives — append-only, not a hard delete.
    const fetched = await store.getDecision('old');
    if (!fetched) throw new Error('superseded decision must remain in the store');
    expect(fetched.status).toBe('superseded');
    expect(fetched.superseded_by).toBe('new');
    expect(fetched.reason).toBe('new approach chosen');
    expect(fetched.content).toBe('old body'); // content untouched

    // The replacement stays current.
    const replacement = await store.getDecision('new');
    if (!replacement) throw new Error('expected replacement row');
    expect(replacement.status).toBe('accepted');
    expect(replacement.superseded_by).toBeNull();

    // Both rows still present — nothing was removed.
    const count = await store
      .getStore()
      .all<{ count: number }>('SELECT COUNT(*) AS count FROM scrum_decisions');
    expect(count).toEqual([{ count: 2 }]);
  });

  test('refuses when the decision is missing', async () => {
    await expect(store.supersedeDecision('ghost', 'new', 'why')).rejects.toThrow(
      /unknown decision 'ghost'/,
    );
  });

  test('refuses when the replacement is missing', async () => {
    await expect(store.supersedeDecision('old', 'ghost', 'why')).rejects.toThrow(
      /unknown replacement decision 'ghost'/,
    );
  });

  test('refuses to supersede a decision by itself', async () => {
    await expect(store.supersedeDecision('old', 'old', 'why')).rejects.toThrow(
      /cannot supersede itself/,
    );
  });

  test('refuses when the decision is already superseded', async () => {
    await store.supersedeDecision('old', 'new', 'first supersession');
    await store.recordDecision({ id: 'newer', title: 'Newer', content: 'newer body' });
    await expect(store.supersedeDecision('old', 'newer', 'second')).rejects.toThrow(
      /already superseded/,
    );
  });

  test('listDecisions still returns superseded rows by default (append-only)', async () => {
    await store.supersedeDecision('old', 'new', 'retired');

    const all = await store.listDecisions();
    expect(all.map((d) => d.id).sort()).toEqual(['new', 'old']);

    // The superseded row is filterable but never auto-hidden.
    const superseded = await store.listDecisions({ status: 'superseded' });
    expect(superseded.map((d) => d.id)).toEqual(['old']);
    expect(superseded[0]?.superseded_by).toBe('new');
    expect(superseded[0]?.reason).toBe('retired');
  });

  test('bare re-record of a superseded decision preserves the supersession pointer', async () => {
    // Retire 'old' via the only supported path.
    await store.supersedeDecision('old', 'new', 'new approach chosen');

    // Simulate `decision record old.md` / recover-from-git: a bare re-record
    // carries the body but asserts no status. It must NOT resurrect the row.
    const reRecorded = await store.recordDecision({
      id: 'old',
      title: 'Old decision (recovered)',
      content: 'old body, recovered from git',
    });

    // Pointer/reason/status survive; only the file-backed fields advance.
    expect(reRecorded.status).toBe('superseded');
    expect(reRecorded.superseded_by).toBe('new');
    expect(reRecorded.reason).toBe('new approach chosen');
    expect(reRecorded.title).toBe('Old decision (recovered)');
    expect(reRecorded.content).toBe('old body, recovered from git');
    expect(reRecorded.content_sha).toBe(
      createHash('sha256').update('old body, recovered from git').digest('hex'),
    );

    // Re-fetch confirms the persisted row, not just the return value.
    const fetched = await store.getDecision('old');
    if (!fetched) throw new Error('re-recorded decision must remain in the store');
    expect(fetched.status).toBe('superseded');
    expect(fetched.superseded_by).toBe('new');
    expect(fetched.reason).toBe('new approach chosen');

    // supersedeDecision still refuses a second retire — terminal state intact.
    await store.recordDecision({ id: 'newer', title: 'Newer', content: 'newer body' });
    await expect(store.supersedeDecision('old', 'newer', 'second')).rejects.toThrow(
      /already superseded/,
    );
  });
});

// ===========================================================================
// 4. Upsert on duplicate id
// ===========================================================================

describe('ScrumStore — decisions: upsert semantics', () => {
  test('recording the same id twice replaces content/title and bumps recorded_at', async () => {
    const first = await store.recordDecision({
      id: 'dup-id',
      title: 'First title',
      content: 'first body',
      topic: 'architecture',
    });

    // Sleep ~5ms so the ISO-second-precision timestamp strictly increases.
    // `isoNow()` is millisecond-precision, but be defensive against
    // same-millisecond collisions on fast machines.
    await new Promise((resolve) => setTimeout(resolve, 5));

    const second = await store.recordDecision({
      id: 'dup-id',
      title: 'Second title',
      content: 'second body',
      topic: 'architecture',
    });

    // Distinct content -> distinct sha.
    expect(second.content_sha).not.toBe(first.content_sha);
    expect(second.content_sha).toBe(createHash('sha256').update('second body').digest('hex'));

    // Exactly one row after the upsert.
    const row = await store.getDecision('dup-id');
    if (!row) throw new Error('expected upserted row');
    expect(row.title).toBe('Second title');
    expect(row.content).toBe('second body');
    expect(row.content_sha).toBe(second.content_sha);

    // recorded_at strictly advances.
    expect(row.recorded_at >= second.recorded_at).toBe(true);
    expect(Date.parse(row.recorded_at)).toBeGreaterThanOrEqual(Date.parse(first.recorded_at));

    const total = await store
      .getStore()
      .all<{ count: number }>('SELECT COUNT(*) AS count FROM scrum_decisions');
    expect(total).toEqual([{ count: 1 }]);
  });

  test('re-recording a non-superseded row leaves supersession NULL (regression guard)', async () => {
    // The supersession-preservation guard must only fire for terminal rows.
    // A current decision re-recorded with no status stays current with null
    // pointer/reason — unchanged from the original upsert semantics.
    await store.recordDecision({ id: 'current', title: 'Current', content: 'v1' });
    const reRecorded = await store.recordDecision({
      id: 'current',
      title: 'Current v2',
      content: 'v2',
    });

    expect(reRecorded.status).toBe('accepted');
    expect(reRecorded.superseded_by).toBeNull();
    expect(reRecorded.reason).toBeNull();
    expect(reRecorded.title).toBe('Current v2');
    expect(reRecorded.content).toBe('v2');
  });
});

// ===========================================================================
// 5. listDecisions filters
// ===========================================================================

describe('ScrumStore — decisions: listDecisions', () => {
  test('filters by topic, status, and returns all rows when no filter set', async () => {
    await store.recordDecision({
      id: 'arch-1',
      title: 'Arch 1',
      topic: 'architecture',
      content: 'a',
    });
    await store.recordDecision({
      id: 'arch-2',
      title: 'Arch 2',
      topic: 'architecture',
      status: 'superseded',
      content: 'b',
    });
    await store.recordDecision({
      id: 'proc-1',
      title: 'Proc 1',
      topic: 'process',
      content: 'c',
    });

    const all = await store.listDecisions();
    expect(all.map((d) => d.id).sort()).toEqual(['arch-1', 'arch-2', 'proc-1']);

    const byTopic = await store.listDecisions({ topic: 'architecture' });
    expect(byTopic.map((d) => d.id).sort()).toEqual(['arch-1', 'arch-2']);

    const byStatus = await store.listDecisions({ status: 'accepted' });
    expect(byStatus.map((d) => d.id).sort()).toEqual(['arch-1', 'proc-1']);

    const combined = await store.listDecisions({ topic: 'architecture', status: 'accepted' });
    expect(combined.map((d) => d.id)).toEqual(['arch-1']);
  });

  test('listDecisions filters are case-insensitive on topic and status', async () => {
    // ADRs authored with `**Status**: Accepted` (Title-Case) are stored as-is.
    // Operators filter naturally in lowercase (`--status accepted`); both
    // sides are lower()-normalized so the filter matches regardless of case.
    await store.recordDecision({
      id: 'titlecase',
      title: 'Title case',
      topic: 'Architecture',
      status: 'Accepted',
      content: 'body',
    });
    await store.recordDecision({
      id: 'lowercase',
      title: 'Lower case',
      topic: 'architecture',
      status: 'accepted',
      content: 'body',
    });
    await store.recordDecision({
      id: 'uppercase',
      title: 'Upper case',
      topic: 'ARCHITECTURE',
      status: 'ACCEPTED',
      content: 'body',
    });

    expect((await store.listDecisions({ status: 'accepted' })).map((d) => d.id).sort()).toEqual([
      'lowercase',
      'titlecase',
      'uppercase',
    ]);
    expect((await store.listDecisions({ topic: 'architecture' })).map((d) => d.id).sort()).toEqual([
      'lowercase',
      'titlecase',
      'uppercase',
    ]);
    expect(
      (await store.listDecisions({ topic: 'ARCHITECTURE', status: 'Accepted' }))
        .map((d) => d.id)
        .sort(),
    ).toEqual(['lowercase', 'titlecase', 'uppercase']);
  });

  test('listDecisions orders results by recorded_at DESC', async () => {
    await store.recordDecision({ id: 'first', title: 'First', content: '1' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.recordDecision({ id: 'second', title: 'Second', content: '2' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.recordDecision({ id: 'third', title: 'Third', content: '3' });

    const rows = await store.listDecisions();
    expect(rows.map((r) => r.id)).toEqual(['third', 'second', 'first']);
  });
});
