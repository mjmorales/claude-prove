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
 * `~/.claude-prove/`. Behind dbs are fabricated with raw `bun:sqlite` (mirroring
 * the legacy-db fabrication in `acb.test.ts`) and never invoke a `claude-prove`
 * CLI.
 *
 * Cross-file registry hazard: other server test files call `clearRegistry()`,
 * which wipes the shared in-memory schema registry the live `acb`/`scrum`
 * domains registered into at import. `ensureAcbSchemaRegistered()` in
 * `beforeEach` re-lands the acb domain so the guard's live expected-version
 * lookup is populated here regardless of which file ran first.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { add as registryAdd } from "@claude-prove/store";
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
 * Seed `<root>/.prove/prove.db` as a real acb v1 db: the full v1 table set plus
 * a `_migrations_log` row at acb@1. That sits BELOW the live acb head (>1), so
 * the live registry reports it behind — yet it is a faithful, migratable db, so
 * the read path's auto-migrating store open advances it cleanly rather than
 * erroring on missing tables.
 */
function seedBehindAcbV1Db(root: string): void {
  const dbFile = join(root, ".prove", "prove.db");
  const db = new Database(dbFile, { create: true });
  db.exec(`
    CREATE TABLE _migrations_log (
      domain TEXT NOT NULL,
      version INTEGER NOT NULL,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      PRIMARY KEY (domain, version)
    );
    INSERT INTO _migrations_log (domain, version, description, applied_at)
      VALUES ('acb', 1, 'create acb_manifests + acb_acb_documents + acb_review_state', '2026-01-01T00:00:00Z');

    CREATE TABLE acb_manifests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch TEXT NOT NULL,
      commit_sha TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL,
      run_slug TEXT
    );
    CREATE TABLE acb_acb_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch TEXT NOT NULL UNIQUE,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE acb_review_state (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch TEXT NOT NULL UNIQUE,
      acb_hash TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
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
  test("returns the 409 body when a registered domain is behind", () => {
    const root = registerRoot("behind");
    seedBehindAcbV1Db(root);
    // Expected acb head is 2 but the seeded db only applied acb@1 → behind.
    const body = storeBehindSchema(root, new Map([["acb", 2]]));
    expect(body).toEqual({
      error: "store schema behind",
      project: root,
      store: { schema_version: 1, behind: true },
    });
  });

  test("returns null when every domain is level (write may proceed)", () => {
    const root = registerRoot("current");
    seedBehindAcbV1Db(root);
    // Expected head equals the applied version → not behind.
    expect(storeBehindSchema(root, new Map([["acb", 1]]))).toBeNull();
  });

  test("returns null for an absent db (fail-open, write service owns creation)", () => {
    const root = registerRoot("uninitialized"); // no prove.db seeded
    expect(storeBehindSchema(root, new Map([["acb", 99]]))).toBeNull();
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
function verdictRowCount(root: string, slug: string): number {
  const dbFile = join(root, ".prove", "prove.db");
  const db = new Database(dbFile, { readonly: true });
  try {
    const tbl = db
      .prepare<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'acb_group_verdicts'",
      )
      .all();
    if (tbl.length === 0) return 0;
    const rows = db
      .prepare<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM acb_group_verdicts WHERE slug = ?",
      )
      .all(slug);
    return rows[0]?.n ?? 0;
  } finally {
    db.close();
  }
}

describe("behind-schema write guard over HTTP", () => {
  test("a verdict write to a behind-schema project → 409 with the structured body, no mutation", async () => {
    const behind = registerRoot("behind");
    seedBehindAcbV1Db(behind);

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
      expect(body.store).toEqual({ schema_version: 1, behind: true });

      // The refusal never opened the writable (migrating) store, so the acb
      // verdict table was never created and no row landed.
      expect(verdictRowCount(behind, "main/add-login")).toBe(0);
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
      expect(verdictRowCount(current, "main/add-login")).toBe(1);
    } finally {
      await app.close();
    }
  });

  test("a read on a behind-schema project still returns 200 (reads are unguarded)", async () => {
    const behind = registerRoot("behind");
    seedBehindAcbV1Db(behind);

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
