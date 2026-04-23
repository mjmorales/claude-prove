/**
 * ACB v2.1 unified-store topic module.
 *
 * Ports `tools/acb/store.py` to TypeScript and registers the `acb` domain
 * with `@claude-prove/store` via `registerSchema`. On-disk layout is the
 * unified prove store (`.prove/prove.db`, shared across domains) rather
 * than the standalone `.prove/acb.db` used by the Python implementation.
 *
 * Table-name convention: all domain tables carry the `acb_` prefix per
 * `.prove/decisions/2026-04-21-unified-prove-store.md` § "Schema
 * namespacing". Python's bare `manifests` / `acb_documents` /
 * `review_state` names do NOT carry over — they become `acb_manifests`,
 * `acb_acb_documents`, `acb_review_state`.
 *
 * Design notes:
 *   - Side-effect `registerSchema` at import time mirrors the
 *     decision-record protocol so any import of this module declares the
 *     acb schema to the store registry.
 *   - `openAcbStore` wraps `openStore` + `runMigrations` to give ACB
 *     consumers a one-call entry point matching the ergonomic of the
 *     Python `open_store(project_root)` helper.
 *   - All 14 Python methods land on the exported `AcbStore` class with
 *     camelCase names. Shapes match the Python reference: saveManifest
 *     returns the new rowid as `number`; load* returns `unknown | null`;
 *     cleanBranch returns per-table deletion counts keyed by the
 *     acb-prefixed table names.
 */

import type { Database } from 'bun:sqlite';
import {
  type Store,
  type StoreOptions,
  listDomains,
  openStore,
  registerSchema,
  runMigrations,
} from '@claude-prove/store';

// ---------------------------------------------------------------------------
// Schema registration
// ---------------------------------------------------------------------------

const ACB_MIGRATION_V1_SQL = `
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

CREATE INDEX idx_acb_manifests_branch ON acb_manifests(branch);
CREATE INDEX idx_acb_manifests_branch_sha ON acb_manifests(branch, commit_sha);
CREATE INDEX idx_acb_manifests_run_slug ON acb_manifests(run_slug, branch);
`;

/**
 * v2: absorb review-ui's `group_verdicts` table into the acb domain as
 * `acb_group_verdicts`. The legacy bare `group_verdicts` table was created
 * ad-hoc by `packages/review-ui/server/src/acb.ts::ensureVerdictTable` on
 * every server boot, so older `.prove/prove.db` files may already have it.
 *
 * Backfill pattern: create the new table, copy any rows from the legacy
 * table (when present) that aren't already under the new name, then drop
 * the legacy table. Every statement is idempotent — the migration log
 * guards against re-running, but the SQL itself also tolerates a partial
 * landing (e.g., crash between rename and drop).
 */
const ACB_MIGRATION_V2_SQL = `
CREATE TABLE IF NOT EXISTS acb_group_verdicts (
    slug        TEXT NOT NULL,
    group_id    TEXT NOT NULL,
    verdict     TEXT NOT NULL,
    note        TEXT,
    fix_prompt  TEXT,
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (slug, group_id)
);
CREATE INDEX IF NOT EXISTS idx_acb_group_verdicts_slug ON acb_group_verdicts(slug);
`;

/**
 * Idempotent acb-domain registration. Safe to call from module side-effect
 * AND from tests that previously hit `clearRegistry()` — both paths land
 * a single acb/v1 entry. The guard exists because other test files in the
 * same `bun test` process wipe the registry between tests, and bun shares
 * module cache across files, so a module-scoped `registerSchema` runs
 * only once per process and cannot recover after a wipe.
 */
