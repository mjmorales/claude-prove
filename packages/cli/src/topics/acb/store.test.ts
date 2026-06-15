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

/** Read array element `i`, asserting it exists (noUncheckedIndexedAccess). */
function at<T>(arr: T[], i: number): T {
  const value = arr[i];
  if (value === undefined) throw new Error(`at: no element at index ${i}`);
  return value;
}

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

  test('openAcbStore applies the single v1 migration and creates all 4 acb_ tables + 3 head views', async () => {
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

      // Each contended document is an append-only revision log read through a
      // head view; assert all three heads exist.
      const views = (
        await raw.all<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'view' AND name LIKE 'acb_%' ORDER BY name",
        )
      ).map((r) => r.name);
      expect(views).toEqual([
        'acb_acb_documents_head',
        'acb_group_verdicts_head',
        'acb_review_state_head',
      ]);

      const indexes = (
        await raw.all<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_acb_%' ORDER BY name",
        )
      ).map((r) => r.name);
      expect(indexes).toEqual([
        'idx_acb_acb_documents_branch',
        'idx_acb_group_verdicts_key',
        'idx_acb_group_verdicts_slug',
        'idx_acb_manifests_branch',
        'idx_acb_manifests_branch_sha',
        'idx_acb_manifests_run_slug',
        'idx_acb_review_state_branch',
      ]);

      const log = await raw.all<{ domain: string; version: number; description: string }>(
        'SELECT domain, version, description FROM _migrations_log WHERE domain = ? ORDER BY version',
        ['acb'],
      );
      expect(log).toHaveLength(1);
      expect(log[0]?.domain).toBe('acb');
      expect(log[0]?.version).toBe(1);
      expect(log[0]?.description).toContain('acb schema');
    } finally {
      raw.close();
    }
  });

  test('manifest column shape matches the v1 spec — id is TEXT (a ULID), no rowid', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);
      const cols = (
        await raw.all<{ name: string; type: string; notnull: number }>(
          "SELECT name, type, [notnull] FROM pragma_table_info('acb_manifests') ORDER BY cid",
        )
      ).map((c) => `${c.name}:${c.type}:${c.notnull}`);
      expect(cols).toEqual([
        'id:TEXT:0',
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

  test('no acb_* table is AUTOINCREMENT — the v1 DDL carries no rowid alias', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      await runMigrations(raw);
      // sqlite_sequence materializes only for an AUTOINCREMENT column; insert
      // across every formerly-AUTOINCREMENT table and assert it never appears.
      await raw.exec(`
        INSERT INTO acb_manifests (id, branch, commit_sha, timestamp, data, created_at) VALUES ('m1', 'b', 'sha', 't', '{}', 't');
        INSERT INTO acb_acb_documents (id, branch, data, created_at) VALUES ('d1', 'b', '{}', 't');
        INSERT INTO acb_review_state (id, branch, acb_hash, data, created_at) VALUES ('r1', 'b', 'h', '{}', 't');
        INSERT INTO acb_group_verdicts (id, slug, group_id, verdict, created_at) VALUES ('v1', 's', 'g', 'pending', 't');
      `);
      const seq = await raw.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'",
      );
      expect(seq).toEqual([]);
    } finally {
      raw.close();
    }
  });

  test('migration is idempotent — rerunning does not duplicate the v1 log row', async () => {
    const raw = await openStore({ path: ':memory:' });
    try {
      const first = await runMigrations(raw);
      expect(first.applied.filter((a) => a.domain === 'acb').map((a) => a.version)).toEqual([1]);

      const second = await runMigrations(raw);
      expect(second.applied.filter((a) => a.domain === 'acb')).toEqual([]);

      const versions = await raw.all<{ version: number }>(
        'SELECT version FROM _migrations_log WHERE domain = ? ORDER BY version',
        ['acb'],
      );
      expect(versions).toEqual([{ version: 1 }]);
    } finally {
      raw.close();
    }
  });

  test('group_verdicts canonicalizes a legacy verdict at the READ boundary', async () => {
    // The clean v1 schema drops the in-chain verdict-normalization migration;
    // canonicalization moves entirely to the read path (coerceLegacyVerdict).
    // A hand-edited legacy 'approved' string still reads back as 'accepted'.
    const store = await openAcbStore({ path: ':memory:' });
    try {
      await store
        .getStore()
        .run(
          "INSERT INTO acb_group_verdicts (id, slug, group_id, verdict, note, fix_prompt, created_at) VALUES ('01HEAD000000000000000000V1', 'my-slug', 'g1', 'approved', 'lgtm', NULL, '2026-01-01T00:00:00Z')",
        );
      const rows = await store.listGroupVerdicts('my-slug');
      expect(rows).toEqual([
        {
          slug: 'my-slug',
          groupId: 'g1',
          verdict: 'accepted',
          note: 'lgtm',
          fixPrompt: null,
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ]);
    } finally {
      store.close();
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

  test('a second verdict on the same (slug, groupId) appends a revision; the head returns the latest', async () => {
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

    // The head view collapses the two revisions to the latest one.
    const rows = await store.listGroupVerdicts('my-slug');
    expect(rows).toHaveLength(1);
    expect(at(rows, 0).verdict).toBe('rework');

    // The prior revision is retained in the append-only base table — nothing
    // was overwritten, so both ULID-keyed rows survive.
    const all = await store
      .getStore()
      .all<{ n: number }>(
        'SELECT COUNT(*) AS n FROM acb_group_verdicts WHERE slug = ? AND group_id = ?',
        ['my-slug', 'g1'],
      );
    expect(all[0]?.n).toBe(2);
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
    expect(at(rowsA, 0).verdict).toBe('accepted');
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

  test('saveManifest returns a ULID id and hasManifest flips to true', async () => {
    expect(await store.hasManifest('feat/x')).toBe(false);
    const id = await store.saveManifest('feat/x', 'abc', makeManifest('0'));
    expect(typeof id).toBe('string');
    expect(id).toHaveLength(26);
    expect(await store.hasManifest('feat/x')).toBe(true);
  });

  test('saveManifest returns monotonically-ascending ULID ids across inserts', async () => {
    const id1 = await store.saveManifest('feat/x', 'abc', makeManifest('0'));
    const id2 = await store.saveManifest('feat/x', 'def', makeManifest('1'));
    // ULIDs are time-ordered + monotonic within a process: lexicographic order
    // tracks insert order, the property `listManifests` ordering relies on.
    expect(id2 > id1).toBe(true);
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

  test('saveAcb appends a revision — loadAcb returns the latest via the head view', async () => {
    await store.saveAcb('feat/x', { id: 'v1' });
    await store.saveAcb('feat/x', { id: 'v2' });
    const loaded = await store.loadAcb('feat/x');
    expect(asObj(loaded).id).toBe('v2');
  });

  test('saveAcb twice on the same branch retains both revisions in the base table', async () => {
    await store.saveAcb('feat/x', { id: 'v1' });
    await store.saveAcb('feat/x', { id: 'v2' });
    const rows = await store
      .getStore()
      .all<{ n: number }>('SELECT COUNT(*) AS n FROM acb_acb_documents WHERE branch = ?', [
        'feat/x',
      ]);
    expect(rows[0]?.n).toBe(2);
  });

  test('latestAcbBranch returns the branch whose head revision was written most recently', async () => {
    await store.saveAcb('feat/old', { id: 'old' });
    // Date.prototype.toISOString has ms resolution, but the head view orders by
    // the ULID id (monotonic within a process), so back-to-back appends still
    // order deterministically. The tick keeps created_at human-distinct too.
    await new Promise((resolve) => setTimeout(resolve, 2));
    await store.saveAcb('feat/new', { id: 'new' });
    expect(await store.latestAcbBranch()).toBe('feat/new');
  });

  test('latestAcbBranch returns null on empty table', async () => {
    expect(await store.latestAcbBranch()).toBeNull();
  });

  test('saveAcb twice on the same branch keeps a single head branch', async () => {
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

  test('saveReview appends a revision — loadReview returns the latest via the head view', async () => {
    await store.saveReview('feat/x', 'h1', { overall_verdict: 'pending' });
    await store.saveReview('feat/x', 'h2', { overall_verdict: 'approved' });
    const loaded = await store.loadReview('feat/x');
    expect(asObj(loaded).overall_verdict).toBe('approved');

    // Both revisions persist in the append-only base table.
    const rows = await store
      .getStore()
      .all<{ n: number }>('SELECT COUNT(*) AS n FROM acb_review_state WHERE branch = ?', [
        'feat/x',
      ]);
    expect(rows[0]?.n).toBe(2);
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
