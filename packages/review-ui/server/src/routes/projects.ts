/**
 * `GET /api/projects` — the multi-project picker feed.
 *
 * Lists every registered prove project (machine-global registry at
 * `~/.claude-prove/projects.json`) and, for each, reports the schema state of
 * its `.prove/prove.db`: which migration version it sits at and whether that is
 * behind the versions this binary's domains expect. The frontend uses this to
 * render the project switcher with a "needs migration" badge.
 *
 * The schema-state computation itself (the read-only `_migrations_log` read,
 * the registered expected-version map, and the per-project collapse into
 * `{ schema_version, behind }`) lives in `../schema-guard.js` so the same
 * comparison drives both this listing's badge AND the write guard that refuses
 * writes to a behind-schema project — the two can never disagree.
 */

import { type ProjectStoreInfo, projectStoreInfo, registeredExpectedVersions } from "../schema-guard.js";
import { list as listRegistry } from "@claude-prove/store";
import type { FastifyInstance } from "fastify";
import { listProjects } from "../projects.js";

// Re-export the schema-state surface so existing importers of this route
// module (`projectStoreInfo`, `ProjectStoreInfo`) keep resolving here while the
// computation lives in `../schema-guard.js`.
export { projectStoreInfo };
export type { ProjectStoreInfo };

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
