import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

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

export type GroupVerdict = "pending" | "approved" | "rejected" | "discuss" | "rework";

export type GroupVerdictRecord = {
  slug: string;
  groupId: string;
  verdict: GroupVerdict;
  note: string | null;
  fixPrompt: string | null;
  updatedAt: string;
};

function dbPath(repoRoot: string): string {
  return path.join(repoRoot, ".prove/acb.db");
}

function openDb(repoRoot: string): Database.Database | null {
  const p = dbPath(repoRoot);
  if (!fs.existsSync(p)) return null;
  return new Database(p, { readonly: true, fileMustExist: true });
}

function openWritableDb(repoRoot: string): Database.Database {
  const p = dbPath(repoRoot);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new Database(p);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  return db;
}

let verdictTableReady = false;
function ensureVerdictTable(db: Database.Database): void {
  if (verdictTableReady) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS group_verdicts (
      slug        TEXT NOT NULL,
      group_id    TEXT NOT NULL,
      verdict     TEXT NOT NULL,
      note        TEXT,
      fix_prompt  TEXT,
      updated_at  TEXT NOT NULL,
      PRIMARY KEY (slug, group_id)
    );
    CREATE INDEX IF NOT EXISTS idx_group_verdicts_slug ON group_verdicts(slug);
  `);
  verdictTableReady = true;
}

export function getManifestForCommit(
  repoRoot: string,
  sha: string
): IntentManifest | null {
  const db = openDb(repoRoot);
  if (!db) return null;
  try {
    const row = db
      .prepare(
        `SELECT branch, commit_sha, timestamp, data, created_at
         FROM manifests
         WHERE commit_sha LIKE ? || '%'
         ORDER BY id DESC
         LIMIT 1`,
      )
      .get(sha) as
      | {
          branch: string;
          commit_sha: string;
          timestamp: string;
          data: string;
          created_at: string;
        }
      | undefined;
    if (!row) return null;
    return {
      branch: row.branch,
      commitSha: row.commit_sha,
      timestamp: row.timestamp,
      data: safeParse(row.data),
      createdAt: row.created_at,
    };
  } finally {
    db.close();
  }
}

export function listManifestsForBranches(
  repoRoot: string,
  branches: string[],
): IntentManifest[] {
  if (branches.length === 0) return [];
  const db = openDb(repoRoot);
  if (!db) return [];
  try {
    const placeholders = branches.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT branch, commit_sha, timestamp, data, created_at
         FROM manifests
         WHERE branch IN (${placeholders})
         ORDER BY id ASC`,
      )
      .all(...branches) as Array<{
      branch: string;
      commit_sha: string;
      timestamp: string;
      data: string;
      created_at: string;
    }>;
    return rows.map((r) => ({
      branch: r.branch,
      commitSha: r.commit_sha,
      timestamp: r.timestamp,
      data: safeParse(r.data),
      createdAt: r.created_at,
    }));
  } finally {
    db.close();
  }
}

/**
 * Look up manifests by exact commit SHA. Unlike `listManifestsForBranches`,
 * this survives branch deletion — after a merged full-auto run the task
 * branches are gone but their manifests are still keyed by SHA and the
 * commits themselves remain reachable via the orchestrator branch.
 */
