/**
 * Review-UI ACB storage adapter.
 *
 * Thin wrapper around `@claude-prove/cli`'s `AcbStore` (which is itself
 * backed by `@claude-prove/store` over `bun:sqlite`). The exports here
 * preserve the exact function names, signatures, and return shapes the
 * server routes consumed before phase 11, so swapping sqlite backends
 * costs zero changes under `server/src/routes/`.
 *
 * Open/close policy: every exported function opens a short-lived AcbStore,
 * does its one operation, and closes it — mirrors the legacy open-on-each-
 * call lifecycle. Migrations run on every open, but the `_migrations_log`
 * table makes subsequent opens cheap no-ops.
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
function openStore(repoRoot: string): AcbStore {
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
function openStoreIfExists(repoRoot: string): AcbStore | null {
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

export function getManifestForCommit(repoRoot: string, sha: string): IntentManifest | null {
  const acb = openStoreIfExists(repoRoot);
  if (!acb) return null;
  try {
    const rows = acb.getStore().all<ManifestRow>(
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

export function listManifestsForBranches(repoRoot: string, branches: string[]): IntentManifest[] {
  if (branches.length === 0) return [];
  const acb = openStoreIfExists(repoRoot);
  if (!acb) return [];
  try {
    const placeholders = branches.map(() => '?').join(',');
    const rows = acb.getStore().all<ManifestRow>(
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
export function listManifestsForCommits(repoRoot: string, shas: string[]): IntentManifest[] {
  if (shas.length === 0) return [];
  const acb = openStoreIfExists(repoRoot);
  if (!acb) return [];
  try {
    const placeholders = shas.map(() => '?').join(',');
    const rows = acb.getStore().all<ManifestRow>(
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
export function listManifestsForSlug(repoRoot: string, slug: string): IntentManifest[] {
  const acb = openStoreIfExists(repoRoot);
  if (!acb) return [];
  try {
    const rows = acb.getStore().all<ManifestRow>(
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

export function listManifestsForBranch(repoRoot: string, branch: string): IntentManifest[] {
  const acb = openStoreIfExists(repoRoot);
  if (!acb) return [];
  try {
    const rows = acb.getStore().all<ManifestRow>(
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

export function getAcbDocument(repoRoot: string, branch: string): AcbDocument | null {
  const acb = openStoreIfExists(repoRoot);
  if (!acb) return null;
  try {
    const rows = acb.getStore().all<{
      branch: string;
      data: string;
      created_at: string;
      updated_at: string;
    }>(
      'SELECT branch, data, created_at, updated_at FROM acb_acb_documents WHERE branch = ?',
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

export function listVerdicts(repoRoot: string, slug: string): GroupVerdictRecord[] {
  const acb = openStore(repoRoot);
  try {
    return acb.listGroupVerdicts(slug);
  } finally {
    acb.close();
  }
}

export function upsertVerdict(
  repoRoot: string,
  slug: string,
  groupId: string,
  verdict: GroupVerdict,
  note: string | null,
  fixPrompt: string | null,
): GroupVerdictRecord {
  const acb = openStore(repoRoot);
  try {
    return acb.upsertGroupVerdict(slug, groupId, verdict, note, fixPrompt);
  } finally {
    acb.close();
  }
}

export function clearVerdict(repoRoot: string, slug: string, groupId: string): void {
  const acb = openStore(repoRoot);
  try {
    acb.clearGroupVerdict(slug, groupId);
  } finally {
    acb.close();
  }
}
