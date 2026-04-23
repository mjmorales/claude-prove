/**
 * Importer tests — cover legacy-absent short-circuit, post-migrate +
 * pre-migrate legacy schemas, idempotency, transactional rollback,
 * concurrent-process semantics, and the auto-invoke wrapper's memoization
 * + stderr contract.
 *
 * Each test builds a throwaway workspace under `os.tmpdir()` with a real
 * `.prove/acb.db` file; the importer's `openStore` does NOT require a
 * git repository because we pass `path:` explicitly when the importer
 * joins `<root>/.prove/prove.db`.
 */

import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureLegacyImported, importLegacyDb, resetLegacyImportMemo } from './importer';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const LEGACY_POST_MIGRATE_SCHEMA = `
CREATE TABLE manifests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    branch TEXT NOT NULL,
    commit_sha TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL,
    run_slug TEXT
);
CREATE TABLE acb_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    branch TEXT NOT NULL UNIQUE,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE review_state (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    branch TEXT NOT NULL UNIQUE,
    acb_hash TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
`;

const LEGACY_PRE_MIGRATE_SCHEMA = `
CREATE TABLE manifests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    branch TEXT NOT NULL,
    commit_sha TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE acb_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    branch TEXT NOT NULL UNIQUE,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE review_state (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    branch TEXT NOT NULL UNIQUE,
    acb_hash TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
`;

interface ManifestFixture {
  branch: string;
  commit_sha: string;
  timestamp: string;
  data: string;
  created_at: string;
  run_slug: string | null;
}

interface DocumentFixture {
  branch: string;
  data: string;
  created_at: string;
  updated_at: string;
}

interface ReviewFixture {
  branch: string;
  acb_hash: string;
  data: string;
  created_at: string;
  updated_at: string;
}

function makeWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'acb-importer-'));
  mkdirSync(join(root, '.prove'), { recursive: true });
  return root;
}

function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

