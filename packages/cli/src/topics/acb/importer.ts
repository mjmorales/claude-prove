/**
 * One-shot importer: copy legacy `.prove/acb.db` (Python ACB v2 standalone
 * SQLite) into the unified `.prove/prove.db` acb-domain tables.
 *
 * Called transparently via `ensureLegacyImported` at the top of every `prove
 * acb <sub>` handler, and explicitly via `prove acb migrate-legacy-db` (see
 * `cli/migrate-legacy-cmd.ts`). Exactly one successful import can ever run
 * on a given workspace — on success the legacy file is deleted.
 *
 * Design:
 *   - Legacy dbs come in two schema shapes: pre-migrate (manifests table
 *     has no `run_slug` column) and post-migrate (has it). We detect via
 *     `PRAGMA table_info(manifests)` and insert NULL for run_slug when the
 *     column is absent.
 *   - The entire copy runs under `BEGIN EXCLUSIVE` on prove.db so a second
 *     concurrent importer sees `SQLITE_BUSY` and backs off once; on retry
 *     the loser observes non-empty acb_* tables and returns `already-migrated`.
 *   - Bare table names in legacy (`manifests`, `acb_documents`, `review_state`)
 *     land in the prefixed unified names (`acb_manifests`, `acb_acb_documents`,
 *     `acb_review_state`).
 */

import { Database } from 'bun:sqlite';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { openStore, runMigrations } from '@claude-prove/store';
import { ensureAcbSchemaRegistered } from './store';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type ImportReason = 'legacy-absent' | 'already-migrated' | 'error';

export interface ImportCounts {
  manifests: number;
  acb_documents: number;
  review_state: number;
}

export interface ImportResult {
  imported: boolean;
  counts?: ImportCounts;
  reason?: ImportReason;
  error?: string;
}

/**
 * Run the legacy-db import synchronously. Idempotent: if legacy db is
 * absent OR prove.db already has acb rows, returns a no-op result and
 * leaves both files untouched.
 *
 * On success: all three acb_* tables are populated inside a single
 * transaction, then the legacy `.prove/acb.db` (plus any `-wal`/`-shm`
 * sidecars) is deleted.
 *
 * Never throws — errors land in `result.error` with `reason: 'error'`.
 */
export function importLegacyDb(workspaceRoot: string): ImportResult {
  const legacyPath = join(workspaceRoot, '.prove', 'acb.db');
  if (!existsSync(legacyPath)) {
    return { imported: false, reason: 'legacy-absent' };
  }

  // One retry on SQLITE_BUSY covers the two-process race: first process
  // holds BEGIN EXCLUSIVE, second process waits 75ms, re-checks — at that
  // point the winner's rows are visible and we short-circuit to
  // already-migrated.
  const first = runImport(workspaceRoot, legacyPath);
  if (first.reason !== 'error' || !isBusy(first.error)) return first;

  sleepSync(75);
  const second = runImport(workspaceRoot, legacyPath);
  if (second.reason !== 'error' || !isBusy(second.error)) return second;

  return { imported: false, reason: 'error', error: 'busy' };
}

// Per-process memoization for the auto-invoke wrapper. The CLI subcommand
// (`prove acb migrate-legacy-db`) bypasses this and calls `importLegacyDb`
// directly so user-triggered runs always re-check state.
const MEMO = new Map<string, ImportResult>();

/**
 * Check-then-import wrapper for `prove acb <sub>` handlers. Memoizes the
 * result per-workspaceRoot per-process so repeated calls within one CLI
 * invocation skip the filesystem check entirely.
 *
 * Stderr contract (matches the Python shim's spec):
 *   - imported: one-line success summary with counts
 *   - error:    one-line warning (caller decides whether to proceed)
 *   - already-migrated / legacy-absent: silent
 */
export function ensureLegacyImported(workspaceRoot: string): ImportResult {
  const cached = MEMO.get(workspaceRoot);
  if (cached !== undefined) return cached;

  const result = importLegacyDb(workspaceRoot);
  MEMO.set(workspaceRoot, result);

  if (result.imported && result.counts) {
    const { manifests, acb_documents, review_state } = result.counts;
    process.stderr.write(
      `acb: imported ${manifests} manifests, ${acb_documents} documents, ${review_state} reviews from legacy .prove/acb.db\n`,
    );
  } else if (result.reason === 'error') {
    process.stderr.write(`acb: legacy-db import failed: ${result.error ?? 'unknown error'}\n`);
  }

  return result;
}

