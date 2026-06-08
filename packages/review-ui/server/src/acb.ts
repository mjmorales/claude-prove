/**
 * Review-UI ACB storage adapter.
 *
 * Thin wrapper around `@claude-prove/cli`'s `AcbStore` (which is itself
 * backed by `@claude-prove/store` over the `@tursodatabase/database` async
 * driver). The exports here preserve the exact function names, argument
 * shapes, and return values the server routes consume — only the result is
 * now a Promise — so the routes await them but otherwise stay unchanged.
 *
 * Open/close policy: every exported function opens a short-lived AcbStore,
 * does its one operation, and closes it. The driver is async, so every store
 * read MUST be awaited BEFORE `close()`: the close finalizes prepared
 * statements, and an un-awaited query that resolves after the close throws
 * "statement has been finalized". Migrations run on every open, but the
 * `_migrations_log` table makes subsequent opens cheap no-ops.
 */

import path from 'node:path';
import fs from 'node:fs';
import {
  AcbStore,
  type GroupVerdict,
  type GroupVerdictRecord,
  openAcbStore,
} from '@claude-prove/cli/acb/store';

export type IntentManifest = {
  commitSha: string;
  branch: string;
  timestamp: string;
  data: unknown;
  createdAt: string;
};

export type AcbDocument = {
  branch: string;
  data: unknown;
  createdAt: string;
  updatedAt: string;
};

export type { GroupVerdict, GroupVerdictRecord };

function dbPath(repoRoot: string): string {
  return path.join(repoRoot, '.prove/prove.db');
}

/**
 * Open a writable AcbStore rooted at `repoRoot/.prove/prove.db`. Runs every
 * pending acb migration on first open. Ensures the parent directory exists
 * (matches pre-swap behavior of `openWritableDb`).
 */
async function openStore(repoRoot: string): Promise<AcbStore> {
  const p = dbPath(repoRoot);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return openAcbStore({ override: p });
}

/**
 * Open an AcbStore if the db file exists; return null otherwise. Matches
 * the previous `openDb` semantics where read-only callers short-circuit
 * for missing dbs rather than auto-creating one.
 *
 * Note: we still run migrations on open so the schema matches the reader's
 * expectations. `runMigrations` is a no-op when the log is already current.
 */
async function openStoreIfExists(repoRoot: string): Promise<AcbStore | null> {
  const p = dbPath(repoRoot);
  if (!fs.existsSync(p)) return null;
  return openAcbStore({ override: p });
}

type ManifestRow = {
  branch: string;
  commit_sha: string;
  timestamp: string;
  data: string;
  created_at: string;
};

function rowToManifest(row: ManifestRow): IntentManifest {
  return {
    branch: row.branch,
    commitSha: row.commit_sha,
    timestamp: row.timestamp,
    data: safeParse(row.data),
    createdAt: row.created_at,
  };
}

export async function getManifestForCommit(
  repoRoot: string,
  sha: string,
): Promise<IntentManifest | null> {
  const acb = await openStoreIfExists(repoRoot);
  if (!acb) return null;
  try {
    const rows = await acb.getStore().all<ManifestRow>(
      `SELECT branch, commit_sha, timestamp, data, created_at
       FROM acb_manifests
       WHERE commit_sha LIKE ? || '%'
       ORDER BY id DESC
       LIMIT 1`,
      [sha],
    );
    const row = rows[0];
    return row ? rowToManifest(row) : null;
  } finally {
    acb.close();
  }
}

export async function listManifestsForBranches(
  repoRoot: string,
  branches: string[],
): Promise<IntentManifest[]> {
  if (branches.length === 0) return [];
  const acb = await openStoreIfExists(repoRoot);
  if (!acb) return [];
  try {
    const placeholders = branches.map(() => '?').join(',');
    const rows = await acb.getStore().all<ManifestRow>(
      `SELECT branch, commit_sha, timestamp, data, created_at
       FROM acb_manifests
       WHERE branch IN (${placeholders})
       ORDER BY id ASC`,
      branches,
    );
    return rows.map(rowToManifest);
  } finally {
    acb.close();
  }
}

