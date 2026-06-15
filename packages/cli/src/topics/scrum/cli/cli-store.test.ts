/**
 * Tests for the scrum CLI store open + the session-boundary cloud sync lifecycle
 * (`cli-store.ts` + `sync-lifecycle.ts`).
 *
 * THE MODEL UNDER TEST: when the cloud gate opens, the scrum store is built ON
 * the synced `@tursodatabase/sync` connection (`openScrumStore({ connection })`),
 * so its writes are captured by the engine's per-handle change-log and replicate
 * on `push()`. The store and the sync engine are ONE connection, not two — the
 * separate-connection model left store writes invisible to sync, which this
 * rewires. Because they share a handle, `openScrumStore` SKIPS migrations on an
 * injected connection (the connection must already carry the scrum schema) and
 * runs `assertStoreSchemaCompatible` (reads `_migrations_log`) at open.
 *
 * THREE INVARIANTS exercised here:
 *   1. DEFAULT-OFF — with `cloud.enabled` absent/false (the default) or no token,
 *      the sync path is DEAD CODE: `openSyncSession` returns a LOCAL store, never
 *      calls `connectSync`, and the fake engine's connection is never touched
 *      (`engine.calls === []`). `openCliStore` is unchanged on the local path.
 *   2. GATED LIFECYCLE — only when `cloud.enabled && token` resolve does the
 *      lifecycle reach the engine. The connection now closes at
 *      `session.close()` / `store.close()`, NOT inside the lifecycle, so the
 *      call sequence ends with the engine's pull/push but defers `close` to the
 *      caller. `openStoreWithSync('session-start')` flush-pushes then pulls.
 *   3. DEGRADE — pull/push are wrapped in try/catch + a short timeout; on
 *      failure the session WARNS and proceeds local (the store stays usable,
 *      `ok: false`) — the command's primary output never blocks on the network.
 *
 * THE FAKE ENGINE: `connectSync` returns a fake that `openSyncDatabase` casts to
 * a `Database` the store wraps, so the fake can no longer be record-only — the
 * store calls `exec`/`prepare`/`close` on it. Each fake BACKS a real schema'd
 * connection: a tmp file is pre-migrated via `openScrumStore({ override })`, then
 * a real `@tursodatabase/database` connection is opened to that same file (it now
 * carries the scrum schema) and `exec`/`prepare` delegate to it; `close()` both
 * records `'close'` and closes the real connection. `connect`/`pull`/`push` stay
 * record-only stubs (pull returns `true`). This makes `makeFakeEngine` async.
 *
 * Every test injects a FAKE `connectSync` and a `resolveToken` stub through the
 * `SyncLifecycleDeps` seam, so nothing here ever opens a real cloud connection.
 * Stores live in `.git`-shaped tmpdirs; tmp files (project roots + fake-engine
 * backing dbs) are cleaned up after each test.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SyncConnectOptions, SyncEngineDatabase, SyncOpenDeps } from '@claude-prove/store';
import { type Database, connect } from '@tursodatabase/database';
import { openScrumStore } from '../store';
import { openCliStore } from './cli-store';
import {
  type SyncLifecycleDeps,
  openStoreWithSync,
  openSyncSession,
  withTimeout,
} from './sync-lifecycle';

/** A `.git`-shaped project root with an optional `.prove.json` cloud block. */
function makeProject(cloud?: Record<string, unknown> | false): string {
  const root = mkdtempSync(join(tmpdir(), 'cli-store-sync-'));
  mkdirSync(join(root, '.git'), { recursive: true });
  mkdirSync(join(root, '.claude'), { recursive: true });
  const body: Record<string, unknown> = { schema_version: '12' };
  if (cloud !== false && cloud !== undefined) body.cloud = cloud;
  writeFileSync(join(root, '.claude', '.prove.json'), `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  return root;
}

/**
 * A fake sync engine recording the lifecycle's call sequence AND backing a real
 * schema'd connection. `openSyncDatabase` casts this to a `Database` the store
 * wraps, so the store's `exec`/`prepare`/`close` delegate to `connection`.
 */
interface FakeEngine extends SyncEngineDatabase {
  calls: string[];
  connectOpts: SyncConnectOptions | null;
  /** The real backing connection (already carries the scrum schema). */
  connection: Database;
}

/** Tmp dirs holding fake-engine backing dbs — cleaned up after each test. */
let engineBackings: string[] = [];

/**
 * Build a fake sync engine over a freshly-migrated backing db. The backing db is
 * a tmp FILE pre-migrated by a throwaway `openScrumStore({ override })` (which
 * carries the scrum schema), then re-opened as a real `@tursodatabase/database`
 * connection so it already has `_migrations_log` populated — exactly what the
 * store's injected-connection open requires (it SKIPS migrations and only
 * validates compatibility). `behavior` overrides any record-only stub (e.g. a
 * `push`/`pull` rejection or a `connect` that fires the transform); `seed` (when
 * given) writes rows into the pre-migrated file BEFORE the synced store opens, so
 * the open-time `snapshotKeyExists` snapshot already sees them.
 */
async function makeFakeEngine(
  behavior: Partial<SyncEngineDatabase> = {},
  seed?: (store: Awaited<ReturnType<typeof openScrumStore>>) => Promise<void>,
): Promise<FakeEngine> {
  const dir = mkdtempSync(join(tmpdir(), 'fake-engine-'));
  engineBackings.push(dir);
  const file = join(dir, 'backing.db');
  // Pre-migrate the file: a throwaway store open runs every migration, so the
  // file carries the scrum schema + `_migrations_log` before the real
  // connection reopens it for the store under test. Any `seed` rows are written
  // under this same open so they are present at the synced store's snapshot.
  const seedStore = await openScrumStore({ override: file });
  if (seed) await seed(seedStore);
  seedStore.close();
  const connection = await connect(file);

  const engine: FakeEngine = {
    calls: [],
    connectOpts: null,
    connection,
    async connect() {
      engine.calls.push('connect');
    },
    async pull() {
      engine.calls.push('pull');
      return true;
    },
    async push() {
      engine.calls.push('push');
    },
    async close() {
      engine.calls.push('close');
      // The store wraps THIS handle, so closing the engine closes the real db —
      // mirroring production, where `store.close()` closes the synced connection.
      engine.connection.close();
    },
    // The store's exec/prepare flow to the real backing connection so writes and
    // the open-time `snapshotKeyExists` read hit a live schema'd db.
    exec: (sql: string) => engine.connection.exec(sql),
    prepare: (sql: string) => engine.connection.prepare(sql),
    ...behavior,
  } as FakeEngine;
  return engine;
}

/** Lifecycle deps wiring the fake engine + a static token + a captured warn sink. */
function makeDeps(
  engine: FakeEngine,
  opts: { token?: string | null; warns: string[] } = { warns: [] },
): { deps: SyncLifecycleDeps; connectCalls: { count: number } } {
  const connectCalls = { count: 0 };
  const connectSync: SyncOpenDeps['connectSync'] = async (connectOpts) => {
    connectCalls.count += 1;
    engine.connectOpts = connectOpts;
    return engine;
  };
  const deps: SyncLifecycleDeps = {
    connectSync,
    resolveToken: () => (opts.token === undefined ? 'db-scoped-token' : opts.token),
    timeoutMs: 200,
    warn: (line) => opts.warns.push(line),
  };
  return { deps, connectCalls };
}

const CLOUD_ON = { enabled: true, org: 'acme', group: 'prove', db_name: 'prove-acme' };

let projects: string[] = [];
beforeEach(() => {
  projects = [];
  engineBackings = [];
});
afterEach(() => {
  for (const p of projects) rmSync(p, { recursive: true, force: true });
  for (const d of engineBackings) rmSync(d, { recursive: true, force: true });
});

function project(cloud?: Record<string, unknown> | false): string {
  const root = makeProject(cloud);
  projects.push(root);
  return root;
}

describe('default-off invariant — zero network, behaves as local', () => {
  test('cloud block absent: openSyncSession is local, connectSync never called', async () => {
    const root = project(false);
    const engine = await makeFakeEngine();
    const warns: string[] = [];
    const { deps, connectCalls } = makeDeps(engine, { warns });

    const session = await openSyncSession(root, deps);
    try {
      expect(session.result).toEqual({ attempted: false, ok: true, collisions: [] });
      expect(connectCalls.count).toBe(0);
      // The local path never reaches the fake's connection.
      expect(engine.calls).toEqual([]);
      expect(warns).toEqual([]);
    } finally {
      session.close();
      engine.connection.close();
    }
  });

  test('cloud.enabled false: openSyncSession is local, connectSync never called', async () => {
    const root = project({ enabled: false, org: 'acme', group: 'prove', db_name: 'prove-acme' });
    const engine = await makeFakeEngine();
    const { deps, connectCalls } = makeDeps(engine);

    const session = await openSyncSession(root, deps);
    try {
      expect(session.result.attempted).toBe(false);
      expect(connectCalls.count).toBe(0);
      expect(engine.calls).toEqual([]);
    } finally {
      session.close();
      engine.connection.close();
    }
  });

  test('openStoreWithSync default-off: returns a usable local store, zero network', async () => {
    const root = project(false);
    const engine = await makeFakeEngine();
    const { deps, connectCalls } = makeDeps(engine);

    const { store, result } = await openStoreWithSync(root, 'session-start', deps);
    try {
      expect(result.attempted).toBe(false);
      expect(connectCalls.count).toBe(0);
      // The store is fully usable — a local write/read works exactly as before.
      await store.createMilestone({ id: 'm1', title: 'M1' });
      const m = await store.getMilestone('m1');
      expect(m?.title).toBe('M1');
    } finally {
      store.close();
      engine.connection.close();
    }
  });

  test('openCliStore opens the local store unchanged (no sync deps, no network)', async () => {
    const root = project(false);
    const store = await openCliStore(root);
    try {
      await store.createMilestone({ id: 'm1', title: 'Local' });
      expect((await store.getMilestone('m1'))?.title).toBe('Local');
    } finally {
      store.close();
    }
  });
});

describe('gate — cloud.enabled but no token resolves to local-only', () => {
  test('null token: no network, attempted false, connection untouched', async () => {
    const root = project(CLOUD_ON);
    const engine = await makeFakeEngine();
    const { deps, connectCalls } = makeDeps(engine, { token: null, warns: [] });

    const session = await openSyncSession(root, deps);
    try {
      expect(session.result.attempted).toBe(false);
      expect(connectCalls.count).toBe(0);
      expect(engine.calls).toEqual([]);
    } finally {
      session.close();
      engine.connection.close();
    }
  });
});

describe('gated lifecycle — pull/push/flush-push per boundary', () => {
  test('openStoreWithSync session-start: flush-push then pull; close deferred to store.close()', async () => {
    const root = project(CLOUD_ON);
    const engine = await makeFakeEngine();
    const { deps, connectCalls } = makeDeps(engine);

    const { store, result } = await openStoreWithSync(root, 'session-start', deps);
    try {
      expect(result.attempted).toBe(true);
      expect(result.ok).toBe(true);
      expect(connectCalls.count).toBe(1);
      // The store reads at open (snapshotKeyExists) hit the backing connection's
      // exec/prepare, NOT the sync engine — so they do not appear in `calls`.
      // flush-push recovers a missed prior stop, then pull peer changes. The
      // connection has NOT closed yet — the caller owns the store's lifetime.
      expect(engine.calls).toEqual(['connect', 'push', 'pull']);
      // The remote url + token were assembled from config + the token stub.
      expect(engine.connectOpts?.url).toBe('libsql://prove-acme-acme.turso.io');
      expect(engine.connectOpts?.authToken).toBe('db-scoped-token');
    } finally {
      store.close();
    }
    // `store.close()` closes the underlying synced connection — only now does the
    // engine see `close`.
    expect(engine.calls).toEqual(['connect', 'push', 'pull', 'close']);
  });

  test('openSyncSession + push() + close(): connect, push, then close on close()', async () => {
    const root = project(CLOUD_ON);
    const engine = await makeFakeEngine();
    const { deps, connectCalls } = makeDeps(engine);

    const session = await openSyncSession(root, deps);
    expect(connectCalls.count).toBe(1);
    const pushed = await session.push();
    expect(pushed.ok).toBe(true);
    // The session's writes are usable on the synced connection.
    await session.store.createMilestone({ id: 'm1', title: 'on-sync' });
    expect((await session.store.getMilestone('m1'))?.title).toBe('on-sync');
    expect(engine.calls).toEqual(['connect', 'push']);
    session.close();
    expect(engine.calls).toEqual(['connect', 'push', 'close']);
    expect(engine.connectOpts?.url).toBe('libsql://prove-acme-acme.turso.io');
    expect(engine.connectOpts?.authToken).toBe('db-scoped-token');
  });
});

describe('degrade — pull/push failure warns + proceeds local (exit 0, no block)', () => {
  test('a push rejection degrades: warns, ok=false, store still usable', async () => {
    const root = project(CLOUD_ON);
    const engine = await makeFakeEngine({
      async push() {
        throw new Error('transport reset');
      },
    });
    const warns: string[] = [];
    const { deps } = makeDeps(engine, { warns });

    // The OPEN itself still succeeds (connect + store build on the synced conn).
    const session = await openSyncSession(root, deps);
    try {
      const result = await session.push();

      expect(result.attempted).toBe(true);
      expect(result.ok).toBe(false);
      expect(result.degradedReason).toContain('transport reset');
      expect(warns.join('')).toContain('proceeding local');
      // The store survives the degrade — the primary output is unaffected.
      await session.store.createMilestone({ id: 'm1', title: 'survives' });
      expect((await session.store.getMilestone('m1'))?.title).toBe('survives');
    } finally {
      session.close();
    }
  });

  test('a hung pull is bounded by the timeout: degrades within budget', async () => {
    const root = project(CLOUD_ON);
    const engine = await makeFakeEngine({
      // Never resolves — only the timeout can end this op.
      pull: () => new Promise<boolean>(() => {}),
    });
    const warns: string[] = [];
    const { deps } = makeDeps(engine, { warns });

    const session = await openSyncSession(root, deps);
    try {
      const started = Date.now();
      const result = await session.pull();
      const elapsed = Date.now() - started;

      expect(result.ok).toBe(false);
      expect(result.degradedReason).toContain('timed out');
      // The 200ms budget bounds the wait; a generous ceiling avoids flake.
      expect(elapsed).toBeLessThan(2000);
    } finally {
      session.close();
    }
  });

  test('an offline connect() fast-fails at open: degrades to a local store, warns', async () => {
    const root = project(CLOUD_ON);
    const engine = await makeFakeEngine({
      async connect() {
        throw new Error('ENOTFOUND');
      },
    });
    const warns: string[] = [];
    const { deps } = makeDeps(engine, { warns });

    const session = await openSyncSession(root, deps);
    try {
      // The open degraded to a local store; its result and pull/push report
      // ok=false, and the store stays usable.
      expect(session.result.attempted).toBe(true);
      expect(session.result.ok).toBe(false);
      expect((await session.pull()).ok).toBe(false);
      expect(warns.join('')).toContain('proceeding local');
      await session.store.createMilestone({ id: 'm1', title: 'local-fallback' });
      expect((await session.store.getMilestone('m1'))?.title).toBe('local-fallback');
    } finally {
      session.close();
      // The degrade path closed the failed sync handle and reopened a local
      // store; close the fake's now-orphaned backing connection too.
      engine.connection.close();
    }
  });
});

describe('transform + collision sink — surfaced for the anomaly pass', () => {
  test('a secondary-UNIQUE INSERT on an existing key is skipped and surfaced', async () => {
    const root = project(CLOUD_ON);
    // Seed 'alice' into the backing db BEFORE the synced store opens, so the
    // open-time snapshot the transform probes already holds her slug.
    const engine = await makeFakeEngine({}, async (store) => {
      await store.registerContributor({ slug: 'alice', displayName: 'Alice' });
    });
    const { deps } = makeDeps(engine);

    const session = await openSyncSession(root, deps);
    try {
      // Fire the transform the lifecycle registered at connect(), simulating a
      // replay of a peer's INSERT of a contributor with the SAME slug.
      const out = engine.connectOpts?.transform?.({
        changeTime: 0,
        tableName: 'scrum_contributors',
        id: 1,
        changeType: 'insert' as never,
        after: { slug: 'alice', display_name: 'Alice (peer)' },
      });
      // The transform returns `skip` for a colliding INSERT.
      expect(out).toEqual({ operation: 'skip' });
      // The collision was recorded into the sink the anomaly pass drains.
      expect(session.result.collisions).toHaveLength(1);
      expect(session.result.collisions[0]?.table).toBe('scrum_contributors');
      expect(session.result.collisions[0]?.key).toEqual({ slug: 'alice' });
    } finally {
      session.close();
    }
  });

  test('a non-colliding INSERT passes through (null) — no surfaced collision', async () => {
    const root = project(CLOUD_ON);
    const engine = await makeFakeEngine();
    const { deps } = makeDeps(engine);

    const session = await openSyncSession(root, deps);
    try {
      const out = engine.connectOpts?.transform?.({
        changeTime: 0,
        tableName: 'scrum_contributors',
        id: 2,
        changeType: 'insert' as never,
        after: { slug: 'bob', display_name: 'Bob' },
      });
      expect(out).toBeNull();
      expect(session.result.collisions).toEqual([]);
    } finally {
      session.close();
    }
  });
});

describe('withTimeout', () => {
  test('resolves the inner value when it beats the deadline', async () => {
    await expect(withTimeout(Promise.resolve(42), 1000, 'op')).resolves.toBe(42);
  });

  test('rejects with a labeled timeout when the deadline wins', async () => {
    await expect(withTimeout(new Promise<number>(() => {}), 20, 'pull')).rejects.toThrow(
      'pull timed out after 20ms',
    );
  });
});
