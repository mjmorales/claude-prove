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
