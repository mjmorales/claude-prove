/**
 * Tests for the acb topic's unified-store integration.
 *
 * Each test opens a fresh in-memory store so schema-registration and
 * migration paths run end-to-end. Matches the coverage of
 * `tools/acb/test_store.py` and adds unified-store-specific assertions
 * (domain registration, acb_-prefixed table names, migration log).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { listDomains, openStore, runMigrations } from '@claude-prove/store';
import type { AcbStore } from './store';
import { coerceLegacyVerdict, ensureAcbSchemaRegistered, openAcbStore } from './store';

function makeManifest(sha: string): Record<string, unknown> {
  return {
    acb_manifest_version: '0.2',
    commit_sha: sha,
    timestamp: `2026-03-29T12:0${sha}:00Z`,
    intent_groups: [
      {
        id: 'g1',
        title: 'Test',
        classification: 'explicit',
        file_refs: [{ path: 'a.py' }],
        annotations: [],
      },
    ],
  };
}

function makeAcb(): Record<string, unknown> {
  return {
    acb_version: '0.2',
    id: 'test-id',
    change_set_ref: { base_ref: 'abc', head_ref: 'def' },
    intent_groups: [
      {
        id: 'g1',
        title: 'Test',
        classification: 'explicit',
        file_refs: [{ path: 'a.py' }],
      },
    ],
  };
}

function asObj(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`expected plain object, got ${typeof value}`);
  }
  return value as Record<string, unknown>;
}

describe('acb domain registration', () => {
  beforeEach(() => {
    // Other test files call `clearRegistry()` in afterEach; re-register
    // defensively so domain-level assertions stay deterministic in a
    // shared-module-cache bun test run.
    ensureAcbSchemaRegistered();
  });

  test("listDomains() includes 'acb' after module import", () => {
    expect(listDomains()).toContain('acb');
  });

  test('openAcbStore applies migration 1 and creates all 3 acb_ tables', async () => {
    // Use a raw store so we can introspect sqlite_master + _migrations_log
    // without reaching into AcbStore internals. ensureAcbSchemaRegistered
    // guarantees acb is in the registry.
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);

      const tables = (
        await raw.all<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'acb_%' ORDER BY name",
        )
      ).map((r) => r.name);
      expect(tables).toEqual([
        'acb_acb_documents',
        'acb_group_verdicts',
        'acb_manifests',
        'acb_review_state',
      ]);

      const indexes = (
        await raw.all<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_acb_%' ORDER BY name",
        )
      ).map((r) => r.name);
      expect(indexes).toEqual([
        'idx_acb_group_verdicts_slug',
        'idx_acb_manifests_branch',
        'idx_acb_manifests_branch_sha',
        'idx_acb_manifests_run_slug',
      ]);

      const log = await raw.all<{ domain: string; version: number; description: string }>(
        'SELECT domain, version, description FROM _migrations_log WHERE domain = ? ORDER BY version',
        ['acb'],
      );
      expect(log).toEqual([
        {
          domain: 'acb',
          version: 1,
          description: 'create acb_manifests + acb_acb_documents + acb_review_state',
        },
        {
          domain: 'acb',
          version: 2,
          description: 'create acb_group_verdicts (absorb review-ui group_verdicts)',
        },
        {
          domain: 'acb',
          version: 3,
          description: 'normalize acb_group_verdicts.verdict to canonical VerdictValue vocabulary',
        },
      ]);
    } finally {
      raw.close();
    }
  });

  test('manifest column shape matches spec', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);
      const cols = (
        await raw.all<{ name: string; type: string; notnull: number }>(
          "SELECT name, type, [notnull] FROM pragma_table_info('acb_manifests') ORDER BY cid",
        )
      ).map((c) => `${c.name}:${c.type}:${c.notnull}`);
      expect(cols).toEqual([
        'id:INTEGER:0',
        'branch:TEXT:1',
        'commit_sha:TEXT:1',
        'timestamp:TEXT:1',
        'data:TEXT:1',
        'created_at:TEXT:1',
        'run_slug:TEXT:0',
      ]);
    } finally {
      raw.close();
    }
  });

  test('migration is idempotent — rerunning does not duplicate log rows', async () => {
    // Open with raw store so we can re-run migrations explicitly and
    // observe that the second pass is a no-op (applied is empty, log
    // has a single row per version).
    const raw = await openStore({ path: ':memory:' });
    try {
      const first = await runMigrations(raw);
      const firstAcb = first.applied.filter((a) => a.domain === 'acb');
      expect(firstAcb.map((a) => a.version)).toEqual([1, 2, 3]);

      const second = await runMigrations(raw);
      expect(second.applied.filter((a) => a.domain === 'acb')).toEqual([]);

      const versions = await raw.all<{ version: number }>(
        'SELECT version FROM _migrations_log WHERE domain = ? ORDER BY version',
        ['acb'],
      );
      expect(versions).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
    } finally {
      raw.close();
    }
  });

  test('v2 backfills rows from a legacy bare group_verdicts table', async () => {
    // Simulate a .prove/prove.db created by an older review-ui server: v1
    // migration already applied, then the legacy `ensureVerdictTable`
    // path created a bare `group_verdicts` table outside the registry.
    const raw = await openStore({ path: ':memory:' });
    try {
      await raw.exec(`
        CREATE TABLE _migrations_log (
          domain TEXT NOT NULL,
          version INTEGER NOT NULL,
          description TEXT NOT NULL,
          applied_at TEXT NOT NULL,
          PRIMARY KEY (domain, version)
        );
        INSERT INTO _migrations_log (domain, version, description, applied_at)
          VALUES ('acb', 1, 'create acb_manifests + acb_acb_documents + acb_review_state', '2026-01-01T00:00:00Z');
      `);
      // Apply v1 table DDL manually so the pre-state is realistic.
      await raw.exec(`
        CREATE TABLE acb_manifests (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          branch TEXT NOT NULL,
          commit_sha TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          data TEXT NOT NULL,
          created_at TEXT NOT NULL,
          run_slug TEXT
        );
        CREATE TABLE acb_acb_documents (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          branch TEXT NOT NULL UNIQUE,
          data TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE acb_review_state (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          branch TEXT NOT NULL UNIQUE,
          acb_hash TEXT NOT NULL,
          data TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE group_verdicts (
          slug TEXT NOT NULL,
          group_id TEXT NOT NULL,
          verdict TEXT NOT NULL,
          note TEXT,
          fix_prompt TEXT,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (slug, group_id)
        );
        INSERT INTO group_verdicts (slug, group_id, verdict, note, fix_prompt, updated_at)
          VALUES ('my-slug', 'g1', 'approved', 'lgtm', NULL, '2026-01-01T00:00:00Z'),
                 ('my-slug', 'g2', 'rework', 'needs tests', 'Do X', '2026-01-02T00:00:00Z');
      `);

      // Now run the pending migrations (v2 backfill + v3 verdict normalization).
      const result = await runMigrations(raw);
      expect(result.applied.filter((a) => a.domain === 'acb').map((a) => a.version)).toEqual([
        2, 3,
      ]);

      // Legacy table gone, new table carries the rows — with v3 normalizing
      // the legacy `'approved'` string to the canonical `'accepted'`.
      const legacyExists = await raw.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'group_verdicts'",
      );
      expect(legacyExists).toHaveLength(0);

      const rows = await raw.all<{
        slug: string;
        group_id: string;
        verdict: string;
        note: string | null;
        fix_prompt: string | null;
        updated_at: string;
      }>(
        'SELECT slug, group_id, verdict, note, fix_prompt, updated_at FROM acb_group_verdicts ORDER BY group_id',
      );
      expect(rows).toEqual([
        {
          slug: 'my-slug',
          group_id: 'g1',
          verdict: 'accepted',
          note: 'lgtm',
          fix_prompt: null,
          updated_at: '2026-01-01T00:00:00Z',
        },
        {
          slug: 'my-slug',
          group_id: 'g2',
          verdict: 'rework',
          note: 'needs tests',
          fix_prompt: 'Do X',
          updated_at: '2026-01-02T00:00:00Z',
        },
      ]);
    } finally {
      raw.close();
    }
  });

  test('v2 on a fresh db (no legacy table) succeeds without error', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);
      const tables = (
        await raw.all<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'acb_group_verdicts'",
        )
      ).map((r) => r.name);
      expect(tables).toEqual(['acb_group_verdicts']);
    } finally {
      raw.close();
    }
  });
});

describe('AcbStore: group verdicts', () => {
  let store: AcbStore;

  beforeEach(async () => {
    store = await openAcbStore({ path: ':memory:' });
  });
  afterEach(() => {
    store.close();
  });

  test('listGroupVerdicts on empty slug returns []', async () => {
    expect(await store.listGroupVerdicts('my-slug')).toEqual([]);
  });

  test('upsertGroupVerdict insert round-trips through listGroupVerdicts', async () => {
    const rec = await store.upsertGroupVerdict('my-slug', 'g1', 'accepted', 'lgtm', null);
    expect(rec.slug).toBe('my-slug');
    expect(rec.groupId).toBe('g1');
    expect(rec.verdict).toBe('accepted');
    expect(rec.note).toBe('lgtm');
    expect(rec.fixPrompt).toBeNull();
    expect(typeof rec.updatedAt).toBe('string');

    const rows = await store.listGroupVerdicts('my-slug');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(rec);
  });

  test('upsertGroupVerdict updates on conflict (slug, groupId)', async () => {
    await store.upsertGroupVerdict('my-slug', 'g1', 'accepted', 'lgtm', null);
    const updated = await store.upsertGroupVerdict(
      'my-slug',
      'g1',
      'rework',
      'nit: add tests',
      'Please add unit tests',
    );
    expect(updated.verdict).toBe('rework');
    expect(updated.fixPrompt).toBe('Please add unit tests');

    const rows = await store.listGroupVerdicts('my-slug');
    expect(rows).toHaveLength(1);
    expect(rows[0].verdict).toBe('rework');
  });

  test('clearGroupVerdict deletes the row; no-op when absent', async () => {
    await store.upsertGroupVerdict('my-slug', 'g1', 'accepted', null, null);
    await store.clearGroupVerdict('my-slug', 'g1');
    expect(await store.listGroupVerdicts('my-slug')).toEqual([]);
    // Idempotent: second clear throws nothing.
    await store.clearGroupVerdict('my-slug', 'g1');
  });

  test('listGroupVerdicts is slug-scoped', async () => {
    await store.upsertGroupVerdict('slug-a', 'g1', 'accepted', null, null);
    await store.upsertGroupVerdict('slug-b', 'g1', 'rejected', null, null);
    const rowsA = await store.listGroupVerdicts('slug-a');
    expect(rowsA).toHaveLength(1);
    expect(rowsA[0].verdict).toBe('accepted');
  });
});

describe('coerceLegacyVerdict', () => {
  test('remaps legacy aliases to canonical values', () => {
    expect(coerceLegacyVerdict('approved')).toBe('accepted');
    expect(coerceLegacyVerdict('discuss')).toBe('needs_discussion');
  });

  test('passes canonical values through unchanged', () => {
    for (const v of ['accepted', 'rejected', 'needs_discussion', 'pending', 'rework'] as const) {
      expect(coerceLegacyVerdict(v)).toBe(v);
    }
  });

  test('coerces unknown/corrupt values to the pending fallback, not through', () => {
    expect(coerceLegacyVerdict('totally-bogus')).toBe('pending');
    expect(coerceLegacyVerdict('')).toBe('pending');
  });
});

describe('AcbStore: manifests', () => {
  let store: AcbStore;

  beforeEach(async () => {
    store = await openAcbStore({ path: ':memory:' });
  });
  afterEach(() => {
    store.close();
  });

  test('saveManifest returns a positive row id and hasManifest flips to true', async () => {
    expect(await store.hasManifest('feat/x')).toBe(false);
    const id = await store.saveManifest('feat/x', 'abc', makeManifest('0'));
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);
    expect(await store.hasManifest('feat/x')).toBe(true);
  });

  test('saveManifest returns incrementing row ids across inserts', async () => {
    const id1 = await store.saveManifest('feat/x', 'abc', makeManifest('0'));
    const id2 = await store.saveManifest('feat/x', 'def', makeManifest('1'));
    expect(id2).toBeGreaterThan(id1);
  });

  test('branch isolation: saving feat/x does not expose feat/y', async () => {
    await store.saveManifest('feat/x', 'abc', makeManifest('0'));
    expect(await store.hasManifest('feat/y')).toBe(false);
    expect(await store.listManifests('feat/y')).toEqual([]);
  });

  test('listManifests orders by timestamp ASC (not insertion order)', async () => {
    await store.saveManifest('feat/x', 'sha2', makeManifest('2'));
    await store.saveManifest('feat/x', 'sha1', makeManifest('1'));
    const manifests = await store.listManifests('feat/x');
    expect(manifests).toHaveLength(2);
    expect(asObj(manifests[0]).commit_sha).toBe('1');
    expect(asObj(manifests[1]).commit_sha).toBe('2');
  });

  test('listManifests round-trips the stored data object', async () => {
    const original = makeManifest('0');
    await store.saveManifest('feat/x', 'abc', original);
    const [loaded] = await store.listManifests('feat/x');
    expect(loaded).toEqual(original);
  });

  test('clearManifests returns the number of deleted rows', async () => {
    await store.saveManifest('feat/x', 'abc', makeManifest('0'));
    await store.saveManifest('feat/x', 'def', makeManifest('1'));
    const count = await store.clearManifests('feat/x');
    expect(count).toBe(2);
    expect(await store.hasManifest('feat/x')).toBe(false);
  });

  test('clearManifests on empty branch returns 0', async () => {
    expect(await store.clearManifests('never-existed')).toBe(0);
  });

  test('clearStaleManifests deletes branch != keepBranch (regression pin)', async () => {
    await store.saveManifest('feat/x', 'abc', makeManifest('0'));
    await store.saveManifest('feat/old', 'def', makeManifest('1'));
    await store.saveManifest('feat/older', 'ghi', makeManifest('2'));
    const count = await store.clearStaleManifests('feat/x');
    expect(count).toBe(2);
    expect(await store.hasManifest('feat/x')).toBe(true);
    expect(await store.hasManifest('feat/old')).toBe(false);
    expect(await store.hasManifest('feat/older')).toBe(false);
  });

  test('clearStaleManifests with only keepBranch rows deletes nothing', async () => {
    await store.saveManifest('feat/x', 'abc', makeManifest('0'));
    await store.saveManifest('feat/x', 'def', makeManifest('1'));
    expect(await store.clearStaleManifests('feat/x')).toBe(0);
    expect(await store.listManifests('feat/x')).toHaveLength(2);
  });
});

describe('AcbStore: acb documents', () => {
  let store: AcbStore;

  beforeEach(async () => {
    store = await openAcbStore({ path: ':memory:' });
  });
  afterEach(() => {
    store.close();
  });

  test('saveAcb + loadAcb round-trip the document', async () => {
    await store.saveAcb('feat/x', makeAcb());
    const loaded = await store.loadAcb('feat/x');
    expect(loaded).not.toBeNull();
    expect(asObj(loaded).id).toBe('test-id');
  });

  test('loadAcb returns null for missing branch', async () => {
    expect(await store.loadAcb('feat/x')).toBeNull();
  });

  test('saveAcb upserts — second call overwrites data', async () => {
    await store.saveAcb('feat/x', { id: 'v1' });
    await store.saveAcb('feat/x', { id: 'v2' });
    const loaded = await store.loadAcb('feat/x');
    expect(asObj(loaded).id).toBe('v2');
  });

  test('latestAcbBranch returns the most-recently updated branch', async () => {
    await store.saveAcb('feat/old', { id: 'old' });
    // Date.prototype.toISOString has ms resolution, so back-to-back
    // saveAcb calls can collide on updated_at. Wait a tick to guarantee
    // strict ordering — matches the Python reference's test intent.
    await new Promise((resolve) => setTimeout(resolve, 2));
    await store.saveAcb('feat/new', { id: 'new' });
    expect(await store.latestAcbBranch()).toBe('feat/new');
  });

  test('latestAcbBranch returns null on empty table', async () => {
    expect(await store.latestAcbBranch()).toBeNull();
  });

  test('saveAcb twice on the same branch keeps a single row', async () => {
    await store.saveAcb('feat/x', { id: 'v1' });
    await store.saveAcb('feat/x', { id: 'v2' });
    expect(await store.branches()).toEqual(['feat/x']);
  });
});

describe('AcbStore: review state', () => {
  let store: AcbStore;

  beforeEach(async () => {
    store = await openAcbStore({ path: ':memory:' });
  });
  afterEach(() => {
    store.close();
  });

  test('saveReview + loadReview round-trip the document', async () => {
    const review = { overall_verdict: 'pending', group_verdicts: [] };
    await store.saveReview('feat/x', 'hash123', review);
    const loaded = await store.loadReview('feat/x');
    expect(loaded).not.toBeNull();
    expect(asObj(loaded).overall_verdict).toBe('pending');
  });

  test('loadReview returns null for missing branch', async () => {
    expect(await store.loadReview('feat/x')).toBeNull();
  });

  test('saveReview upserts — second call replaces verdict + hash', async () => {
    await store.saveReview('feat/x', 'h1', { overall_verdict: 'pending' });
    await store.saveReview('feat/x', 'h2', { overall_verdict: 'approved' });
    const loaded = await store.loadReview('feat/x');
    expect(asObj(loaded).overall_verdict).toBe('approved');
  });
});

describe('AcbStore: cleanBranch + branches', () => {
  let store: AcbStore;

  beforeEach(async () => {
    store = await openAcbStore({ path: ':memory:' });
  });
  afterEach(() => {
    store.close();
  });

  test('cleanBranch removes rows across all three acb_ tables', async () => {
    await store.saveManifest('feat/x', 'abc', makeManifest('0'));
    await store.saveAcb('feat/x', makeAcb());
    await store.saveReview('feat/x', 'h', { verdict: 'pending' });
    const counts = await store.cleanBranch('feat/x');
    expect(counts.acb_manifests).toBe(1);
    expect(counts.acb_acb_documents).toBe(1);
    expect(counts.acb_review_state).toBe(1);
    expect(await store.hasManifest('feat/x')).toBe(false);
    expect(await store.loadAcb('feat/x')).toBeNull();
    expect(await store.loadReview('feat/x')).toBeNull();
  });

  test('cleanBranch returns acb_-prefixed keys (NOT Python bare names)', async () => {
    await store.saveManifest('feat/x', 'abc', makeManifest('0'));
    const counts = await store.cleanBranch('feat/x');
    const keys = Object.keys(counts).sort();
    expect(keys).toEqual(['acb_acb_documents', 'acb_manifests', 'acb_review_state']);
    // Regression: ensure we did not accidentally carry over the Python names.
    expect(keys).not.toContain('manifests');
    expect(keys).not.toContain('acb_documents');
    expect(keys).not.toContain('review_state');
  });

  test('cleanBranch on empty branch returns zero counts', async () => {
    const counts = await store.cleanBranch('never-existed');
    expect(counts).toEqual({ acb_manifests: 0, acb_acb_documents: 0, acb_review_state: 0 });
  });

  test('branches() returns sorted unique branch names across all three tables', async () => {
    await store.saveManifest('feat/a', 'abc', makeManifest('0'));
    await store.saveAcb('feat/b', makeAcb());
    await store.saveReview('feat/c', 'h', { verdict: 'pending' });
    expect(await store.branches()).toEqual(['feat/a', 'feat/b', 'feat/c']);
  });

  test('branches() deduplicates when a branch has rows in multiple tables', async () => {
    await store.saveManifest('feat/x', 'abc', makeManifest('0'));
    await store.saveAcb('feat/x', makeAcb());
    await store.saveReview('feat/x', 'h', { verdict: 'pending' });
    expect(await store.branches()).toEqual(['feat/x']);
  });

  test('branches() on empty db returns empty array', async () => {
    expect(await store.branches()).toEqual([]);
  });
});

describe('AcbStore: run_slug semantics', () => {
  let store: AcbStore;

  beforeEach(async () => {
    store = await openAcbStore({ path: ':memory:' });
  });
  afterEach(() => {
    store.close();
  });

  test('saveManifest with slug round-trips through listManifestsByRun', async () => {
    await store.saveManifest('feat/x', 'abc123', makeManifest('0'), 'run-1');
    const rows = await store.listManifestsByRun('run-1');
    expect(rows).toHaveLength(1);
    expect(asObj(rows[0]).commit_sha).toBe('0');
  });

  test('listManifestsByRun is slug-scoped', async () => {
    await store.saveManifest('feat/x', 'aaa', makeManifest('1'), 'run-A');
    await store.saveManifest('feat/y', 'bbb', makeManifest('2'), 'run-B');
    await store.saveManifest('feat/z', 'ccc', makeManifest('3'));
    expect(await store.listManifestsByRun('run-A')).toHaveLength(1);
    expect(await store.listManifestsByRun('run-B')).toHaveLength(1);
    expect(await store.listManifestsByRun('run-Z')).toHaveLength(0);
  });

  test('listManifestsByRun orders by timestamp ASC', async () => {
    await store.saveManifest('feat/x', 'a', makeManifest('3'), 'run-1');
    await store.saveManifest('feat/x', 'b', makeManifest('1'), 'run-1');
    await store.saveManifest('feat/x', 'c', makeManifest('2'), 'run-1');
    const rows = await store.listManifestsByRun('run-1');
    expect(rows.map((r) => asObj(r).commit_sha)).toEqual(['1', '2', '3']);
  });

  test('hasManifestForSha matches full SHA and prefix alike', async () => {
    await store.saveManifest('feat/x', 'deadbeef', makeManifest('0'), 'run-1');
    expect(await store.hasManifestForSha('deadbeef')).toBe(true);
    expect(await store.hasManifestForSha('dead')).toBe(true);
    expect(await store.hasManifestForSha('deadbeef', 'run-1')).toBe(true);
    expect(await store.hasManifestForSha('deadbeef', 'run-2')).toBe(false);
  });

  test('hasManifestForSha with run_slug filter excludes NULL-slug rows', async () => {
    await store.saveManifest('feat/x', 'aaa', makeManifest('0'));
    expect(await store.hasManifestForSha('aaa')).toBe(true);
    expect(await store.hasManifestForSha('aaa', 'run-1')).toBe(false);
  });

  test('hasManifestForSha returns false for unknown SHA', async () => {
    expect(await store.hasManifestForSha('ffff')).toBe(false);
  });
});
