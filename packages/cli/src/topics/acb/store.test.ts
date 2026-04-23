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
import { ensureAcbSchemaRegistered, openAcbStore } from './store';

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

  test('openAcbStore applies migration 1 and creates all 3 acb_ tables', () => {
    // Use a raw store so we can introspect sqlite_master + _migrations_log
    // without reaching into AcbStore internals. ensureAcbSchemaRegistered
    // guarantees acb is in the registry.
    const raw = openStore({ path: ':memory:' });
    try {
      runMigrations(raw);

      const tables = raw
        .all<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'acb_%' ORDER BY name",
        )
        .map((r) => r.name);
      expect(tables).toEqual(['acb_acb_documents', 'acb_manifests', 'acb_review_state']);

      const indexes = raw
        .all<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_acb_%' ORDER BY name",
        )
        .map((r) => r.name);
      expect(indexes).toEqual([
        'idx_acb_manifests_branch',
        'idx_acb_manifests_branch_sha',
        'idx_acb_manifests_run_slug',
      ]);

      const log = raw.all<{ domain: string; version: number; description: string }>(
        'SELECT domain, version, description FROM _migrations_log WHERE domain = ?',
        ['acb'],
      );
      expect(log).toEqual([
        {
          domain: 'acb',
          version: 1,
          description: 'create acb_manifests + acb_acb_documents + acb_review_state',
        },
      ]);
    } finally {
      raw.close();
    }
  });

  test('manifest column shape matches spec', () => {
    const raw = openStore({ path: ':memory:' });
    try {
      runMigrations(raw);
      const cols = raw
        .all<{ name: string; type: string; notnull: number }>(
          "SELECT name, type, [notnull] FROM pragma_table_info('acb_manifests') ORDER BY cid",
        )
        .map((c) => `${c.name}:${c.type}:${c.notnull}`);
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

  test('migration is idempotent — rerunning does not duplicate log rows', () => {
    // Open with raw store so we can re-run migrations explicitly and
    // observe that the second pass is a no-op (applied is empty, log
    // has a single acb/v1 row).
    const raw = openStore({ path: ':memory:' });
    try {
      const first = runMigrations(raw);
      const firstAcb = first.applied.filter((a) => a.domain === 'acb');
      expect(firstAcb.map((a) => a.version)).toEqual([1]);

      const second = runMigrations(raw);
      expect(second.applied.filter((a) => a.domain === 'acb')).toEqual([]);

      const versions = raw.all<{ version: number }>(
        'SELECT version FROM _migrations_log WHERE domain = ? ORDER BY version',
        ['acb'],
      );
      expect(versions).toEqual([{ version: 1 }]);
    } finally {
      raw.close();
    }
  });
});

describe('AcbStore: manifests', () => {
  let store: AcbStore;

  beforeEach(() => {
    store = openAcbStore({ path: ':memory:' });
  });
  afterEach(() => {
    store.close();
  });

  test('saveManifest returns a positive row id and hasManifest flips to true', () => {
    expect(store.hasManifest('feat/x')).toBe(false);
    const id = store.saveManifest('feat/x', 'abc', makeManifest('0'));
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);
    expect(store.hasManifest('feat/x')).toBe(true);
  });

  test('saveManifest returns incrementing row ids across inserts', () => {
    const id1 = store.saveManifest('feat/x', 'abc', makeManifest('0'));
    const id2 = store.saveManifest('feat/x', 'def', makeManifest('1'));
    expect(id2).toBeGreaterThan(id1);
  });

  test('branch isolation: saving feat/x does not expose feat/y', () => {
    store.saveManifest('feat/x', 'abc', makeManifest('0'));
    expect(store.hasManifest('feat/y')).toBe(false);
    expect(store.listManifests('feat/y')).toEqual([]);
  });

  test('listManifests orders by timestamp ASC (not insertion order)', () => {
    store.saveManifest('feat/x', 'sha2', makeManifest('2'));
    store.saveManifest('feat/x', 'sha1', makeManifest('1'));
    const manifests = store.listManifests('feat/x');
    expect(manifests).toHaveLength(2);
    expect(asObj(manifests[0]).commit_sha).toBe('1');
    expect(asObj(manifests[1]).commit_sha).toBe('2');
  });

  test('listManifests round-trips the stored data object', () => {
    const original = makeManifest('0');
    store.saveManifest('feat/x', 'abc', original);
    const [loaded] = store.listManifests('feat/x');
    expect(loaded).toEqual(original);
  });

  test('clearManifests returns the number of deleted rows', () => {
    store.saveManifest('feat/x', 'abc', makeManifest('0'));
    store.saveManifest('feat/x', 'def', makeManifest('1'));
    const count = store.clearManifests('feat/x');
    expect(count).toBe(2);
    expect(store.hasManifest('feat/x')).toBe(false);
  });

  test('clearManifests on empty branch returns 0', () => {
    expect(store.clearManifests('never-existed')).toBe(0);
  });

  test('clearStaleManifests deletes branch != keepBranch (regression pin)', () => {
    store.saveManifest('feat/x', 'abc', makeManifest('0'));
    store.saveManifest('feat/old', 'def', makeManifest('1'));
    store.saveManifest('feat/older', 'ghi', makeManifest('2'));
    const count = store.clearStaleManifests('feat/x');
    expect(count).toBe(2);
    expect(store.hasManifest('feat/x')).toBe(true);
    expect(store.hasManifest('feat/old')).toBe(false);
    expect(store.hasManifest('feat/older')).toBe(false);
  });

  test('clearStaleManifests with only keepBranch rows deletes nothing', () => {
    store.saveManifest('feat/x', 'abc', makeManifest('0'));
    store.saveManifest('feat/x', 'def', makeManifest('1'));
    expect(store.clearStaleManifests('feat/x')).toBe(0);
    expect(store.listManifests('feat/x')).toHaveLength(2);
  });
});

