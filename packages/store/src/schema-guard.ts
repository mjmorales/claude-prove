import type { Store } from './connection';
import { getMigrations, listDomains } from './registry';

/**
 * Thrown when an open-for-write is refused because the store's schema identity
 * is incompatible with this binary — either a legacy pre-v1 store that predates
 * the sync-safe Turso schema, or a same-lineage store migrated AHEAD of what
 * this binary knows. The guard refuses rather than silently migrating or
 * corrupting: a write against a schema the binary cannot reason about would
 * land rows the running code's queries do not expect.
 */
export class SchemaIncompatibleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaIncompatibleError';
  }
}

/**
 * The clean Turso v1 schema collapsed each domain's migration chain to a single
 * v1 hop. A store that carries a HIGHER recorded version for a registered
 * domain in `_migrations_log` predates the reset — it was migrated under the
 * old incremental lineage (e.g. scrum v28) — so an integer comparison across
 * the reset is meaningless and the store is structurally incompatible. The
 * `_migrations_log` max version per domain is the legacy marker.
 */
const TURSO_V1_MAX_VERSION = 1;

interface LoggedDomainVersion {
  domain: string;
  maxVersion: number;
}

/**
 * Read the highest applied migration version per domain from `_migrations_log`.
 * Returns an empty list when the log table does not exist yet (a never-migrated
 * store), which is NOT a legacy store — it has no lineage to be incompatible
 * with.
 */
async function readLoggedVersions(store: Store): Promise<LoggedDomainVersion[]> {
  const logExists = await store.get<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_migrations_log'",
  );
  if (!logExists) return [];
  return await store.all<LoggedDomainVersion>(
    'SELECT domain, MAX(version) AS maxVersion FROM _migrations_log GROUP BY domain',
  );
}

/**
 * Guard the store's schema identity BEFORE running migrations on a write path.
 * Refuses with a clear `SchemaIncompatibleError` in two cases, leaving the
 * store untouched:
 *
 *   1. LEGACY (pre-v1): a registered domain's `_migrations_log` records a
 *      version higher than the Turso v1 reset (`> 1`). The store was migrated
 *      under the old incremental chain and the integer comparison broke at the
 *      reset — never auto-migrate it. The operator runs
 *      `claude-prove store reset --confirm` or the migrate-to-turso migrator.
 *   2. AHEAD (same lineage): a registered domain's logged version exceeds the
 *      highest version this binary registers for that domain — a store written
 *      by a newer binary. Refuse the write so an old binary never lands rows
 *      against a schema it does not understand.
 *
 * A never-migrated store (no `_migrations_log`) and a clean v1 store both pass.
 */
export async function assertStoreSchemaCompatible(store: Store): Promise<void> {
  const logged = await readLoggedVersions(store);
  if (logged.length === 0) return;

  const registered = new Set(listDomains());

  for (const { domain, maxVersion } of logged) {
    // Only domains this binary knows can be reasoned about; an unknown domain
    // in the log is another tool's table and is not this guard's concern.
    if (!registered.has(domain)) continue;

    if (maxVersion > TURSO_V1_MAX_VERSION) {
      const detail = `domain '${domain}' at version ${maxVersion}, but this binary's base schema is v${TURSO_V1_MAX_VERSION}`;
      const remedy =
        'the legacy lineage is incompatible and is never auto-migrated. Run `claude-prove store reset --confirm` or the migrate-to-turso migrator.';
      throw new SchemaIncompatibleError(
        `store predates the Turso v1 schema (${detail}); ${remedy}`,
      );
    }

    const binaryMax = maxRegisteredVersion(domain);
    if (maxVersion > binaryMax) {
      const detail = `domain '${domain}' at version ${maxVersion}, binary knows up to v${binaryMax}`;
      throw new SchemaIncompatibleError(
        `store is ahead of this binary (${detail}); refusing to write against a schema this binary does not understand. Upgrade the binary.`,
      );
    }
  }
}

/** Highest migration version this binary registers for `domain` (0 if none). */
function maxRegisteredVersion(domain: string): number {
  const versions = getMigrations(domain).map((m) => m.version);
  return versions.length === 0 ? 0 : Math.max(...versions);
}
