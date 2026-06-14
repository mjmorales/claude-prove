import type { Store } from './connection';
import { getMigrations, listDomains } from './registry';

/**
 * Thrown when an open-for-write is refused because the store's schema identity
 * is incompatible with this binary — either a legacy pre-Turso store that
 * predates the sync-safe Turso schema, or a same-lineage store migrated AHEAD
 * of what this binary knows. The guard refuses rather than silently migrating or
 * corrupting: a write against a schema the binary cannot reason about would
 * land rows the running code's queries do not expect.
 */
export class SchemaIncompatibleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaIncompatibleError';
  }
}

interface LoggedDomainVersion {
  domain: string;
  maxVersion: number;
}

/**
 * Per-domain floor that separates a LEGACY pre-Turso lineage from a same-lineage
 * AHEAD store. Both look like `logged > registeredMax`, so a raw integer compare
 * cannot tell them apart — yet they need DISTINCT remedies (a legacy store must
 * run migrate-to-turso; an ahead store must upgrade the binary). The
 * discriminator exploits the version gap the Turso reset created: the pre-Turso
 * incremental chains climbed to large maxes (scrum ~v28, acb ~v4) before the
 * reset collapsed every domain to a fresh v1, and the post-reset Turso chains
 * grow slowly (single-digit hops gated behind a deliberate schema-version bump).
 *
 * A logged version `>= floor[domain]` is therefore unambiguously the OLD lineage
 * (its number could only have come from the long pre-reset chain), so it gets
 * the legacy remedy. A logged version in `(registeredMax, floor)` is a real
 * AHEAD store — a future binary advanced the small Turso chain past what this
 * binary knows — so it gets the upgrade remedy. The floor sits comfortably above
 * each domain's realistic Turso version yet at-or-below its known legacy max:
 *
 *   - scrum: legacy chain reached v28; floor 10 leaves the Turso chain ample
 *     room (v1..v9 read as current/ahead) while every legacy v10..v28 store
 *     trips the legacy branch.
 *   - acb: legacy chain reached v4; floor 4 means a legacy v4 store is legacy,
 *     and the only ahead window is v2/v3 (a Turso acb hop a newer binary added).
 *
 * A domain with no entry here has no recorded legacy lineage, so any
 * `logged > registeredMax` is treated as AHEAD — the conservative reading, since
 * the safe failure for an unknown-lineage future version is "upgrade", not
 * "throw away and re-migrate".
 */
const LEGACY_LINEAGE_FLOOR: Record<string, number> = {
  scrum: 10,
  acb: 4,
};

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

/** Highest migration version this binary registers for `domain` (0 if none). */
function maxRegisteredVersion(domain: string): number {
  const versions = getMigrations(domain).map((m) => m.version);
  return versions.length === 0 ? 0 : Math.max(...versions);
}

/**
 * Guard the store's schema identity BEFORE running migrations on a write path.
 * For each domain this binary registers, compare the store's logged max version
 * against the binary's REGISTERED max version for that domain — NOT a hardcoded
 * constant, so a legitimate scrum v1→v2 migration (which advances the registered
 * chain) opens cleanly instead of every re-open refusing. Refuses with a clear
 * `SchemaIncompatibleError`, leaving the store untouched, in two cases:
 *
 *   1. LEGACY (pre-Turso): a registered domain's logged version sits at-or-above
 *      `LEGACY_LINEAGE_FLOOR[domain]` — a number only the long pre-reset chain
 *      could have produced. The integer comparison broke at the reset, so the
 *      store is never auto-migrated; the operator runs migrate-to-turso (or
 *      `store reset --confirm`).
 *   2. AHEAD (same lineage): a registered domain's logged version exceeds this
 *      binary's registered max but stays below the legacy floor — a store a newer
 *      binary advanced along the small Turso chain. Refuse the write so an old
 *      binary never lands rows against a schema it does not understand; the
 *      operator upgrades the binary.
 *
 * A clean store at a version `<= registeredMax` for every domain passes; a
 * never-migrated store (no `_migrations_log`) passes.
 */
export async function assertStoreSchemaCompatible(store: Store): Promise<void> {
  const logged = await readLoggedVersions(store);
  if (logged.length === 0) return;

  const registered = new Set(listDomains());

  for (const { domain, maxVersion } of logged) {
    // Only domains this binary knows can be reasoned about; an unknown domain
    // in the log is another tool's table and is not this guard's concern.
    if (!registered.has(domain)) continue;

    const binaryMax = maxRegisteredVersion(domain);
    // A store at or below what this binary registers is compatible.
    if (maxVersion <= binaryMax) continue;

    // logged > binaryMax: either a legacy pre-Turso lineage or an ahead store.
    const legacyFloor = LEGACY_LINEAGE_FLOOR[domain];
    if (legacyFloor !== undefined && maxVersion >= legacyFloor) {
      const detail = `domain '${domain}' at version ${maxVersion}, but this binary's Turso chain tops out at v${binaryMax}`;
      const remedy =
        'the legacy lineage is incompatible and is never auto-migrated. Run `claude-prove store migrate-to-turso --confirm` or `claude-prove store reset --confirm`.';
      throw new SchemaIncompatibleError(
        `store predates the Turso v1 schema (${detail}); ${remedy}`,
      );
    }

    const detail = `domain '${domain}' at version ${maxVersion}, binary knows up to v${binaryMax}`;
    throw new SchemaIncompatibleError(
      `store is ahead of this binary (${detail}); refusing to write against a schema this binary does not understand. Upgrade the binary.`,
    );
  }
}
