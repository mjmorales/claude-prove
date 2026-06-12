import { type Store, withTx } from './connection';
import { getMigrations, listDomains } from './registry';

export interface AppliedMigration {
  domain: string;
  version: number;
  description: string;
}

export interface DomainSnapshot {
  domain: string;
  /** Highest version successfully applied for this domain (0 if none). */
  version: number;
}

export interface MigrationResult {
  applied: AppliedMigration[];
  alreadyUpToDate: DomainSnapshot[];
}

/**
 * Thrown when a domain's migration batch fails. Migrations are all-or-nothing
 * within a domain (the failing batch rolls back) but committed across domains:
 * if domain A lands and domain B then throws, A's migrations stay durably
 * applied. `partial` carries the migrations that committed before the failure
 * so a caller can report exactly which domains landed.
 */
export class MigrationError extends Error {
  readonly partial: MigrationResult;
  constructor(message: string, partial: MigrationResult, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MigrationError';
    this.partial = partial;
  }
}

const MIGRATIONS_LOG_SQL = `
  CREATE TABLE IF NOT EXISTS _migrations_log (
    domain TEXT NOT NULL,
    version INTEGER NOT NULL,
    description TEXT NOT NULL,
    applied_at TEXT NOT NULL,
    PRIMARY KEY (domain, version)
  )
`;

/**
 * Run every pending migration from the registered schemas against the
 * given store. The `_migrations_log` table is created if missing. Each
 * domain's pending migrations apply in ascending version order inside a
 * single transaction (rollback-safe if any step throws).
 *
 * Returns a structured result partitioning domains into `applied` (new
 * versions landed this run) and `alreadyUpToDate` (domain + max version
 * that was already recorded).
 *
 * Domains migrate independently and commit as they finish, so a later domain
 * throwing does NOT roll back earlier domains. On such a partial failure this
 * throws a `MigrationError` whose `partial` field reports the migrations that
 * already committed (the local `result` is otherwise lost with the throw).
 */
export async function runMigrations(store: Store): Promise<MigrationResult> {
  await store.run(MIGRATIONS_LOG_SQL);

  const result: MigrationResult = { applied: [], alreadyUpToDate: [] };

  for (const domain of listDomains()) {
    const rows = await store.all<{ version: number }>(
      'SELECT version FROM _migrations_log WHERE domain = ?',
      [domain],
    );
    const appliedVersions = new Set(rows.map((r) => r.version));
    const pending = getMigrations(domain).filter((m) => !appliedVersions.has(m.version));

    if (pending.length === 0) {
      const maxApplied = appliedVersions.size === 0 ? 0 : Math.max(...appliedVersions);
      result.alreadyUpToDate.push({ domain, version: maxApplied });
      continue;
    }

    // Snapshot the applied count before this domain's batch so a rolled-back
    // batch leaves no phantom entries in the reported partial result.
    const appliedBeforeDomain = result.applied.length;
    try {
      await withTx(store, async () => {
        for (const m of pending) {
          await m.up(store);
          await store.run(
            'INSERT INTO _migrations_log (domain, version, description, applied_at) VALUES (?, ?, ?, ?)',
            [domain, m.version, m.description, new Date().toISOString()],
          );
          result.applied.push({ domain, version: m.version, description: m.description });
        }
      });
    } catch (err) {
      // The failing batch rolled back; drop its phantom entries, then surface
      // the migrations that earlier domains durably committed.
      result.applied.length = appliedBeforeDomain;
      throw new MigrationError(
        `migration failed for domain '${domain}': ${err instanceof Error ? err.message : String(err)}`,
        result,
        { cause: err },
      );
    }
  }

  return result;
}

/**
 * Drop every domain table and view plus the migrations log itself. Intended
 * for `claude-prove store reset --confirm`; production code should never call
 * this implicitly.
 *
 * Views are dropped alongside tables: the base DDL creates views with bare
 * `CREATE VIEW`, so a leftover view would collide on the next migration.
 *
 * Foreign-key enforcement is suspended for the duration of the drop. The
 * tables form an FK graph (self-references, cross-domain pointers), and
 * `sqlite_master` yields them in arbitrary order — dropping a referenced
 * table before its referrer trips an immediate FK violation. The PRAGMA is a
 * no-op inside an open transaction, so it brackets the `withTx` rather than
 * living inside it.
 */
export async function dropAllDomainTables(store: Store): Promise<void> {
  // Log might not exist if reset runs on a never-migrated db.
  await store.run(MIGRATIONS_LOG_SQL);
  const views = await store.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'view'",
  );
  const tables = await store.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '_migrations_log'",
  );
  await store.exec('PRAGMA foreign_keys = OFF');
  try {
    await withTx(store, async () => {
      for (const row of views) {
        await store.run(`DROP VIEW IF EXISTS ${escapeIdent(row.name)}`);
      }
      for (const row of tables) {
        await store.run(`DROP TABLE IF EXISTS ${escapeIdent(row.name)}`);
      }
      await store.run('DROP TABLE IF EXISTS _migrations_log');
    });
  } finally {
    await store.exec('PRAGMA foreign_keys = ON');
  }
}

function escapeIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`refusing to drop suspicious table name: ${name}`);
  }
  return `"${name}"`;
}
