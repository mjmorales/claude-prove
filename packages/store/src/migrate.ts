import type { Store } from './connection';
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
 */
export function runMigrations(store: Store): MigrationResult {
  const db = store.getDb();
  db.run(MIGRATIONS_LOG_SQL);

  const result: MigrationResult = { applied: [], alreadyUpToDate: [] };

  for (const domain of listDomains()) {
    const rows = store.all<{ version: number }>(
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

    const tx = db.transaction(() => {
      for (const m of pending) {
        m.up(db);
        store.run(
          'INSERT INTO _migrations_log (domain, version, description, applied_at) VALUES (?, ?, ?, ?)',
          [domain, m.version, m.description, new Date().toISOString()],
        );
        result.applied.push({ domain, version: m.version, description: m.description });
      }
    });
    tx();
  }

  return result;
}

/**
 * Drop every domain table listed in `_migrations_log` plus the log
 * itself. Intended for `claude-prove store reset --confirm`; production code
 * should never call this implicitly.
 */
export function dropAllDomainTables(store: Store): void {
  const db = store.getDb();
  // Log might not exist if reset runs on a never-migrated db.
  db.run(MIGRATIONS_LOG_SQL);
  const tables = store.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '_migrations_log'",
  );
  const tx = db.transaction(() => {
    for (const row of tables) {
      db.run(`DROP TABLE IF EXISTS ${escapeIdent(row.name)}`);
    }
    db.run('DROP TABLE IF EXISTS _migrations_log');
  });
  tx();
}

function escapeIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`refusing to drop suspicious table name: ${name}`);
  }
  return `"${name}"`;
}
