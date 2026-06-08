/**
 * ACB v2.1 unified-store topic module.
 *
 * Registers the `acb` domain with `@claude-prove/store` via `registerSchema`.
 * On-disk layout is the unified prove store (`.prove/prove.db`, shared across
 * domains).
 *
 * Table-name convention: all domain tables carry the `acb_` prefix (the
 * schema-namespacing convention shared across domains) — hence
 * `acb_manifests`, `acb_acb_documents`, `acb_review_state`.
 *
 * Design notes:
 *   - Side-effect `registerSchema` at import time mirrors the
 *     decision-record protocol so any import of this module declares the
 *     acb schema to the store registry.
 *   - `openAcbStore` wraps `openStore` + `runMigrations` to give ACB
 *     consumers a one-call entry point.
 *   - The `AcbStore` class exposes camelCase methods: saveManifest returns
 *     the new row's ULID id as `string`; load* returns `unknown | null`;
 *     cleanBranch returns per-table deletion counts keyed by the acb-prefixed
 *     table names.
 */

import {
  type GroupVerdict,
  type GroupVerdictRecord,
  type Store,
  type StoreOptions,
  VERDICT_VALUES,
  assertStoreSchemaCompatible,
  listDomains,
  openStore,
  registerSchema,
  runMigrations,
  ulid,
  upsertGroupVerdict,
} from '@claude-prove/store';

// Re-export the canonical verdict vocabulary so existing
// `@claude-prove/cli/acb/store` importers (the review-ui server) keep their
// import site while the definitions single-source in `@claude-prove/store`.
export {
  type GroupVerdict,
  type GroupVerdictRecord,
  type VerdictValue,
  VERDICT_VALUES,
} from '@claude-prove/store';

// ---------------------------------------------------------------------------
// Schema registration
// ---------------------------------------------------------------------------

/**
 * ACB v1 schema — one fresh, sync-safe DDL. Every table the acb domain owns,
 * with NO AUTOINCREMENT: the three branch-keyed tables mint a ULID TEXT id at
 * insert (the manifest log is append-only; documents/review_state are keyed by
 * a UNIQUE branch and upserted), and `acb_group_verdicts` keeps its natural
 * composite PK `(slug, group_id)`. Distinct ULID/natural keys both survive
 * whole-transaction sync replay where a shared rowid sequence would lose a row.
 *
 * Verdict values are written canonical at the source (the `upsertGroupVerdict`
 * write-service), and `coerceLegacyVerdict` normalizes any legacy string read
 * from a hand-edited row — so no in-chain UPDATE migration is needed.
 */
const ACB_MIGRATION_V1_SQL = `
CREATE TABLE acb_manifests (
    id TEXT PRIMARY KEY,
    branch TEXT NOT NULL,
    commit_sha TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL,
    run_slug TEXT
);

CREATE TABLE acb_acb_documents (
    id TEXT PRIMARY KEY,
    branch TEXT NOT NULL UNIQUE,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE acb_review_state (
    id TEXT PRIMARY KEY,
    branch TEXT NOT NULL UNIQUE,
    acb_hash TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE acb_group_verdicts (
    slug        TEXT NOT NULL,
    group_id    TEXT NOT NULL,
    verdict     TEXT NOT NULL,
    note        TEXT,
    fix_prompt  TEXT,
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (slug, group_id)
);

CREATE INDEX idx_acb_manifests_branch ON acb_manifests(branch);
CREATE INDEX idx_acb_manifests_branch_sha ON acb_manifests(branch, commit_sha);
CREATE INDEX idx_acb_manifests_run_slug ON acb_manifests(run_slug, branch);
CREATE INDEX idx_acb_group_verdicts_slug ON acb_group_verdicts(slug);
`;

/**
 * Idempotent acb-domain registration. Safe to call from module side-effect
 * AND from tests that have hit `clearRegistry()` — both paths land a single
 * acb/v1 entry. The guard exists because other test files in the same
 * `bun test` process wipe the registry between tests, and bun shares module
 * cache across files, so a module-scoped `registerSchema` runs only once per
 * process and cannot recover after a wipe.
 */