export function ensureAcbSchemaRegistered(): void {
  if (listDomains().includes('acb')) return;
  registerSchema({
    domain: 'acb',
    migrations: [
      {
        version: 1,
        description: 'create acb_manifests + acb_acb_documents + acb_review_state',
        up: (db: Database) => {
          db.exec(ACB_MIGRATION_V1_SQL);
        },
      },
      {
        version: 2,
        description: 'create acb_group_verdicts (absorb review-ui group_verdicts)',
        up: (db: Database) => {
          db.exec(ACB_MIGRATION_V2_SQL);
          // Legacy backfill: the review-ui server used to create a bare
          // `group_verdicts` table at boot. Copy any existing rows into
          // the acb-prefixed table, then drop the legacy source.
          const legacy = db
            .prepare<{ name: string }, []>(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'group_verdicts'",
            )
            .get();
          if (legacy) {
            db.exec(`
              INSERT OR IGNORE INTO acb_group_verdicts (slug, group_id, verdict, note, fix_prompt, updated_at)
              SELECT slug, group_id, verdict, note, fix_prompt, updated_at FROM group_verdicts;
              DROP TABLE group_verdicts;
            `);
          }
        },
      },
    ],
  });
}

ensureAcbSchemaRegistered();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CleanBranchCounts {
  acb_manifests: number;
  acb_acb_documents: number;
  acb_review_state: number;
}

/** Review-UI verdict value set. Matches the string enum the HTTP API accepts. */
export type GroupVerdict = 'pending' | 'approved' | 'rejected' | 'discuss' | 'rework';

export interface GroupVerdictRecord {
  slug: string;
  groupId: string;
  verdict: GroupVerdict;
  note: string | null;
  fixPrompt: string | null;
  updatedAt: string;
}

/**
 * Open an ACB store: resolves the unified prove.db, runs every pending
 * migration (acb included), and returns the wrapped `AcbStore`.
 *
 * Pass `{ path: ':memory:' }` in tests for isolation; this skips WAL
 * pragmas but still honors the migration registry.
 */
export function openAcbStore(opts: StoreOptions = {}): AcbStore {
  ensureAcbSchemaRegistered();
  const store = openStore(opts);
  runMigrations(store);
  return new AcbStore(store);
}

/**
 * Branch-scoped SQLite-backed store for ACB manifests, documents, and
 * review state. Wraps a `@claude-prove/store` `Store`; the underlying
 * connection stays live until `close()` is called.
 */
export class AcbStore {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  /** Close the underlying database connection. Idempotent. */
  close(): void {
    this.store.close();
  }

  /**
   * Accessor for the wrapped `@claude-prove/store` `Store`. Exposed so
   * in-repo consumers (e.g., the review-ui server) can run acb-domain
   * SQL that isn't covered by the method surface. Out-of-repo code
   * should prefer the named methods; they encode the canonical access
   * pattern.
   */
  getStore(): Store {
    return this.store;
  }

  // -- Manifests ----------------------------------------------------------