/** Test-only: drop the memoization table. Never call from production code. */
export function resetLegacyImportMemo(): void {
  MEMO.clear();
}

// ---------------------------------------------------------------------------
// Import implementation
// ---------------------------------------------------------------------------

interface LegacyManifestRow {
  branch: string;
  commit_sha: string;
  timestamp: string;
  data: string;
  created_at: string;
  run_slug: string | null;
}

interface LegacyDocumentRow {
  branch: string;
  data: string;
  created_at: string;
  updated_at: string;
}

interface LegacyReviewRow {
  branch: string;
  acb_hash: string;
  data: string;
  created_at: string;
  updated_at: string;
}

function runImport(workspaceRoot: string, legacyPath: string): ImportResult {
  // Mirror openAcbStore internals: register the acb schema, open the
  // unified store at `<workspaceRoot>/.prove/prove.db`, run pending
  // migrations so the acb_* tables exist before we read/write them.
  //
  // `openStore` itself can throw SQLITE_BUSY from the `PRAGMA
  // journal_mode = WAL` call when a peer process already holds the lock;
  // catch it here so the retry loop in `importLegacyDb` can back off.
  ensureAcbSchemaRegistered();
  const proveDbPath = join(workspaceRoot, '.prove', 'prove.db');
  let store: ReturnType<typeof openStore>;
  try {
    store = openStore({ path: proveDbPath });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { imported: false, reason: 'error', error: message };
  }
  try {
    runMigrations(store);
    const proveDb = store.getDb();

    if (proveDbHasAcbRows(proveDb)) {
      return { imported: false, reason: 'already-migrated' };
    }

    const legacyDb = new Database(legacyPath, { readonly: true });
    let manifests: LegacyManifestRow[];
    let documents: LegacyDocumentRow[];
    let reviews: LegacyReviewRow[];
    try {
      const hasRunSlug = legacyHasRunSlugColumn(legacyDb);
      manifests = readLegacyManifests(legacyDb, hasRunSlug);
      documents = readLegacyDocuments(legacyDb);
      reviews = readLegacyReviews(legacyDb);
    } finally {
      legacyDb.close();
    }

    try {
      proveDb.run('BEGIN EXCLUSIVE TRANSACTION');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { imported: false, reason: 'error', error: message };
    }

    try {
      insertManifests(proveDb, manifests);
      insertDocuments(proveDb, documents);
      insertReviews(proveDb, reviews);
      proveDb.run('COMMIT');
    } catch (err) {
      try {
        proveDb.run('ROLLBACK');
      } catch {
        /* ignore rollback errors; the original is already fatal */
      }
      const message = err instanceof Error ? err.message : String(err);
      return { imported: false, reason: 'error', error: message };
    }

    deleteLegacyFiles(legacyPath);

    return {
      imported: true,
      counts: {
        manifests: manifests.length,
        acb_documents: documents.length,
        review_state: reviews.length,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { imported: false, reason: 'error', error: message };
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// Legacy-db readers (foreign schema — NOT routed through packages/store)
// ---------------------------------------------------------------------------

function legacyHasRunSlugColumn(legacyDb: Database): boolean {
  const rows = legacyDb
    .prepare<{ name: string }, []>("SELECT name FROM pragma_table_info('manifests')")
    .all();
  return rows.some((r) => r.name === 'run_slug');
}

function readLegacyManifests(legacyDb: Database, hasRunSlug: boolean): LegacyManifestRow[] {
  const sql = hasRunSlug
    ? 'SELECT branch, commit_sha, timestamp, data, created_at, run_slug FROM manifests'
    : 'SELECT branch, commit_sha, timestamp, data, created_at, NULL AS run_slug FROM manifests';
  const rows = legacyDb.prepare<Record<string, unknown>, []>(sql).all();
  return rows.map((row) => ({
    branch: asString(row.branch, 'manifests.branch'),
    commit_sha: asString(row.commit_sha, 'manifests.commit_sha'),
    timestamp: asString(row.timestamp, 'manifests.timestamp'),
    data: asString(row.data, 'manifests.data'),
    created_at: asString(row.created_at, 'manifests.created_at'),
    run_slug: asNullableString(row.run_slug),
  }));
}

function readLegacyDocuments(legacyDb: Database): LegacyDocumentRow[] {
  const rows = legacyDb
    .prepare<Record<string, unknown>, []>(
      'SELECT branch, data, created_at, updated_at FROM acb_documents',
    )
    .all();
  return rows.map((row) => ({
    branch: asString(row.branch, 'acb_documents.branch'),
    data: asString(row.data, 'acb_documents.data'),
    created_at: asString(row.created_at, 'acb_documents.created_at'),
    updated_at: asString(row.updated_at, 'acb_documents.updated_at'),
  }));
}

function readLegacyReviews(legacyDb: Database): LegacyReviewRow[] {
  const rows = legacyDb
    .prepare<Record<string, unknown>, []>(
      'SELECT branch, acb_hash, data, created_at, updated_at FROM review_state',
    )
    .all();
  return rows.map((row) => ({
    branch: asString(row.branch, 'review_state.branch'),
    acb_hash: asString(row.acb_hash, 'review_state.acb_hash'),
    data: asString(row.data, 'review_state.data'),
    created_at: asString(row.created_at, 'review_state.created_at'),
    updated_at: asString(row.updated_at, 'review_state.updated_at'),
  }));
}

// ---------------------------------------------------------------------------
// Prove-db writers (run inside BEGIN EXCLUSIVE)
// ---------------------------------------------------------------------------

function insertManifests(db: Database, rows: LegacyManifestRow[]): void {
  const stmt = db.prepare<unknown, [string, string, string, string, string, string | null]>(
    'INSERT INTO acb_manifests (branch, commit_sha, timestamp, data, created_at, run_slug) VALUES (?, ?, ?, ?, ?, ?)',
  );
  for (const r of rows) {
    stmt.run(r.branch, r.commit_sha, r.timestamp, r.data, r.created_at, r.run_slug);
  }
}

function insertDocuments(db: Database, rows: LegacyDocumentRow[]): void {
  // UNIQUE(branch): legacy should have at most one row per branch, but
  // `INSERT OR IGNORE` gives us a stable fallback if the invariant ever
  // slips (e.g., a manually-edited db).
  const stmt = db.prepare<unknown, [string, string, string, string]>(
    'INSERT OR IGNORE INTO acb_acb_documents (branch, data, created_at, updated_at) VALUES (?, ?, ?, ?)',
  );
  for (const r of rows) {
    stmt.run(r.branch, r.data, r.created_at, r.updated_at);
  }
}

function insertReviews(db: Database, rows: LegacyReviewRow[]): void {
  const stmt = db.prepare<unknown, [string, string, string, string, string]>(
    'INSERT OR IGNORE INTO acb_review_state (branch, acb_hash, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  );
  for (const r of rows) {
    stmt.run(r.branch, r.acb_hash, r.data, r.created_at, r.updated_at);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function proveDbHasAcbRows(proveDb: Database): boolean {
  const row = proveDb
    .prepare<{ total: number }, []>(
      'SELECT (SELECT COUNT(*) FROM acb_manifests) + (SELECT COUNT(*) FROM acb_acb_documents) + (SELECT COUNT(*) FROM acb_review_state) AS total',
    )
    .get();
  return (row?.total ?? 0) > 0;
}

function deleteLegacyFiles(legacyPath: string): void {
  for (const path of [legacyPath, `${legacyPath}-wal`, `${legacyPath}-shm`]) {
    if (existsSync(path)) {
      try {
        unlinkSync(path);
      } catch {
        /* best-effort sidecar cleanup */
      }
    }
  }
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`legacy row ${field}: expected TEXT, got ${typeof value}`);
  }
  return value;
}

function asNullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new Error(`legacy row run_slug: expected TEXT or NULL, got ${typeof value}`);
  }
  return value;
}

function isBusy(message: string | undefined): boolean {
  if (!message) return false;
  return /SQLITE_BUSY|database is locked/i.test(message);
}

function sleepSync(ms: number): void {
  // Bun.sleepSync blocks the current thread for `ms` milliseconds — fine
  // inside a one-shot CLI importer where blocking the event loop briefly
  // is preferable to restructuring the whole call chain as async.
  Bun.sleepSync(ms);
}