function createPostMigrateLegacy(
  root: string,
  opts: {
    manifests?: ManifestFixture[];
    documents?: DocumentFixture[];
    reviews?: ReviewFixture[];
  },
): string {
  const path = join(root, '.prove', 'acb.db');
  const db = new Database(path, { create: true });
  try {
    db.exec(LEGACY_POST_MIGRATE_SCHEMA);
    for (const m of opts.manifests ?? []) {
      db.prepare(
        'INSERT INTO manifests (branch, commit_sha, timestamp, data, created_at, run_slug) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(m.branch, m.commit_sha, m.timestamp, m.data, m.created_at, m.run_slug);
    }
    for (const d of opts.documents ?? []) {
      db.prepare(
        'INSERT INTO acb_documents (branch, data, created_at, updated_at) VALUES (?, ?, ?, ?)',
      ).run(d.branch, d.data, d.created_at, d.updated_at);
    }
    for (const r of opts.reviews ?? []) {
      db.prepare(
        'INSERT INTO review_state (branch, acb_hash, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ).run(r.branch, r.acb_hash, r.data, r.created_at, r.updated_at);
    }
  } finally {
    db.close();
  }
  return path;
}

function createPreMigrateLegacy(
  root: string,
  opts: { manifests?: Omit<ManifestFixture, 'run_slug'>[] },
): string {
  const path = join(root, '.prove', 'acb.db');
  const db = new Database(path, { create: true });
  try {
    db.exec(LEGACY_PRE_MIGRATE_SCHEMA);
    for (const m of opts.manifests ?? []) {
      db.prepare(
        'INSERT INTO manifests (branch, commit_sha, timestamp, data, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run(m.branch, m.commit_sha, m.timestamp, m.data, m.created_at);
    }
  } finally {
    db.close();
  }
  return path;
}

function readProveDb<T>(root: string, sql: string): T[] {
  const db = new Database(join(root, '.prove', 'prove.db'), { readonly: true });
  try {
    return db.prepare<T, []>(sql).all();
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('importLegacyDb: detection short-circuits', () => {
  let root: string;
  beforeEach(() => {
    root = makeWorkspace();
    resetLegacyImportMemo();
  });
  afterEach(() => cleanup(root));

  test('legacy-absent: no .prove/acb.db → reason=legacy-absent, no-op', () => {
    const result = importLegacyDb(root);
    expect(result).toEqual({ imported: false, reason: 'legacy-absent' });
    // prove.db is not forced into existence on this path.
    expect(existsSync(join(root, '.prove', 'prove.db'))).toBe(false);
  });
});

describe('importLegacyDb: populated legacy', () => {
  let root: string;
  beforeEach(() => {
    root = makeWorkspace();
    resetLegacyImportMemo();
  });
  afterEach(() => cleanup(root));

  test('imports all three tables, deletes legacy db, preserves content', () => {
    const legacyPath = createPostMigrateLegacy(root, {
      manifests: [
        {
          branch: 'feat/x',
          commit_sha: 'abc123',
          timestamp: '2026-01-01T00:00:00Z',
          data: JSON.stringify({ acb_manifest_version: '0.2', commit_sha: 'abc123' }),
          created_at: '2026-01-01T00:00:01Z',
          run_slug: 'run-1',
        },
        {
          branch: 'feat/y',
          commit_sha: 'def456',
          timestamp: '2026-01-02T00:00:00Z',
          data: JSON.stringify({ acb_manifest_version: '0.2', commit_sha: 'def456' }),
          created_at: '2026-01-02T00:00:01Z',
          run_slug: null,
        },
      ],
      documents: [
        {
          branch: 'feat/x',
          data: JSON.stringify({ acb_version: '0.2', id: 'doc-x' }),
          created_at: '2026-01-01T00:00:02Z',
          updated_at: '2026-01-01T00:00:03Z',
        },
      ],
      reviews: [
        {
          branch: 'feat/x',
          acb_hash: 'h-x',
          data: JSON.stringify({ overall_verdict: 'approved' }),
          created_at: '2026-01-01T00:00:04Z',
          updated_at: '2026-01-01T00:00:05Z',
        },
      ],
    });

    const result = importLegacyDb(root);
    expect(result).toEqual({
      imported: true,
      counts: { manifests: 2, acb_documents: 1, review_state: 1 },
    });
    expect(existsSync(legacyPath)).toBe(false);

    const manifests = readProveDb<{
      branch: string;
      commit_sha: string;
      timestamp: string;
      data: string;
      created_at: string;
      run_slug: string | null;
    }>(
      root,
      'SELECT branch, commit_sha, timestamp, data, created_at, run_slug FROM acb_manifests ORDER BY branch',
    );
    expect(manifests).toEqual([
      {
        branch: 'feat/x',
        commit_sha: 'abc123',
        timestamp: '2026-01-01T00:00:00Z',
        data: JSON.stringify({ acb_manifest_version: '0.2', commit_sha: 'abc123' }),
        created_at: '2026-01-01T00:00:01Z',
        run_slug: 'run-1',
      },
      {
        branch: 'feat/y',
        commit_sha: 'def456',
        timestamp: '2026-01-02T00:00:00Z',
        data: JSON.stringify({ acb_manifest_version: '0.2', commit_sha: 'def456' }),
        created_at: '2026-01-02T00:00:01Z',
        run_slug: null,
      },
    ]);

    const docs = readProveDb<{ branch: string; data: string }>(
      root,
      'SELECT branch, data FROM acb_acb_documents',
    );
    expect(docs).toEqual([
      { branch: 'feat/x', data: JSON.stringify({ acb_version: '0.2', id: 'doc-x' }) },
    ]);

    const reviews = readProveDb<{ branch: string; acb_hash: string; data: string }>(
      root,
      'SELECT branch, acb_hash, data FROM acb_review_state',
    );
    expect(reviews).toEqual([
      {
        branch: 'feat/x',
        acb_hash: 'h-x',
        data: JSON.stringify({ overall_verdict: 'approved' }),
      },
    ]);
  });

  test('pre-migrate legacy (no run_slug column): all manifests import with run_slug=NULL', () => {
    createPreMigrateLegacy(root, {
      manifests: [
        {
          branch: 'feat/x',
          commit_sha: 'abc',
          timestamp: '2026-01-01T00:00:00Z',
          data: '{}',
          created_at: '2026-01-01T00:00:01Z',
        },
        {
          branch: 'feat/y',
          commit_sha: 'def',
          timestamp: '2026-01-02T00:00:00Z',
          data: '{}',
          created_at: '2026-01-02T00:00:01Z',
        },
      ],
    });

    const result = importLegacyDb(root);
    expect(result.imported).toBe(true);
    expect(result.counts?.manifests).toBe(2);

    const rows = readProveDb<{ branch: string; run_slug: string | null }>(
      root,
      'SELECT branch, run_slug FROM acb_manifests ORDER BY branch',
    );
    expect(rows).toEqual([
      { branch: 'feat/x', run_slug: null },
      { branch: 'feat/y', run_slug: null },
    ]);
  });

  test('post-migrate legacy preserves non-null run_slug values', () => {
    createPostMigrateLegacy(root, {
      manifests: [
        {
          branch: 'feat/x',
          commit_sha: 'abc',
          timestamp: '2026-01-01T00:00:00Z',
          data: '{}',
          created_at: '2026-01-01T00:00:01Z',
          run_slug: 'run-preserve',
        },
      ],
    });

    const result = importLegacyDb(root);
    expect(result.imported).toBe(true);

    const rows = readProveDb<{ run_slug: string | null }>(
      root,
      'SELECT run_slug FROM acb_manifests',
    );
    expect(rows).toEqual([{ run_slug: 'run-preserve' }]);
  });

  test('idempotent: already-migrated prove.db leaves legacy untouched', () => {
    const legacyPath = createPostMigrateLegacy(root, {
      manifests: [
        {
          branch: 'feat/x',
          commit_sha: 'abc',
          timestamp: '2026-01-01T00:00:00Z',
          data: '{}',
          created_at: '2026-01-01T00:00:01Z',
          run_slug: null,
        },
      ],
    });

    const first = importLegacyDb(root);
    expect(first.imported).toBe(true);
    expect(existsSync(legacyPath)).toBe(false);

    // Simulate a second run where someone restores the legacy file on
    // disk (e.g., rolled back a backup). prove.db already has the rows,
    // so the second call must no-op and leave the restored file alone.
    createPostMigrateLegacy(root, {
      manifests: [
        {
          branch: 'feat/z',
          commit_sha: 'zzz',
          timestamp: '2026-02-02T00:00:00Z',
          data: '{}',
          created_at: '2026-02-02T00:00:01Z',
          run_slug: null,
        },
      ],
    });
    expect(existsSync(legacyPath)).toBe(true);

    const second = importLegacyDb(root);
    expect(second).toEqual({ imported: false, reason: 'already-migrated' });
    expect(existsSync(legacyPath)).toBe(true);
  });
});

describe('importLegacyDb: transactional rollback', () => {
  let root: string;
  beforeEach(() => {
    root = makeWorkspace();
    resetLegacyImportMemo();
  });
  afterEach(() => cleanup(root));

  test('malformed legacy column type (non-string data) aborts the transaction; prove.db stays empty; legacy stays intact', () => {
    // Create a legacy db whose `data` column in `manifests` is BLOB-ish
    // (a real bytes buffer) rather than TEXT. Our `asString` narrowing
    // will throw, which fires the rollback path.
    const legacyPath = join(root, '.prove', 'acb.db');
    const db = new Database(legacyPath, { create: true });
    try {
      db.exec(LEGACY_POST_MIGRATE_SCHEMA);
      // Force a typed BLOB into `data` by binding a Uint8Array.
      db.prepare(
        'INSERT INTO manifests (branch, commit_sha, timestamp, data, created_at, run_slug) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(
        'feat/x',
        'abc',
        '2026-01-01T00:00:00Z',
        new Uint8Array([0x01, 0x02, 0x03]),
        '2026-01-01T00:00:01Z',
        null,
      );
    } finally {
      db.close();
    }

    const result = importLegacyDb(root);
    expect(result.imported).toBe(false);
    expect(result.reason).toBe('error');
    expect(result.error).toContain('manifests.data');

    // Legacy file still present — we never got past the read phase.
    expect(existsSync(legacyPath)).toBe(true);

    // prove.db may or may not have been created (openStore creates the
    // file on open), but acb_manifests must be empty after rollback.
    if (existsSync(join(root, '.prove', 'prove.db'))) {
      const rows = readProveDb<{ n: number }>(root, 'SELECT COUNT(*) AS n FROM acb_manifests');
      expect(rows[0]?.n).toBe(0);
    }
  });
});

describe('importLegacyDb: concurrency', () => {
  let root: string;
  beforeEach(() => {
    root = makeWorkspace();
    resetLegacyImportMemo();
  });
  afterEach(() => cleanup(root));

  test('sequential subprocesses: second run sees already-migrated with no duplicate rows', async () => {
    // Build a legacy fixture with 3 manifest rows. The "concurrency"
    // invariant this test pins is simpler than a true race: once a
    // successful import lands, a second independent process (not in the
    // same memoization cache) sees prove.db populated and returns
    // `already-migrated` without re-inserting rows. We run the two
    // invocations as separate subprocesses to prove the memoization
    // cache is irrelevant to the guard — the db itself is the source of
    // truth. A true concurrent race is covered by the BEGIN EXCLUSIVE
    // retry loop in `importLegacyDb`; asserting that deterministically
    // in-test is impractical because the OS scheduler decides the
    // winner.
    createPostMigrateLegacy(root, {
      manifests: [
        {
          branch: 'feat/a',
          commit_sha: 'aaa',
          timestamp: '2026-01-01T00:00:00Z',
          data: '{}',
          created_at: '2026-01-01T00:00:01Z',
          run_slug: null,
        },
        {
          branch: 'feat/b',
          commit_sha: 'bbb',
          timestamp: '2026-01-02T00:00:00Z',
          data: '{}',
          created_at: '2026-01-02T00:00:01Z',
          run_slug: null,
        },
        {
          branch: 'feat/c',
          commit_sha: 'ccc',
          timestamp: '2026-01-03T00:00:00Z',
          data: '{}',
          created_at: '2026-01-03T00:00:01Z',
          run_slug: null,
        },
      ],
    });

    const importerPath = join(import.meta.dir, 'importer.ts');
    const script = `
      import { importLegacyDb } from ${JSON.stringify(importerPath)};
      const res = importLegacyDb(${JSON.stringify(root)});
      process.stdout.write(JSON.stringify(res));
    `;

    const spawnOne = () =>
      Bun.spawn({
        cmd: ['bun', '-e', script],
        stdout: 'pipe',
        stderr: 'pipe',
      });

    const p1 = spawnOne();
    const [out1, err1] = await Promise.all([
      new Response(p1.stdout).text(),
      new Response(p1.stderr).text(),
    ]);
    await p1.exited;

    if (!out1) {
      throw new Error(`first subprocess produced no stdout.\n  stderr:\n${err1}`);
    }
    const r1 = JSON.parse(out1) as { imported: boolean; reason?: string };
    expect(r1.imported).toBe(true);
    expect(existsSync(join(root, '.prove', 'acb.db'))).toBe(false);

    // Restore a legacy file with different contents so we can detect a
    // double-import (extra rows would appear in acb_manifests).
    createPostMigrateLegacy(root, {
      manifests: [
        {
          branch: 'feat/ghost',
          commit_sha: 'ghost',
          timestamp: '2026-02-02T00:00:00Z',
          data: '{}',
          created_at: '2026-02-02T00:00:01Z',
          run_slug: null,
        },
      ],
    });

    const p2 = spawnOne();
    const [out2, err2] = await Promise.all([
      new Response(p2.stdout).text(),
      new Response(p2.stderr).text(),
    ]);
    await p2.exited;

    if (!out2) {
      throw new Error(`second subprocess produced no stdout.\n  stderr:\n${err2}`);
    }
    const r2 = JSON.parse(out2) as { imported: boolean; reason?: string };
    expect(r2).toEqual({ imported: false, reason: 'already-migrated' });

    // Exactly 3 rows in acb_manifests — no double-insert, no ghost row.
    const rows = readProveDb<{ n: number; branches: string }>(
      root,
      "SELECT COUNT(*) AS n, GROUP_CONCAT(branch, ',') AS branches FROM (SELECT branch FROM acb_manifests ORDER BY branch)",
    );
    expect(rows[0]?.n).toBe(3);
    expect(rows[0]?.branches).toBe('feat/a,feat/b,feat/c');

    // Legacy file from the second attempt is still intact on disk —
    // already-migrated path must not delete it.
    expect(existsSync(join(root, '.prove', 'acb.db'))).toBe(true);
  });
});

describe('ensureLegacyImported: auto-invoke wrapper', () => {
  let root: string;
  beforeEach(() => {
    root = makeWorkspace();
    resetLegacyImportMemo();
  });
  afterEach(() => cleanup(root));

  test('memoizes per-workspaceRoot: second call returns cached result without a second import attempt', () => {
    // Create + import; then delete prove.db to force a repeat import
    // *if* the wrapper did not memoize. The memoized second call must
    // return the cached success result.
    createPostMigrateLegacy(root, {
      manifests: [
        {
          branch: 'feat/x',
          commit_sha: 'abc',
          timestamp: '2026-01-01T00:00:00Z',
          data: '{}',
          created_at: '2026-01-01T00:00:01Z',
          run_slug: null,
        },
      ],
    });

    const first = ensureLegacyImported(root);
    expect(first.imported).toBe(true);
    expect(first.counts).toEqual({ manifests: 1, acb_documents: 0, review_state: 0 });

    // Nuke prove.db. If the wrapper re-checked, the second call would
    // see legacy-absent (we already unlinked legacy on success) and
    // return a different shape. Memoization keeps `imported: true`.
    rmSync(join(root, '.prove', 'prove.db'), { force: true });

    const second = ensureLegacyImported(root);
    expect(second).toBe(first);
  });

  test('stderr format matches the imported-success spec', () => {
    createPostMigrateLegacy(root, {
      manifests: [
        {
          branch: 'feat/x',
          commit_sha: 'abc',
          timestamp: '2026-01-01T00:00:00Z',
          data: '{}',
          created_at: '2026-01-01T00:00:01Z',
          run_slug: null,
        },
        {
          branch: 'feat/y',
          commit_sha: 'def',
          timestamp: '2026-01-02T00:00:00Z',
          data: '{}',
          created_at: '2026-01-02T00:00:01Z',
          run_slug: null,
        },
      ],
      documents: [
        {
          branch: 'feat/x',
          data: '{}',
          created_at: '2026-01-01T00:00:02Z',
          updated_at: '2026-01-01T00:00:03Z',
        },
      ],
      reviews: [
        {
          branch: 'feat/x',
          acb_hash: 'h',
          data: '{}',
          created_at: '2026-01-01T00:00:04Z',
          updated_at: '2026-01-01T00:00:05Z',
        },
      ],
    });

    const captured: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stderr.write;
    try {
      const result = ensureLegacyImported(root);
      expect(result.imported).toBe(true);
    } finally {
      process.stderr.write = originalWrite;
    }

    const joined = captured.join('');
    expect(joined).toBe(
      'acb: imported 2 manifests, 1 documents, 1 reviews from legacy .prove/acb.db\n',
    );
  });

  test('legacy-absent is silent on stderr', () => {
    const captured: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stderr.write;
    try {
      const result = ensureLegacyImported(root);
      expect(result).toEqual({ imported: false, reason: 'legacy-absent' });
    } finally {
      process.stderr.write = originalWrite;
    }
    expect(captured.join('')).toBe('');
  });

  test('already-migrated is silent on stderr', () => {
    // Populate prove.db with acb row directly, then place a legacy db.
    createPostMigrateLegacy(root, {
      manifests: [
        {
          branch: 'feat/x',
          commit_sha: 'abc',
          timestamp: '2026-01-01T00:00:00Z',
          data: '{}',
          created_at: '2026-01-01T00:00:01Z',
          run_slug: null,
        },
      ],
    });
    // First import populates prove.db and deletes legacy.
    const first = importLegacyDb(root);
    expect(first.imported).toBe(true);
    resetLegacyImportMemo();
    // Restore a legacy file with unrelated content.
    createPostMigrateLegacy(root, {
      manifests: [
        {
          branch: 'feat/z',
          commit_sha: 'zzz',
          timestamp: '2026-02-02T00:00:00Z',
          data: '{}',
          created_at: '2026-02-02T00:00:01Z',
          run_slug: null,
        },
      ],
    });

    const captured: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stderr.write;
    try {
      const result = ensureLegacyImported(root);
      expect(result).toEqual({ imported: false, reason: 'already-migrated' });
    } finally {
      process.stderr.write = originalWrite;
    }
    expect(captured.join('')).toBe('');
  });
});