  /**
   * Insert a manifest row. Returns the new row's `id` (INTEGER PRIMARY
   * KEY AUTOINCREMENT).
   *
   * The stored timestamp defaults to `data.timestamp` when present and
   * falls back to now() — matching the Python reference exactly so a
   * manifest written by either implementation orders identically in
   * `listManifests`.
   */
  saveManifest(branch: string, commitSha: string, data: unknown, runSlug?: string): number {
    const ts = extractTimestamp(data) ?? isoNow();
    const db = this.store.getDb();
    const stmt = db.prepare<unknown, [string, string, string, string, string, string | null]>(
      'INSERT INTO acb_manifests (branch, commit_sha, timestamp, data, created_at, run_slug) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const result = stmt.run(branch, commitSha, ts, JSON.stringify(data), isoNow(), runSlug ?? null);
    return Number(result.lastInsertRowid);
  }

  /** Any manifest row for `branch`? */
  hasManifest(branch: string): boolean {
    const rows = this.store.all<{ one: number }>(
      'SELECT 1 AS one FROM acb_manifests WHERE branch = ? LIMIT 1',
      [branch],
    );
    return rows.length > 0;
  }

  /**
   * Prefix-match a commit SHA against stored manifests. When `runSlug`
   * is given, only manifests tagged with that slug count (NULL
   * `run_slug` rows are excluded by the filter — matches the Python
   * reference's test_has_manifest_for_sha_null_slug_row_excluded_by_filter).
   */
  hasManifestForSha(commitSha: string, runSlug?: string): boolean {
    if (runSlug === undefined) {
      const rows = this.store.all<{ one: number }>(
        "SELECT 1 AS one FROM acb_manifests WHERE commit_sha LIKE ? || '%' LIMIT 1",
        [commitSha],
      );
      return rows.length > 0;
    }
    const rows = this.store.all<{ one: number }>(
      "SELECT 1 AS one FROM acb_manifests WHERE commit_sha LIKE ? || '%' AND run_slug = ? LIMIT 1",
      [commitSha, runSlug],
    );
    return rows.length > 0;
  }

  /** Manifests tagged with `runSlug`, ordered by timestamp ASC. */
  listManifestsByRun(runSlug: string): unknown[] {
    const rows = this.store.all<{ data: string }>(
      'SELECT data FROM acb_manifests WHERE run_slug = ? ORDER BY timestamp ASC',
      [runSlug],
    );
    return rows.map((r) => JSON.parse(r.data) as unknown);
  }

  /** Manifests for `branch`, ordered by timestamp ASC. */
  listManifests(branch: string): unknown[] {
    const rows = this.store.all<{ data: string }>(
      'SELECT data FROM acb_manifests WHERE branch = ? ORDER BY timestamp ASC',
      [branch],
    );
    return rows.map((r) => JSON.parse(r.data) as unknown);
  }

  /** Delete every manifest for `branch`; returns the deletion count. */
  clearManifests(branch: string): number {
    const db = this.store.getDb();
    const stmt = db.prepare<unknown, [string]>('DELETE FROM acb_manifests WHERE branch = ?');
    const result = stmt.run(branch);
    return Number(result.changes);
  }

  /**
   * Delete manifests for every branch *other than* `keepBranch`. The
   * negation is load-bearing for wave cleanup — pinned by an explicit
   * regression test.
   */
  clearStaleManifests(keepBranch: string): number {
    const db = this.store.getDb();
    const stmt = db.prepare<unknown, [string]>('DELETE FROM acb_manifests WHERE branch != ?');
    const result = stmt.run(keepBranch);
    return Number(result.changes);
  }

  // -- ACB Documents ------------------------------------------------------

  /** Upsert an ACB document on `branch` (PK). Bumps `updated_at`. */
  saveAcb(branch: string, data: unknown): void {
    const now = isoNow();
    this.store.run(
      'INSERT INTO acb_acb_documents (branch, data, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(branch) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at',
      [branch, JSON.stringify(data), now, now],
    );
  }

  /** Load the ACB document for `branch`, or null. */
  loadAcb(branch: string): unknown | null {
    const rows = this.store.all<{ data: string }>(
      'SELECT data FROM acb_acb_documents WHERE branch = ?',
      [branch],
    );
    const [row] = rows;
    if (!row) return null;
    return JSON.parse(row.data) as unknown;
  }

  /** Branch with the most-recently updated ACB document, or null. */
  latestAcbBranch(): string | null {
    const rows = this.store.all<{ branch: string }>(
      'SELECT branch FROM acb_acb_documents ORDER BY updated_at DESC LIMIT 1',
    );
    const [row] = rows;
    return row ? row.branch : null;
  }

  // -- Review State -------------------------------------------------------

  /** Upsert review state on `branch` (PK). Bumps `updated_at`. */
  saveReview(branch: string, acbHash: string, data: unknown): void {
    const now = isoNow();
    this.store.run(
      'INSERT INTO acb_review_state (branch, acb_hash, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(branch) DO UPDATE SET acb_hash = excluded.acb_hash, data = excluded.data, updated_at = excluded.updated_at',
      [branch, acbHash, JSON.stringify(data), now, now],
    );
  }

  /** Load review state for `branch`, or null. */
  loadReview(branch: string): unknown | null {
    const rows = this.store.all<{ data: string }>(
      'SELECT data FROM acb_review_state WHERE branch = ?',
      [branch],
    );
    const [row] = rows;
    if (!row) return null;
    return JSON.parse(row.data) as unknown;
  }

  // -- Group Verdicts -----------------------------------------------------

  /** List every verdict recorded for `slug`. Order is insertion-defined. */
  listGroupVerdicts(slug: string): GroupVerdictRecord[] {
    const rows = this.store.all<{
      slug: string;
      group_id: string;
      verdict: string;
      note: string | null;
      fix_prompt: string | null;
      updated_at: string;
    }>(
      'SELECT slug, group_id, verdict, note, fix_prompt, updated_at FROM acb_group_verdicts WHERE slug = ?',
      [slug],
    );
    return rows.map((r) => ({
      slug: r.slug,
      groupId: r.group_id,
      verdict: r.verdict as GroupVerdict,
      note: r.note,
      fixPrompt: r.fix_prompt,
      updatedAt: r.updated_at,
    }));
  }

  /** Upsert a verdict on `(slug, groupId)`. Bumps `updated_at` to now(). */
  upsertGroupVerdict(
    slug: string,
    groupId: string,
    verdict: GroupVerdict,
    note: string | null,
    fixPrompt: string | null,
  ): GroupVerdictRecord {
    const updatedAt = isoNow();
    this.store.run(
      `INSERT INTO acb_group_verdicts (slug, group_id, verdict, note, fix_prompt, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(slug, group_id) DO UPDATE SET
         verdict    = excluded.verdict,
         note       = excluded.note,
         fix_prompt = excluded.fix_prompt,
         updated_at = excluded.updated_at`,
      [slug, groupId, verdict, note, fixPrompt, updatedAt],
    );
    return { slug, groupId, verdict, note, fixPrompt, updatedAt };
  }

  /** Delete the `(slug, groupId)` verdict row. No-op if absent. */
  clearGroupVerdict(slug: string, groupId: string): void {
    this.store.run('DELETE FROM acb_group_verdicts WHERE slug = ? AND group_id = ?', [
      slug,
      groupId,
    ]);
  }

  // -- Cleanup ------------------------------------------------------------

  /**
   * Delete every row for `branch` across all three acb_* tables.
   * Returned counts are keyed by the acb-prefixed table names — these
   * differ from the Python reference (which used bare `manifests`,
   * `acb_documents`, `review_state`) because the unified store namespaces
   * all domain tables.
   */
  cleanBranch(branch: string): CleanBranchCounts {
    return {
      acb_manifests: this.deleteBranchRows('acb_manifests', branch),
      acb_acb_documents: this.deleteBranchRows('acb_acb_documents', branch),
      acb_review_state: this.deleteBranchRows('acb_review_state', branch),
    };
  }

  /** Sorted unique branch names across manifests + documents + review state. */
  branches(): string[] {
    const tables = ['acb_manifests', 'acb_acb_documents', 'acb_review_state'] as const;
    const seen = new Set<string>();
    for (const table of tables) {
      const rows = this.store.all<{ branch: string }>(`SELECT DISTINCT branch FROM ${table}`);
      for (const r of rows) seen.add(r.branch);
    }
    return [...seen].sort();
  }

  // -- Internals ----------------------------------------------------------

  /**
   * Execute `DELETE FROM <table> WHERE branch = ?` and return changes.
   * `table` is a hard-coded identifier from `cleanBranch`; the value is
   * never user-controlled, so inlining it avoids the ? placeholder
   * semantics of table names.
   */
  private deleteBranchRows(table: string, branch: string): number {
    const db = this.store.getDb();
    const stmt = db.prepare<unknown, [string]>(`DELETE FROM ${table} WHERE branch = ?`);
    const result = stmt.run(branch);
    return Number(result.changes);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isoNow(): string {
  return new Date().toISOString();
}

function extractTimestamp(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const ts = (data as Record<string, unknown>).timestamp;
  return typeof ts === 'string' ? ts : null;
}
