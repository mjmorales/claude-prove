/**
 * Tests for the behind-schema write guard on the review-ui verdict paths.
 *
 * Policy under test: a project whose `.prove/prove.db` is BEHIND the registered
 * expected migration versions refuses writes with HTTP 409 (no mutation), while
 * reads stay allowed. A project at the current schema writes normally.
 *
 * Two layers:
 *   1. `storeBehindSchema` unit-level — driven with an injected expected map so
 *      the behind/current/uninitialized branches are exercised deterministically
 *      without depending on the live domain heads.
 *   2. HTTP integration via `buildApp` — a genuinely behind db (real acb v1
 *      tables + a `_migrations_log` row at acb@1, below the live acb head) must
 *      409 a verdict write and leave the store untouched, while a read on the
 *      same behind project still returns 200.
 *
 * Registry seam: the project registry's `baseOverride`/`registryBaseOverride`
 * points every read at a tmp dir, so no test touches the real
 * `~/.claude-prove/`. Behind dbs are fabricated with the raw async
 * `@claude-prove/store` `openStore` (mirroring the legacy-db fabrication in
 * `acb.test.ts`) and never invoke a `claude-prove` CLI.
 *
 * Cross-file registry hazard: other server test files call `clearRegistry()`,
 * which wipes the shared in-memory schema registry the live `acb`/`scrum`
 * domains registered into at import. `ensureAcbSchemaRegistered()` in
 * `beforeEach` re-lands the acb domain so the guard's live expected-version
 * lookup is populated here regardless of which file ran first.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { add as registryAdd, openStore } from "@claude-prove/store";
import { ensureAcbSchemaRegistered } from "@claude-prove/cli/acb/store";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index";
import { storeBehindSchema } from "../src/schema-guard";

let baseDir: string;
let workspace: string;

/**
 * Create a tmp repo root and register it in the tmp-dir registry. The caller
 * seeds the db shape; this only wires the root into the registry so the
 * per-request resolver accepts it.
 */
function registerRoot(name: string): string {
  const root = join(workspace, name);
  mkdirSync(join(root, ".prove"), { recursive: true });
  registryAdd(root, baseDir);
  return root;
}

/**
 * Seed `<root>/.prove/prove.db` as a behind db relative to the redesigned v1
 * schema: a `_migrations_log` table that exists but carries NO acb row, so the
 * applied acb version is 0 — below the live acb head (1). The live registry
 * therefore reports it behind. It is a faithful, migratable db (no acb tables
 * yet), so the read path's auto-migrating store open runs the acb v1 migration
 * and creates every table cleanly rather than erroring on a missing one.
 *
 * Behind is structurally possible only as applied-below-expected within a
 * domain. The clean v1 reset collapsed every domain to one version, so a
 * same-lineage store can be behind only by having NOT YET applied that domain's
 * v1 — exactly this fixture (acb applied 0 vs expected 1).
 */
async function seedBehindAcbV1Db(root: string): Promise<void> {
  const dbFile = join(root, ".prove", "prove.db");
  const db = await openStore({ path: dbFile });
  // The log exists but records no acb row — applied acb = 0 (behind v1). A
  // non-acb sentinel row keeps the log non-empty so it is a realistic
  // partially-initialized store rather than a never-migrated one.
  await db.exec(`
    CREATE TABLE _migrations_log (
      domain TEXT NOT NULL,
      version INTEGER NOT NULL,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      PRIMARY KEY (domain, version)
    );
  `);
  db.close();
}