describe('AcbStore: acb documents', () => {
  let store: AcbStore;

  beforeEach(() => {
    store = openAcbStore({ path: ':memory:' });
  });
  afterEach(() => {
    store.close();
  });

  test('saveAcb + loadAcb round-trip the document', () => {
    store.saveAcb('feat/x', makeAcb());
    const loaded = store.loadAcb('feat/x');
    expect(loaded).not.toBeNull();
    expect(asObj(loaded).id).toBe('test-id');
  });

  test('loadAcb returns null for missing branch', () => {
    expect(store.loadAcb('feat/x')).toBeNull();
  });

  test('saveAcb upserts — second call overwrites data', () => {
    store.saveAcb('feat/x', { id: 'v1' });
    store.saveAcb('feat/x', { id: 'v2' });
    const loaded = store.loadAcb('feat/x');
    expect(asObj(loaded).id).toBe('v2');
  });

  test('latestAcbBranch returns the most-recently updated branch', async () => {
    store.saveAcb('feat/old', { id: 'old' });
    // Date.prototype.toISOString has ms resolution, so back-to-back
    // saveAcb calls can collide on updated_at. Wait a tick to guarantee
    // strict ordering — matches the Python reference's test intent.
    await new Promise((resolve) => setTimeout(resolve, 2));
    store.saveAcb('feat/new', { id: 'new' });
    expect(store.latestAcbBranch()).toBe('feat/new');
  });

  test('latestAcbBranch returns null on empty table', () => {
    expect(store.latestAcbBranch()).toBeNull();
  });

  test('saveAcb twice on the same branch keeps a single row', () => {
    store.saveAcb('feat/x', { id: 'v1' });
    store.saveAcb('feat/x', { id: 'v2' });
    expect(store.branches()).toEqual(['feat/x']);
  });
});

describe('AcbStore: review state', () => {
  let store: AcbStore;

  beforeEach(() => {
    store = openAcbStore({ path: ':memory:' });
  });
  afterEach(() => {
    store.close();
  });

  test('saveReview + loadReview round-trip the document', () => {
    const review = { overall_verdict: 'pending', group_verdicts: [] };
    store.saveReview('feat/x', 'hash123', review);
    const loaded = store.loadReview('feat/x');
    expect(loaded).not.toBeNull();
    expect(asObj(loaded).overall_verdict).toBe('pending');
  });

  test('loadReview returns null for missing branch', () => {
    expect(store.loadReview('feat/x')).toBeNull();
  });

  test('saveReview upserts — second call replaces verdict + hash', () => {
    store.saveReview('feat/x', 'h1', { overall_verdict: 'pending' });
    store.saveReview('feat/x', 'h2', { overall_verdict: 'approved' });
    const loaded = store.loadReview('feat/x');
    expect(asObj(loaded).overall_verdict).toBe('approved');
  });
});

