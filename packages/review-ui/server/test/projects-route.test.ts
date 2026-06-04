/**
 * Tests for `GET /api/projects` and its `buildProjectListing` core.
 *
 * The registry's `baseOverride` seam (and the `CLAUDE_PROVE_HOME` env equivalent
 * for the HTTP path, which can't thread an override) points every read/write at
 * a tmp dir, so no test touches the real `~/.claude-prove/`. Behind-schema vs
 * current is seeded WITHOUT manual SQL writes: we register a test domain at a
 * partial version, migrate a db to it, then compare against a higher expected
 * map — exactly the "store package's own APIs" path a real behind db takes.
 *
 * Auto-migration guard under test: the seeded dbs are opened by the route via
 * the raw readonly `openStore`, never the migrating `openScrumStore`/`openAcbStore`
 * wrappers, so reading a db never advances it. A db migrated to v1 here still
 * reads as v1 after the route inspects it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  add as registryAdd,
  clearRegistry,
  openStore,
  registerSchema,
  runMigrations,
} from "@claude-prove/store";
import { buildApp } from "../src/index";
import { buildProjectListing, projectStoreInfo } from "../src/routes/projects";

let baseDir: string;
let workspace: string;

/** Single-version test domain; tests vary the EXPECTED head to drive `behind`. */
const TEST_DOMAIN = "widgets";
const MIGRATION_V1 = {
  version: 1,
  description: "create widgets",
  up: (db: { run(sql: string): void }) => db.run("CREATE TABLE widgets (id INTEGER PRIMARY KEY)"),
};

/**
 * Create a tmp repo root, register it in the tmp-dir registry, and seed its
 * `.prove/prove.db` by migrating it to the registered domain head. Returns the
 * root path.
 */
function makeProject(name: string): string {
  const root = join(workspace, name);
  mkdirSync(join(root, ".prove"), { recursive: true });
  const store = openStore({ path: join(root, ".prove", "prove.db") });
  try {
    runMigrations(store);
  } finally {
    store.close();
  }
  registryAdd(root, baseDir);
  return root;
}

beforeEach(() => {
  clearRegistry();
  baseDir = mkdtempSync(join(tmpdir(), "prove-projects-route-base-"));
  workspace = mkdtempSync(join(tmpdir(), "prove-projects-route-ws-"));
});

