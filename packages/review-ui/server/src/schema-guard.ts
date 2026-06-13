/**
 * Read-only schema-state inspection + the write guard built on it.
 *
 * The multi-project server fronts EVERY prove project on the machine, and a
 * given project's `.prove/prove.db` may sit at a migration version BELOW what
 * this binary's registered domains expect. Writing through a behind-schema db
 * is unsafe: this binary's write services assume the current table shape, so a
 * write against an unmigrated db can target columns/tables that do not yet
 * exist or have moved. The policy is therefore: reads stay allowed on a behind
 * project (so the operator can still inspect it and see the "needs migration"
 * badge), but every write is refused until the project is migrated.
 *
 * Schema-version model (one scalar per project, collapsed from the multi-DOMAIN
 * `_migrations_log`):
 *   - `schema_version` = highest applied version across all `_migrations_log`
 *     rows (a monotonic high-water mark; 0 on a db with no log rows yet, null on
 *     a project with no `.prove/prove.db` at all).
 *   - `behind` = true iff ANY registered domain's applied version is below the
 *     version that domain's registered migrations expect (a `store migrate`
 *     would do work). A project level with or ahead of every domain is not
 *     behind.
 *
 * Expected versions come from the store's own migration registry
 * (`listDomains`/`getMigrations`), populated when the domain modules register.
 * The registry is the dependency-correct source: it lives in
 * `@claude-prove/store`, the package the reads go through, so "expected" and
 * "applied" are compared on the same footing rather than against a CLI-private
 * constant.
 */

import path from "node:path";
import fs from "node:fs";
import { type StoreOptions, getMigrations, listDomains, openStore } from "@claude-prove/store";
// Value imports of the idempotent re-registration helpers, called at read time
// in `registeredExpectedVersions`. A bare side-effect import is NOT enough: the
// module-scope `registerSchema` runs once per process, so a later
// `clearRegistry()` (test isolation helper) empties the registry and the
// side effect never re-fires — the guard would then silently see fewer (or
// zero) domains and report a behind store as compatible.
import { ensureAcbSchemaRegistered } from "@claude-prove/cli/acb/store";
import { ensureScrumSchemaRegistered } from "@claude-prove/cli/scrum/store";

/** Per-project store schema state in the `GET /api/projects` response. */
export interface ProjectStoreInfo {
  /**
   * Highest applied migration version across every domain in this db's
   * `_migrations_log`. 0 when the db exists but no migration has ever run;
   * null when the project has no `.prove/prove.db`.
   */
  schema_version: number | null;
  /**
   * True when some registered domain expects a higher version than this db has
   * applied (a `store migrate` would advance it). Null mirrors `schema_version`
   * when there is no db to compare.
   */
  behind: boolean | null;
}

/**
 * Expected version per registered domain — the max version each domain's
 * registered migrations declare. This is what an up-to-date db should have
 * applied. Empty until the domain modules have registered.
 */
export function registeredExpectedVersions(): Map<string, number> {
  // Re-land both shipped domains at read time so the expected-version map is
  // complete regardless of registry churn earlier in the process.
  ensureScrumSchemaRegistered();
  ensureAcbSchemaRegistered();
  const expected = new Map<string, number>();
  for (const domain of listDomains()) {
    const migrations = getMigrations(domain);
    const maxVersion = migrations.reduce((acc, m) => Math.max(acc, m.version), 0);
    expected.set(domain, maxVersion);
  }
  return expected;
}

/**
 * Read the applied version per domain from a db's `_migrations_log`, WITHOUT
 * triggering a migration.
 *
 * Hazard this guards against: the domain store wrappers `openScrumStore` /
 * `openAcbStore` are `openStore` + `runMigrations`, so opening a foreign
 * project's db through them would silently MIGRATE that project's db from this
 * read path. We therefore open with the raw `openStore({ readonly: true })`,
 * which never calls `runMigrations`, and the readonly handle is a hard guarantee
 * that no write (and thus no migration) can occur even if the open path changed.
 *
 * A db with no `_migrations_log` table (never migrated) yields an empty map,
 * which the caller treats as version 0 for every domain.
 */