export function ensureAcbSchemaRegistered(): void {
  if (listDomains().includes('acb')) return;
  registerSchema({
    domain: 'acb',
    migrations: [
      {
        version: 1,
        description: 'create the redesigned sync-safe acb schema (ULID/composite PKs, no rowid)',
        up: async (store) => {
          await store.exec(ACB_MIGRATION_V1_SQL);
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
 * Allow-list of every acb-domain table the store manages. `deleteBranchRows`
 * checks incoming table names against this set before interpolating them
 * into SQL — table identifiers can't be parameterized in SQLite, so this
 * closes the latent injection path that naked string concatenation opens.
 * Keep in sync with the acb migrations above.
 */
const ACB_TABLES = new Set<string>([
  'acb_manifests',
  'acb_acb_documents',
  'acb_review_state',
  'acb_group_verdicts',
]);

/**
 * Normalize a verdict string read from the DB to canonical `VerdictValue`.
 * Handles legacy values (`'approved'` → `'accepted'`, `'discuss'` →
 * `'needs_discussion'`) written by legacy review-UI builds.
 *
 * Out-of-vocabulary strings — a corrupt row, a hand-edited DB, or a future
 * value not yet known to this build — are NOT asserted through to the
 * canonical type (which would launder them past `VERDICT_VALUES`, the single
 * source of truth, and propagate to every reader and the review-UI read
 * path verbatim). Instead they degrade to the safe `'pending'` fallback,
 * which keeps the record renderable without claiming a verdict was reached.
 *
 * The redesigned schema has no in-chain verdict-normalization migration, so
 * canonicalization lives entirely here on the read path: a legacy value
 * hand-written into the table is normalized the moment it is read back.
 */
export function coerceLegacyVerdict(raw: string): GroupVerdict {
  switch (raw) {
    case 'approved':
      return 'accepted';
    case 'discuss':
      return 'needs_discussion';
    default:
      // `VERDICT_VALUES` is the canonical vocabulary; anything outside it is
      // an unknown/corrupt value rather than a verdict we can trust.
      if ((VERDICT_VALUES as readonly string[]).includes(raw)) {
        return raw as GroupVerdict;
      }
      console.warn(`acb: unknown verdict '${raw}' read from DB; coercing to 'pending'`);
      return 'pending';
  }
}

/**
 * Open an ACB store: resolves the unified prove.db, runs every pending
 * migration (acb included), and returns the wrapped `AcbStore`.
 *
 * Pass `{ path: ':memory:' }` in tests for isolation; this skips WAL
 * pragmas but still honors the migration registry.
 */
export async function openAcbStore(opts: StoreOptions = {}): Promise<AcbStore> {
  ensureAcbSchemaRegistered();
  const store = await openStore(opts);
  // Refuse a write-open against a legacy (pre-Turso-v1) or ahead store BEFORE
  // running migrations, so an incompatible store is never silently migrated or
  // written. A readonly open skips the guard.
  if (!opts.readonly) {
    try {
      await assertStoreSchemaCompatible(store);
    } catch (err) {
      store.close();
      throw err;
    }
  }
  await runMigrations(store);
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
   * Insert a manifest row. Returns the new row's ULID `id` — a collision-free
   * TEXT id the minting writer decides, so two manifests written under
   * whole-transaction sync replay never clobber on a shared rowid.
   *
   * The stored timestamp defaults to `data.timestamp` when present and
   * falls back to now(), so manifests order deterministically in
   * `listManifests`.
   */
  async saveManifest(
    branch: string,
    commitSha: string,
    data: unknown,
    runSlug?: string,
  ): Promise<string> {
    const ts = extractTimestamp(data) ?? isoNow();
    const id = ulid();
    await this.store.run(
      'INSERT INTO acb_manifests (id, branch, commit_sha, timestamp, data, created_at, run_slug) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, branch, commitSha, ts, JSON.stringify(data), isoNow(), runSlug ?? null],
    );
    return id;
  }

  /** Any manifest row for `branch`? */
  async hasManifest(branch: string): Promise<boolean> {
    const rows = await this.store.all<{ one: number }>(
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
  async hasManifestForSha(commitSha: string, runSlug?: string): Promise<boolean> {
    if (runSlug === undefined) {
      const rows = await this.store.all<{ one: number }>(
        "SELECT 1 AS one FROM acb_manifests WHERE commit_sha LIKE ? || '%' LIMIT 1",
        [commitSha],
      );
      return rows.length > 0;
    }
    const rows = await this.store.all<{ one: number }>(
      "SELECT 1 AS one FROM acb_manifests WHERE commit_sha LIKE ? || '%' AND run_slug = ? LIMIT 1",
      [commitSha, runSlug],
    );
    return rows.length > 0;
  }

  /** Manifests tagged with `runSlug`, ordered by timestamp ASC. */
  async listManifestsByRun(runSlug: string): Promise<unknown[]> {
    const rows = await this.store.all<{ data: string }>(
      'SELECT data FROM acb_manifests WHERE run_slug = ? ORDER BY timestamp ASC',
      [runSlug],
    );
    return rows.map((r) => JSON.parse(r.data) as unknown);
  }

  /** Manifests for `branch`, ordered by timestamp ASC. */
  async listManifests(branch: string): Promise<unknown[]> {
    const rows = await this.store.all<{ data: string }>(
      'SELECT data FROM acb_manifests WHERE branch = ? ORDER BY timestamp ASC',
      [branch],
    );
    return rows.map((r) => JSON.parse(r.data) as unknown);
  }

  /** Delete every manifest for `branch`; returns the deletion count. */
  async clearManifests(branch: string): Promise<number> {
    const stmt = await this.store.getDb().prepare('DELETE FROM acb_manifests WHERE branch = ?');
    const result = await stmt.run(branch);
    return Number(result.changes);
  }

  /**
   * Delete manifests for every branch *other than* `keepBranch`. The
   * negation is load-bearing for wave cleanup — pinned by an explicit
   * regression test.
   */
  async clearStaleManifests(keepBranch: string): Promise<number> {
    const stmt = await this.store.getDb().prepare('DELETE FROM acb_manifests WHERE branch != ?');
    const result = await stmt.run(keepBranch);
    return Number(result.changes);
  }

  // -- ACB Documents ------------------------------------------------------

  /** Upsert an ACB document keyed on `branch` (UNIQUE). Bumps `updated_at`. */
  async saveAcb(branch: string, data: unknown): Promise<void> {
    const now = isoNow();
    // The ULID id is consumed only on the INSERT arm — an UPDATE-arm conflict
    // keeps the existing row's id (the branch is the stable identity).
    await this.store.run(
      'INSERT INTO acb_acb_documents (id, branch, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(branch) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at',
      [ulid(), branch, JSON.stringify(data), now, now],
    );
  }

  /** Load the ACB document for `branch`, or null. */
  async loadAcb(branch: string): Promise<unknown | null> {
    const rows = await this.store.all<{ data: string }>(
      'SELECT data FROM acb_acb_documents WHERE branch = ?',
      [branch],
    );
    const [row] = rows;
    if (!row) return null;
    return JSON.parse(row.data) as unknown;
  }

  /** Branch with the most-recently updated ACB document, or null. */
  async latestAcbBranch(): Promise<string | null> {
    const rows = await this.store.all<{ branch: string }>(
      'SELECT branch FROM acb_acb_documents ORDER BY updated_at DESC LIMIT 1',
    );
    const [row] = rows;
    return row ? row.branch : null;
  }

  // -- Review State -------------------------------------------------------

  /** Upsert review state keyed on `branch` (UNIQUE). Bumps `updated_at`. */
  async saveReview(branch: string, acbHash: string, data: unknown): Promise<void> {
    const now = isoNow();
    // The ULID id is consumed only on the INSERT arm — an UPDATE-arm conflict
    // keeps the existing row's id (the branch is the stable identity).
    await this.store.run(
      'INSERT INTO acb_review_state (id, branch, acb_hash, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(branch) DO UPDATE SET acb_hash = excluded.acb_hash, data = excluded.data, updated_at = excluded.updated_at',
      [ulid(), branch, acbHash, JSON.stringify(data), now, now],
    );
  }

  /** Load review state for `branch`, or null. */
  async loadReview(branch: string): Promise<unknown | null> {
    const rows = await this.store.all<{ data: string }>(
      'SELECT data FROM acb_review_state WHERE branch = ?',
      [branch],
    );
    const [row] = rows;
    if (!row) return null;
    return JSON.parse(row.data) as unknown;
  }

  // -- Group Verdicts -----------------------------------------------------

  /** List every verdict recorded for `slug`. Order is insertion-defined. */
  async listGroupVerdicts(slug: string): Promise<GroupVerdictRecord[]> {
    const rows = await this.store.all<{
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
      verdict: coerceLegacyVerdict(r.verdict),
      note: r.note,
      fixPrompt: r.fix_prompt,
      updatedAt: r.updated_at,
    }));
  }

  /**
   * Upsert a verdict on `(slug, groupId)`. Bumps `updated_at` to now().
   *
   * Thin delegate to the `@claude-prove/store` write-service so the upsert SQL
   * and the `updated_at` stamp live in exactly one place across every caller.
   */
  async upsertGroupVerdict(
    slug: string,
    groupId: string,
    verdict: GroupVerdict,
    note: string | null,
    fixPrompt: string | null,
  ): Promise<GroupVerdictRecord> {
    return upsertGroupVerdict(this.store, slug, groupId, verdict, note, fixPrompt);
  }

  /** Delete the `(slug, groupId)` verdict row. No-op if absent. */
  async clearGroupVerdict(slug: string, groupId: string): Promise<void> {
    await this.store.run('DELETE FROM acb_group_verdicts WHERE slug = ? AND group_id = ?', [
      slug,
      groupId,
    ]);
  }

  /**
   * Delete all verdict rows for `slug`. Call this from the slug-retirement
   * path (wave cleanup, run teardown) rather than relying on branch cleanup —
   * `acb_group_verdicts` has no `branch` column (it is keyed by `(slug,
   * group_id)`), so branch-scoped deletion is structurally inapplicable.
   * Returns the number of rows deleted.
   */
  async clearVerdictsForSlug(slug: string): Promise<number> {
    const stmt = await this.store.getDb().prepare('DELETE FROM acb_group_verdicts WHERE slug = ?');
    const result = await stmt.run(slug);
    return Number(result.changes);
  }

  // -- Cleanup ------------------------------------------------------------

  /**
   * Delete every row for `branch` across the three branch-keyed acb_* tables:
   * `acb_manifests`, `acb_acb_documents`, and `acb_review_state`.
   * Returned counts are keyed by the acb-prefixed table names.
   *
   * `acb_group_verdicts` is intentionally excluded: it has no `branch` column
   * and cannot be branch-scoped. Verdict GC is slug-scoped via
   * `clearVerdictsForSlug`, which the caller must invoke separately when
   * retiring a slug.
   */
  async cleanBranch(branch: string): Promise<CleanBranchCounts> {
    return {
      acb_manifests: await this.deleteBranchRows('acb_manifests', branch),
      acb_acb_documents: await this.deleteBranchRows('acb_acb_documents', branch),
      acb_review_state: await this.deleteBranchRows('acb_review_state', branch),
    };
  }

  /**
   * Sorted unique branch names across the three branch-keyed acb_* tables:
   * `acb_manifests`, `acb_acb_documents`, and `acb_review_state`.
   *
   * `acb_group_verdicts` is intentionally excluded: it has no `branch` column
   * and cannot contribute a branch-based enumeration.
   */
  async branches(): Promise<string[]> {
    const tables = ['acb_manifests', 'acb_acb_documents', 'acb_review_state'] as const;
    const seen = new Set<string>();
    for (const table of tables) {
      const rows = await this.store.all<{ branch: string }>(`SELECT DISTINCT branch FROM ${table}`);
      for (const r of rows) seen.add(r.branch);
    }
    return [...seen].sort();
  }

  // -- Internals ----------------------------------------------------------

  /**
   * Execute `DELETE FROM <table> WHERE branch = ?` and return changes.
   * `table` must be a member of `ACB_TABLES`; this constraint defeats any
   * future refactor that might route user-derived strings into this path
   * (SQLite does not allow parameterizing table identifiers, so the name
   * has to be interpolated).
   */
  private async deleteBranchRows(table: string, branch: string): Promise<number> {
    if (!ACB_TABLES.has(table)) {
      throw new Error(`deleteBranchRows: unknown acb table "${table}"`);
    }
    const stmt = await this.store.getDb().prepare(`DELETE FROM ${table} WHERE branch = ?`);
    const result = await stmt.run(branch);
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