export function listManifestsForCommits(
  repoRoot: string,
  shas: string[],
): IntentManifest[] {
  if (shas.length === 0) return [];
  const db = openDb(repoRoot);
  if (!db) return [];
  try {
    const placeholders = shas.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT branch, commit_sha, timestamp, data, created_at
         FROM manifests
         WHERE commit_sha IN (${placeholders})
         ORDER BY id ASC`,
      )
      .all(...shas) as Array<{
      branch: string;
      commit_sha: string;
      timestamp: string;
      data: string;
      created_at: string;
    }>;
    return rows.map((r) => ({
      branch: r.branch,
      commitSha: r.commit_sha,
      timestamp: r.timestamp,
      data: safeParse(r.data),
      createdAt: r.created_at,
    }));
  } finally {
    db.close();
  }
}

/**
 * List every manifest that belongs to a given run slug, regardless of whether
 * the originating branch still exists. Covers both branch naming conventions
 * prove uses: `orchestrator/<slug>` and `task/<slug>/<task-id>`. Useful for
 * merged runs whose task branches have been deleted.
 */
export function listManifestsForSlug(
  repoRoot: string,
  slug: string,
): IntentManifest[] {
  const db = openDb(repoRoot);
  if (!db) return [];
  try {
    const rows = db
      .prepare(
        `SELECT branch, commit_sha, timestamp, data, created_at
         FROM manifests
         WHERE branch = ? OR branch LIKE ?
         ORDER BY id ASC`,
      )
      .all(`orchestrator/${slug}`, `task/${slug}/%`) as Array<{
      branch: string;
      commit_sha: string;
      timestamp: string;
      data: string;
      created_at: string;
    }>;
    return rows.map((r) => ({
      branch: r.branch,
      commitSha: r.commit_sha,
      timestamp: r.timestamp,
      data: safeParse(r.data),
      createdAt: r.created_at,
    }));
  } finally {
    db.close();
  }
}

export function listManifestsForBranch(repoRoot: string, branch: string): IntentManifest[] {
  const db = openDb(repoRoot);
  if (!db) return [];
  try {
    const rows = db
      .prepare(
        `SELECT branch, commit_sha, timestamp, data, created_at
         FROM manifests
         WHERE branch = ?
         ORDER BY id ASC`,
      )
      .all(branch) as Array<{
      branch: string;
      commit_sha: string;
      timestamp: string;
      data: string;
      created_at: string;
    }>;
    return rows.map((r) => ({
      branch: r.branch,
      commitSha: r.commit_sha,
      timestamp: r.timestamp,
      data: safeParse(r.data),
      createdAt: r.created_at,
    }));
  } finally {
    db.close();
  }
}

export function getAcbDocument(repoRoot: string, branch: string): AcbDocument | null {
  const db = openDb(repoRoot);
  if (!db) return null;
  try {
    const row = db
      .prepare(`SELECT branch, data, created_at, updated_at FROM acb_documents WHERE branch = ?`)
      .get(branch) as
      | { branch: string; data: string; created_at: string; updated_at: string }
      | undefined;
    if (!row) return null;
    return {
      branch: row.branch,
      data: safeParse(row.data),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  } finally {
    db.close();
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
  const db = openWritableDb(repoRoot);
  try {
    ensureVerdictTable(db);
    const rows = db
      .prepare(
        `SELECT slug, group_id, verdict, note, fix_prompt, updated_at
         FROM group_verdicts
         WHERE slug = ?`,
      )
      .all(slug) as Array<{
      slug: string;
      group_id: string;
      verdict: string;
      note: string | null;
      fix_prompt: string | null;
      updated_at: string;
    }>;
    return rows.map((r) => ({
      slug: r.slug,
      groupId: r.group_id,
      verdict: r.verdict as GroupVerdict,
      note: r.note,
      fixPrompt: r.fix_prompt,
      updatedAt: r.updated_at,
    }));
  } finally {
    db.close();
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
  const db = openWritableDb(repoRoot);
  try {
    ensureVerdictTable(db);
    const updatedAt = new Date().toISOString();
    db.prepare(
      `INSERT INTO group_verdicts (slug, group_id, verdict, note, fix_prompt, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(slug, group_id) DO UPDATE SET
         verdict    = excluded.verdict,
         note       = excluded.note,
         fix_prompt = excluded.fix_prompt,
         updated_at = excluded.updated_at`,
    ).run(slug, groupId, verdict, note, fixPrompt, updatedAt);
    return { slug, groupId, verdict, note, fixPrompt, updatedAt };
  } finally {
    db.close();
  }
}

export function clearVerdict(repoRoot: string, slug: string, groupId: string): void {
  const db = openWritableDb(repoRoot);
  try {
    ensureVerdictTable(db);
    db.prepare(`DELETE FROM group_verdicts WHERE slug = ? AND group_id = ?`).run(slug, groupId);
  } finally {
    db.close();
  }
}