afterEach(() => {
  clearRegistry();
  rmSync(baseDir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

describe("buildProjectListing", () => {
  test("reports one behind project and one current project", () => {
    // Register only v1, migrate both dbs to v1 (their applied head).
    registerSchema({ domain: TEST_DOMAIN, migrations: [MIGRATION_V1] });
    const behindRoot = makeProject("behind");
    const currentRoot = makeProject("current");

    // Behind: expected head is v2 but the db only applied v1.
    const behindExpected = new Map([[TEST_DOMAIN, 2]]);
    const behindRow = byPath(buildProjectListing(baseDir, behindExpected), behindRoot);
    expect(behindRow.store).toEqual({ schema_version: 1, behind: true });

    // Current: expected head equals the applied v1.
    const currentExpected = new Map([[TEST_DOMAIN, 1]]);
    const currentRow = byPath(buildProjectListing(baseDir, currentExpected), currentRoot);
    expect(currentRow.store).toEqual({ schema_version: 1, behind: false });
  });

  test("drops a dead path from the response via prune-on-read", () => {
    registerSchema({ domain: TEST_DOMAIN, migrations: [MIGRATION_V1] });
    const live = makeProject("live");
    const dead = makeProject("dead");
    // Remove the dead root from disk; prune-on-read inside listProjects evicts it.
    rmSync(dead, { recursive: true, force: true });

    const rows = buildProjectListing(baseDir, new Map([[TEST_DOMAIN, 1]]));
    const paths = rows.map((r) => r.path);
    expect(paths).toContain(live);
    expect(paths).not.toContain(dead);
  });

  test("reports null version for a project with no prove.db", () => {
    // The registry's prune-on-read evicts any root missing `.prove/prove.db`,
    // so a db-less project never reaches the listing — but `projectStoreInfo`
    // owns the contract that such a root reports null/null, which is exercised
    // directly here on a root that exists but has no prove.db.
    const root = join(workspace, "uninitialized");
    mkdirSync(root, { recursive: true });
    expect(projectStoreInfo(root, new Map([[TEST_DOMAIN, 2]]))).toEqual({
      schema_version: null,
      behind: null,
    });
  });

  test("carries id, name, and last_seen for each row", () => {
    registerSchema({ domain: TEST_DOMAIN, migrations: [MIGRATION_V1] });
    const root = makeProject("alpha");

    const row = byPath(buildProjectListing(baseDir, new Map([[TEST_DOMAIN, 1]])), root);
    expect(row.id).toBe(encodeURIComponent(root));
    expect(row.name).toBe("alpha");
    expect(typeof row.last_seen).toBe("string");
  });
});

describe("GET /api/projects", () => {
  const savedHome = process.env.CLAUDE_PROVE_HOME;

  afterEach(() => {
    if (savedHome === undefined) delete process.env.CLAUDE_PROVE_HOME;
    else process.env.CLAUDE_PROVE_HOME = savedHome;
  });

  test("serves the listing over HTTP against a tmp registry", async () => {
    // The HTTP handler reads the live registry (no baseOverride), so point the
    // registry at the tmp dir via the env seam and let the route's own
    // expected-version computation run end-to-end.
    process.env.CLAUDE_PROVE_HOME = baseDir;
    registerSchema({ domain: TEST_DOMAIN, migrations: [MIGRATION_V1] });
    const root = makeProjectAtHome("alpha");

    const app = await buildApp({ repoRoot: "/nonexistent-repo-root", webRoot: null });
    await app.ready();
    try {
      const res = await app.inject({ method: "GET", url: "/api/projects" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { projects: Array<{ path: string; store: unknown }> };
      const row = body.projects.find((p) => p.path === root);
      expect(row).toBeDefined();
      // `clearRegistry` in beforeEach wipes the in-memory domain registry, and
      // the route's acb/scrum side-effect imports only `registerSchema` once at
      // module load — they do not re-register after the clear — so `widgets` is
      // the sole registered domain here. We assert only the version high-water
      // mark, which the seed controls deterministically.
      expect((row as { store: { schema_version: number } }).store.schema_version).toBe(1);
    } finally {
      await app.close();
    }
  });

  test("degrades one unreadable-db project to null/null and still lists the healthy sibling", async () => {
    process.env.CLAUDE_PROVE_HOME = baseDir;
    registerSchema({ domain: TEST_DOMAIN, migrations: [MIGRATION_V1] });
    const healthyRoot = makeProjectAtHome("healthy");
    const brokenRoot = makeProjectWithUnreadableDb("broken");

    const app = await buildApp({ repoRoot: "/nonexistent-repo-root", webRoot: null });
    await app.ready();
    try {
      const res = await app.inject({ method: "GET", url: "/api/projects" });
      // One bad project must not 500 the whole listing.
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        projects: Array<{ path: string; store: { schema_version: number | null; behind: boolean | null } }>;
      };

      // The corrupt db degrades to the same null/null block an absent db reports.
      const brokenRow = body.projects.find((p) => p.path === brokenRoot);
      expect(brokenRow).toBeDefined();
      expect(brokenRow?.store).toEqual({ schema_version: null, behind: null });

      // The healthy sibling still resolves with its real applied version.
      const healthyRow = body.projects.find((p) => p.path === healthyRoot);
      expect(healthyRow).toBeDefined();
      expect(healthyRow?.store.schema_version).toBe(1);
    } finally {
      await app.close();
    }
  });
});

/** Seed a project whose registry home is the env-pointed tmp base (no override). */
function makeProjectAtHome(name: string): string {
  const root = join(workspace, name);
  mkdirSync(join(root, ".prove"), { recursive: true });
  const store = openStore({ path: join(root, ".prove", "prove.db") });
  try {
    runMigrations(store);
  } finally {
    store.close();
  }
  registryAdd(root);
  return root;
}

/**
 * Register a project whose `.prove/prove.db` is present on disk (survives the
 * registry's existsSync prune) but is not a readable sqlite db — non-sqlite
 * bytes make `openStore`/the first SELECT throw. Returns the root path.
 */
function makeProjectWithUnreadableDb(name: string): string {
  const root = join(workspace, name);
  mkdirSync(join(root, ".prove"), { recursive: true });
  writeFileSync(join(root, ".prove", "prove.db"), "this is not a sqlite database");
  registryAdd(root);
  return root;
}

/** Find the row for an exact project path, asserting it exists. */
function byPath(
  rows: ReturnType<typeof buildProjectListing>,
  projectPath: string,
): ReturnType<typeof buildProjectListing>[number] {
  const row = rows.find((r) => r.path === projectPath);
  if (!row) throw new Error(`no project row for ${projectPath}`);
  return row;
}