beforeEach(() => {
  // Re-land the live acb domain in case a prior file's `clearRegistry()` wiped
  // it — the guard's expected-version lookup must see acb's real head here.
  ensureAcbSchemaRegistered();
  baseDir = mkdtempSync(join(tmpdir(), "prove-guard-base-"));
  workspace = mkdtempSync(join(tmpdir(), "prove-guard-ws-"));
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

describe("storeBehindSchema (injected expected map)", () => {
  test("returns the 409 body when a registered domain is behind", async () => {
    const root = registerRoot("behind");
    await seedBehindAcbV1Db(root);
    // Expected acb head is 1 but the seeded db has not applied acb at all
    // (applied 0) → behind. The high-water schema_version is 0 (an empty log).
    const body = await storeBehindSchema(root, new Map([["acb", 1]]));
    expect(body).toEqual({
      error: "store schema behind",
      project: root,
      store: { schema_version: 0, behind: true },
    });
  });

  test("returns null when every domain is level (write may proceed)", async () => {
    const root = registerRoot("current");
    await seedBehindAcbV1Db(root);
    // Expected head 0 equals the applied version (0) → not behind.
    expect(await storeBehindSchema(root, new Map([["acb", 0]]))).toBeNull();
  });

  test("returns null for an absent db (fail-open, write service owns creation)", async () => {
    const root = registerRoot("uninitialized"); // no prove.db seeded
    expect(await storeBehindSchema(root, new Map([["acb", 99]]))).toBeNull();
  });
});

async function build(startupRoot: string): Promise<FastifyInstance> {
  const app = await buildApp({
    repoRoot: startupRoot,
    webRoot: null,
    registryBaseOverride: baseDir,
  });
  await app.ready();
  return app;
}

/** Count verdict rows for a slug, opening the db read-only so the read never migrates it. */
async function verdictRowCount(root: string, slug: string): Promise<number> {
  const dbFile = join(root, ".prove", "prove.db");
  const db = await openStore({ path: dbFile, readonly: true });
  try {
    const tbl = await db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'acb_group_verdicts'",
    );
    if (tbl.length === 0) return 0;
    const rows = await db.all<{ n: number }>(
      "SELECT COUNT(*) AS n FROM acb_group_verdicts WHERE slug = ?",
      [slug],
    );
    return rows[0]?.n ?? 0;
  } finally {
    db.close();
  }
}

describe("behind-schema write guard over HTTP", () => {
  test("a verdict write to a behind-schema project → 409 with the structured body, no mutation", async () => {
    const behind = registerRoot("behind");
    await seedBehindAcbV1Db(behind);

    const app = await build(behind);
    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/runs/main%2Fadd-login/review/g1/verdict?project=${encodeURIComponent(behind)}`,
        payload: { verdict: "accepted", note: "lgtm" },
      });
      expect(res.statusCode).toBe(409);
      const body = res.json() as { error: string; project: string; store: unknown };
      expect(body.error).toBe("store schema behind");
      expect(body.project).toBe(behind);
      expect(body.store).toEqual({ schema_version: 0, behind: true });

      // The refusal never opened the writable (migrating) store, so the acb
      // verdict table was never created and no row landed.
      expect(await verdictRowCount(behind, "main/add-login")).toBe(0);
    } finally {
      await app.close();
    }
  });

  test("a verdict write to a current-schema project succeeds", async () => {
    // A root with NO prove.db is fail-open (uninitialized → not behind), so the
    // write service creates and migrates its own db to the current shape and
    // the write lands. This exercises the "current/allowed" branch end-to-end.
    const current = registerRoot("current");

    const app = await build(current);
    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/runs/main%2Fadd-login/review/g1/verdict?project=${encodeURIComponent(current)}`,
        payload: { verdict: "accepted", note: "lgtm" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { record: { verdict: string } };
      expect(body.record.verdict).toBe("accepted");
      expect(await verdictRowCount(current, "main/add-login")).toBe(1);
    } finally {
      await app.close();
    }
  });

  test("a read on a behind-schema project still returns 200 (reads are unguarded)", async () => {
    const behind = registerRoot("behind");
    await seedBehindAcbV1Db(behind);

    const app = await build(behind);
    try {
      const res = await app.inject({
        method: "GET",
        url: `/api/runs/main%2Fadd-login/review?project=${encodeURIComponent(behind)}`,
      });
      // The read path is allowed; it returns the (empty) verdict listing rather
      // than the 409 the write paths emit. The read's auto-migrating store open
      // advances the faithful acb v1 db forward without error.
      expect(res.statusCode).toBe(200);
      const body = res.json() as { slug: string; verdicts: unknown[] };
      expect(body.slug).toBe("main/add-login");
      expect(Array.isArray(body.verdicts)).toBe(true);
    } finally {
      await app.close();
    }
  });
});