/**
 * Look up manifests by exact commit SHA. Unlike `listManifestsForBranches`,
 * this survives branch deletion — after a merged full-auto run the task
 * branches are gone but their manifests are still keyed by SHA and the
 * commits themselves remain reachable via the orchestrator branch.
 */
export async function listManifestsForCommits(
  repoRoot: string,
  shas: string[],
): Promise<IntentManifest[]> {
  if (shas.length === 0) return [];
  const acb = await openStoreIfExists(repoRoot);
  if (!acb) return [];
  try {
    const placeholders = shas.map(() => '?').join(',');
    const rows = await acb.getStore().all<ManifestRow>(
      `SELECT branch, commit_sha, timestamp, data, created_at
       FROM acb_manifests
       WHERE commit_sha IN (${placeholders})
       ORDER BY id ASC`,
      shas,
    );
    return rows.map(rowToManifest);
  } finally {
    acb.close();
  }
}

/**
 * List every manifest that belongs to a given run slug, regardless of whether
 * the originating branch still exists. Covers both branch naming conventions
 * prove uses: `orchestrator/<slug>` and `task/<slug>/<task-id>`. Useful for
 * merged runs whose task branches have been deleted.
 */
export async function listManifestsForSlug(
  repoRoot: string,
  slug: string,
): Promise<IntentManifest[]> {
  const acb = await openStoreIfExists(repoRoot);
  if (!acb) return [];
  try {
    const rows = await acb.getStore().all<ManifestRow>(
      `SELECT branch, commit_sha, timestamp, data, created_at
       FROM acb_manifests
       WHERE branch = ? OR branch LIKE ?
       ORDER BY id ASC`,
      [`orchestrator/${slug}`, `task/${slug}/%`],
    );
    return rows.map(rowToManifest);
  } finally {
    acb.close();
  }
}

export async function listManifestsForBranch(
  repoRoot: string,
  branch: string,
): Promise<IntentManifest[]> {
  const acb = await openStoreIfExists(repoRoot);
  if (!acb) return [];
  try {
    const rows = await acb.getStore().all<ManifestRow>(
      `SELECT branch, commit_sha, timestamp, data, created_at
       FROM acb_manifests
       WHERE branch = ?
       ORDER BY id ASC`,
      [branch],
    );
    return rows.map(rowToManifest);
  } finally {
    acb.close();
  }
}

export async function getAcbDocument(
  repoRoot: string,
  branch: string,
): Promise<AcbDocument | null> {
  const acb = await openStoreIfExists(repoRoot);
  if (!acb) return null;
  try {
    // Read the head view, not the base table: `acb_acb_documents` is an
    // append-only revision log, so the view returns the single latest revision
    // per branch (with `created_at` = the branch's first revision and
    // `updated_at` = the latest), preserving this function's return shape.
    const rows = await acb.getStore().all<{
      branch: string;
      data: string;
      created_at: string;
      updated_at: string;
    }>(
      'SELECT branch, data, created_at, updated_at FROM acb_acb_documents_head WHERE branch = ?',
      [branch],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      branch: row.branch,
      data: safeParse(row.data),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  } finally {
    acb.close();
  }
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

export async function listVerdicts(repoRoot: string, slug: string): Promise<GroupVerdictRecord[]> {
  const acb = await openStore(repoRoot);
  try {
    // Await BEFORE close: returning the un-awaited promise would let the query
    // resolve after `close()` finalizes the statement, throwing "statement has
    // been finalized".
    return await acb.listGroupVerdicts(slug);
  } finally {
    acb.close();
  }
}

export async function upsertVerdict(
  repoRoot: string,
  slug: string,
  groupId: string,
  verdict: GroupVerdict,
  note: string | null,
  fixPrompt: string | null,
): Promise<GroupVerdictRecord> {
  const acb = await openStore(repoRoot);
  try {
    return await acb.upsertGroupVerdict(slug, groupId, verdict, note, fixPrompt);
  } finally {
    acb.close();
  }
}

export async function clearVerdict(
  repoRoot: string,
  slug: string,
  groupId: string,
): Promise<void> {
  const acb = await openStore(repoRoot);
  try {
    await acb.clearGroupVerdict(slug, groupId);
  } finally {
    acb.close();
  }
}
