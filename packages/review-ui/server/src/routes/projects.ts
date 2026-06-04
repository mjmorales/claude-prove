/**
 * `GET /api/projects` — the multi-project picker feed.
 *
 * Lists every registered prove project (machine-global registry at
 * `~/.claude-prove/projects.json`) and, for each, reports the schema state of
 * its `.prove/prove.db`: which migration version it sits at and whether that is
 * behind the versions this binary's domains expect. The frontend uses this to
 * render the project switcher with a "needs migration" badge.
 *
 * Schema-version model. The store is multi-DOMAIN (scrum, acb, …); each domain
 * tracks its own applied migrations in the shared `_migrations_log` table. We
 * collapse that into one scalar per project:
 *   - `schema_version` = the highest applied version across all rows of
 *     `_migrations_log` (a monotonic high-water mark; 0 on a db with no log
 *     rows yet, null on a project with no `.prove/prove.db` at all).
 *   - `behind` = true iff ANY registered domain's applied version is below the
 *     version that domain's registered migrations expect (i.e. a `store migrate`
 *     would do work). A project ahead of, or level with, every registered
 *     domain is not behind.
 *
 * Expected versions come from the store's own migration registry
 * (`listDomains`/`getMigrations`), populated when the domain modules
 * (`@claude-prove/cli/scrum/store`, `.../acb/store`) are imported — which this
 * module forces via its own side-effect imports, so the read never depends on
 * another module importing them first.
 * The registry is the dependency-correct source: it lives in
 * `@claude-prove/store`, the package this server reads the db through, so the
 * "expected" side and the "applied" side are compared on the same footing
 * rather than against a CLI-private constant.
 */

import path from "node:path";
import fs from "node:fs";
import { type StoreOptions, getMigrations, listDomains, list as listRegistry, openStore } from "@claude-prove/store";
// Side-effect imports: each domain's store module calls `registerSchema` at
// module scope, so importing them populates the migration registry that
// `registeredExpectedVersions` reads — independent of import order elsewhere.
import "@claude-prove/cli/acb/store";
import "@claude-prove/cli/scrum/store";
import type { FastifyInstance } from "fastify";
import { listProjects } from "../projects.js";

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

/** One project row in the `GET /api/projects` response. */
export interface ProjectListing {
  /** URL-safe `?project=` key — `encodeURIComponent(path)`. */
  id: string;
  /** Absolute repository root. */
  path: string;
  /** Display basename. */
  name: string;
  /** ISO-8601 of the most recent registry `upsert`, or null if absent. */
  last_seen: string | null;
  store: ProjectStoreInfo;
}

/**
 * Expected version per registered domain — the max version each domain's
 * registered migrations declare. This is what an up-to-date db should have
 * applied. Empty until the domain modules have registered.
 */
function registeredExpectedVersions(): Map<string, number> {
  // Domains self-register via this module's side-effect imports above, so
  // `listDomains()` already includes every shipped domain here.
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
function appliedVersions(dbPath: string): Map<string, number> {
  const opts: StoreOptions = { path: dbPath, readonly: true };
  const store = openStore(opts);
  try {
    const hasLog = store.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_migrations_log'",
    );
    if (hasLog.length === 0) return new Map();

    const rows = store.all<{ domain: string; version: number }>(
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
export function projectStoreInfo(
  projectRoot: string,
  expected: Map<string, number>,
): ProjectStoreInfo {
  const dbPath = path.join(projectRoot, ".prove", "prove.db");
  if (!fs.existsSync(dbPath)) return { schema_version: null, behind: null };

  // `existsSync` only proves the file is present, not that it is a readable
  // sqlite db: a corrupt, truncated, transiently-locked, or non-file (dir) path
  // makes `openStore` or the first SELECT throw. One such project must not fail
  // the whole listing, so degrade it to the same null/null block an absent db
  // reports and let every other project resolve.
  let applied: Map<string, number>;
  try {
    applied = appliedVersions(dbPath);
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

/**
 * Build the full project listing. `baseOverride` threads the registry's tmp-dir
 * test seam through end-to-end; `expectedOverride` injects the domain→version
 * map (defaults to the live registry). Prune-on-read happens inside
 * `listProjects` — there is NO second prune here.
 */
export function buildProjectListing(
  baseOverride?: string,
  expectedOverride?: Map<string, number>,
): ProjectListing[] {
  const expected = expectedOverride ?? registeredExpectedVersions();
  // Prune-on-read + survivors as ProjectRefs (id/path/name).
  const refs = listProjects(baseOverride);
  // `last_seen` is not on ProjectRef; read it from the registry post-prune
  // (a pure read, no second prune) and join by exact path.
  const lastSeenByPath = new Map<string, string>();
  for (const entry of listRegistry(baseOverride)) lastSeenByPath.set(entry.path, entry.last_seen);

  return refs.map((ref) => ({
    id: ref.id,
    path: ref.path,
    name: ref.name,
    last_seen: lastSeenByPath.get(ref.path) ?? null,
    store: projectStoreInfo(ref.path, expected),
  }));
}

/**
 * Register `GET /api/projects`. Additive — a standalone registrar alongside the
 * existing route modules; touches no other route. The `repoRoot` the other
 * registrars take is unused here because this endpoint is machine-global (it
 * spans every registered project, not the single repo the server booted in).
 */
export function registerProjectsRoute(app: FastifyInstance): void {
  app.get("/api/projects", async () => ({ projects: buildProjectListing() }));
}