export async function appliedVersions(dbPath: string): Promise<Map<string, number>> {
  const opts: StoreOptions = { path: dbPath, readonly: true };
  const store = await openStore(opts);
  try {
    // Each `all` is awaited BEFORE `close()`: the async driver finalizes
    // prepared statements on close, so an un-awaited query resolving afterward
    // throws "statement has been finalized".
    const hasLog = await store.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_migrations_log'",
    );
    if (hasLog.length === 0) return new Map();

    const rows = await store.all<{ domain: string; version: number }>(
      "SELECT domain, MAX(version) AS version FROM _migrations_log GROUP BY domain",
    );
    const applied = new Map<string, number>();
    for (const row of rows) applied.set(row.domain, row.version);
    return applied;
  } finally {
    store.close();
  }
}

/**
 * Compute the per-project `store` block. A project without a `.prove/prove.db`
 * is a registered-but-uninitialized project (not an error) and reports null
 * version and null behind.
 *
 * `expected` is injectable so tests drive a controlled domain→version map;
 * production passes the live registry via `registeredExpectedVersions()`.
 */
export async function projectStoreInfo(
  projectRoot: string,
  expected: Map<string, number>,
): Promise<ProjectStoreInfo> {
  const dbPath = path.join(projectRoot, ".prove", "prove.db");
  if (!fs.existsSync(dbPath)) return { schema_version: null, behind: null };

  // `existsSync` only proves the file is present, not that it is a readable
  // sqlite db: a corrupt, truncated, transiently-locked, or non-file (dir) path
  // makes `openStore` or the first SELECT throw. One such project must not fail
  // the whole listing, so degrade it to the same null/null block an absent db
  // reports and let every other project resolve.
  let applied: Map<string, number>;
  try {
    applied = await appliedVersions(dbPath);
  } catch {
    return { schema_version: null, behind: null };
  }

  // High-water mark across every applied row; 0 when the log is empty.
  let schemaVersion = 0;
  for (const version of applied.values()) schemaVersion = Math.max(schemaVersion, version);

  // Behind when any registered domain expects more than this db applied.
  let behind = false;
  for (const [domain, expectedVersion] of expected) {
    const appliedVersion = applied.get(domain) ?? 0;
    if (appliedVersion < expectedVersion) {
      behind = true;
      break;
    }
  }

  return { schema_version: schemaVersion, behind };
}

/** The structured body a behind-schema write is refused with (HTTP 409). */
export interface SchemaGuardError {
  error: string;
  /** The project root whose store is behind. */
  project: string;
  store: {
    schema_version: number | null;
    behind: boolean | null;
  };
}

/**
 * Decide whether writes to `projectRoot` must be refused because its store
 * schema is behind the registered expected versions. Returns the structured
 * 409 body when behind, or null when the write may proceed.
 *
 * Reuses the SAME read-only `_migrations_log` read + registry comparison the
 * `/api/projects` listing uses (`projectStoreInfo` against the live
 * `registeredExpectedVersions`), so the listing's "needs migration" badge and
 * the write refusal can never disagree. Crucially this never opens the db
 * through a migrating wrapper, so the guard itself cannot advance the foreign
 * project's schema.
 *
 * Fail-open on an absent/uninitialized/unreadable db: such a project reports
 * `behind: null` (not `true`), so a write is allowed to proceed and the write
 * service's own open path creates/migrates the db it owns. The guard refuses
 * ONLY a db that is present, readable, and provably behind.
 *
 * `expected` is injectable for tests; production passes the live registry.
 */
export async function storeBehindSchema(
  projectRoot: string,
  expected: Map<string, number> = registeredExpectedVersions(),
): Promise<SchemaGuardError | null> {
  const info = await projectStoreInfo(projectRoot, expected);
  if (info.behind !== true) return null;
  return {
    error: "store schema behind",
    project: projectRoot,
    store: { schema_version: info.schema_version, behind: info.behind },
  };
}