describe('AcbStore: cleanBranch + branches', () => {
  let store: AcbStore;

  beforeEach(() => {
    store = openAcbStore({ path: ':memory:' });
  });
  afterEach(() => {
    store.close();
  });

  test('cleanBranch removes rows across all three acb_ tables', () => {
    store.saveManifest('feat/x', 'abc', makeManifest('0'));
    store.saveAcb('feat/x', makeAcb());
    store.saveReview('feat/x', 'h', { verdict: 'pending' });
    const counts = store.cleanBranch('feat/x');
    expect(counts.acb_manifests).toBe(1);
    expect(counts.acb_acb_documents).toBe(1);
    expect(counts.acb_review_state).toBe(1);
    expect(store.hasManifest('feat/x')).toBe(false);
    expect(store.loadAcb('feat/x')).toBeNull();
    expect(store.loadReview('feat/x')).toBeNull();
  });

  test('cleanBranch returns acb_-prefixed keys (NOT Python bare names)', () => {
    store.saveManifest('feat/x', 'abc', makeManifest('0'));
    const counts = store.cleanBranch('feat/x');
    const keys = Object.keys(counts).sort();
    expect(keys).toEqual(['acb_acb_documents', 'acb_manifests', 'acb_review_state']);
    // Regression: ensure we did not accidentally carry over the Python names.
    expect(keys).not.toContain('manifests');
    expect(keys).not.toContain('acb_documents');
    expect(keys).not.toContain('review_state');
  });

  test('cleanBranch on empty branch returns zero counts', () => {
    const counts = store.cleanBranch('never-existed');
    expect(counts).toEqual({ acb_manifests: 0, acb_acb_documents: 0, acb_review_state: 0 });
  });

  test('branches() returns sorted unique branch names across all three tables', () => {
    store.saveManifest('feat/a', 'abc', makeManifest('0'));
    store.saveAcb('feat/b', makeAcb());
    store.saveReview('feat/c', 'h', { verdict: 'pending' });
    expect(store.branches()).toEqual(['feat/a', 'feat/b', 'feat/c']);
  });

  test('branches() deduplicates when a branch has rows in multiple tables', () => {
    store.saveManifest('feat/x', 'abc', makeManifest('0'));
    store.saveAcb('feat/x', makeAcb());
    store.saveReview('feat/x', 'h', { verdict: 'pending' });
    expect(store.branches()).toEqual(['feat/x']);
  });

  test('branches() on empty db returns empty array', () => {
    expect(store.branches()).toEqual([]);
  });
});

describe('AcbStore: run_slug semantics', () => {
  let store: AcbStore;

  beforeEach(() => {
    store = openAcbStore({ path: ':memory:' });
  });
  afterEach(() => {
    store.close();
  });

  test('saveManifest with slug round-trips through listManifestsByRun', () => {
    store.saveManifest('feat/x', 'abc123', makeManifest('0'), 'run-1');
    const rows = store.listManifestsByRun('run-1');
    expect(rows).toHaveLength(1);
    expect(asObj(rows[0]).commit_sha).toBe('0');
  });

  test('listManifestsByRun is slug-scoped', () => {
    store.saveManifest('feat/x', 'aaa', makeManifest('1'), 'run-A');
    store.saveManifest('feat/y', 'bbb', makeManifest('2'), 'run-B');
    store.saveManifest('feat/z', 'ccc', makeManifest('3'));
    expect(store.listManifestsByRun('run-A')).toHaveLength(1);
    expect(store.listManifestsByRun('run-B')).toHaveLength(1);
    expect(store.listManifestsByRun('run-Z')).toHaveLength(0);
  });

  test('listManifestsByRun orders by timestamp ASC', () => {
    store.saveManifest('feat/x', 'a', makeManifest('3'), 'run-1');
    store.saveManifest('feat/x', 'b', makeManifest('1'), 'run-1');
    store.saveManifest('feat/x', 'c', makeManifest('2'), 'run-1');
    const rows = store.listManifestsByRun('run-1');
    expect(rows.map((r) => asObj(r).commit_sha)).toEqual(['1', '2', '3']);
  });

  test('hasManifestForSha matches full SHA and prefix alike', () => {
    store.saveManifest('feat/x', 'deadbeef', makeManifest('0'), 'run-1');
    expect(store.hasManifestForSha('deadbeef')).toBe(true);
    expect(store.hasManifestForSha('dead')).toBe(true);
    expect(store.hasManifestForSha('deadbeef', 'run-1')).toBe(true);
    expect(store.hasManifestForSha('deadbeef', 'run-2')).toBe(false);
  });

  test('hasManifestForSha with run_slug filter excludes NULL-slug rows', () => {
    store.saveManifest('feat/x', 'aaa', makeManifest('0'));
    expect(store.hasManifestForSha('aaa')).toBe(true);
    expect(store.hasManifestForSha('aaa', 'run-1')).toBe(false);
  });

  test('hasManifestForSha returns false for unknown SHA', () => {
    expect(store.hasManifestForSha('ffff')).toBe(false);
  });
});
