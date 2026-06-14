/**
 * Tests for the scrum CLI store open + the session-boundary cloud sync lifecycle
 * (`cli-store.ts` + `sync-lifecycle.ts`).
 *
 * THREE INVARIANTS exercised here:
 *   1. DEFAULT-OFF — with `cloud.enabled` absent/false (the default), the sync
 *      path is DEAD CODE: `runSyncPhase` / `openStoreWithSync` perform ZERO
 *      network (the injected `connectSync` is never called) and behave exactly as
 *      the local path. `openCliStore` is unchanged on the local path.
 *   2. GATED LIFECYCLE — only when `cloud.enabled && token` resolve does the
 *      lifecycle reach the engine: pull(+flush-push) on session-start,
 *      push on stop/subagent-stop.
 *   3. DEGRADE — pull/push are wrapped in try/catch + a short timeout; on
 *      failure the lifecycle WARNS and proceeds local (the store stays usable,
 *      `ok: false`) — the command's primary output never blocks on the network.
 *
 * Every test injects a FAKE `connectSync` and a `resolveToken` stub through the
 * `SyncLifecycleDeps` seam, so nothing here ever opens a real cloud connection.
 * Stores live in `.git`-shaped tmpdirs; the machine-config token is redirected
 * to a tmp dir via `CLAUDE_PROVE_MACHINE_CONFIG_DIR`, never the real home file.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SyncConnectOptions, SyncEngineDatabase, SyncOpenDeps } from '@claude-prove/store';
import { openScrumStore } from '../store';
import { openCliStore } from './cli-store';
import {
  type SyncLifecycleDeps,
  openStoreWithSync,
  runSyncPhase,
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

/** A fake sync engine recording the lifecycle's call sequence. */
interface FakeEngine extends SyncEngineDatabase {
  calls: string[];
  connectOpts: SyncConnectOptions | null;
}

function makeFakeEngine(behavior: Partial<SyncEngineDatabase> = {}): FakeEngine {
  const engine: FakeEngine = {
    calls: [],
    connectOpts: null,
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
    },
    ...behavior,
  };
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
});
afterEach(() => {
  for (const p of projects) rmSync(p, { recursive: true, force: true });
});

function project(cloud?: Record<string, unknown> | false): string {
  const root = makeProject(cloud);
  projects.push(root);
  return root;
}

describe('default-off invariant — zero network, behaves as local', () => {
  test('cloud block absent: runSyncPhase is a no-op, connectSync never called', async () => {
    const root = project(false);
    const store = await openScrumStore({ override: join(root, '.prove', 'prove.db') });
    try {
      const engine = makeFakeEngine();
      const warns: string[] = [];
      const { deps, connectCalls } = makeDeps(engine, { warns });

      const result = await runSyncPhase(
        store,
        root,
        join(root, '.prove', 'prove.db'),
        'session-start',
        deps,
      );

      expect(result).toEqual({ attempted: false, ok: true, collisions: [] });
      expect(connectCalls.count).toBe(0);
      expect(engine.calls).toEqual([]);
      expect(warns).toEqual([]);
    } finally {
      store.close();
    }
  });

  test('cloud.enabled false: runSyncPhase is a no-op, connectSync never called', async () => {
    const root = project({ enabled: false, org: 'acme', group: 'prove', db_name: 'prove-acme' });
    const store = await openScrumStore({ override: join(root, '.prove', 'prove.db') });
    try {
      const engine = makeFakeEngine();
      const { deps, connectCalls } = makeDeps(engine);
      const result = await runSyncPhase(
        store,
        root,
        join(root, '.prove', 'prove.db'),
        'stop',
        deps,
      );
      expect(result.attempted).toBe(false);
      expect(connectCalls.count).toBe(0);
    } finally {
      store.close();
    }
  });

  test('openStoreWithSync default-off: returns a usable local store, zero network', async () => {
    const root = project(false);
    const engine = makeFakeEngine();
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
  test('null token: no network, attempted false', async () => {
    const root = project(CLOUD_ON);
    const store = await openScrumStore({ override: join(root, '.prove', 'prove.db') });
    try {
      const engine = makeFakeEngine();
      const { deps, connectCalls } = makeDeps(engine, { token: null, warns: [] });
      const result = await runSyncPhase(
        store,
        root,
        join(root, '.prove', 'prove.db'),
        'session-start',
        deps,
      );
      expect(result.attempted).toBe(false);
      expect(connectCalls.count).toBe(0);
    } finally {
      store.close();
    }
  });
});

describe('gated lifecycle — pull/push/flush-push per boundary', () => {
  test('session-start: flush-push then pull, connect once, close once', async () => {
    const root = project(CLOUD_ON);
    const store = await openScrumStore({ override: join(root, '.prove', 'prove.db') });
    try {
      const engine = makeFakeEngine();
      const { deps, connectCalls } = makeDeps(engine);
      const result = await runSyncPhase(
        store,
        root,
        join(root, '.prove', 'prove.db'),
        'session-start',
        deps,
      );
      expect(result.attempted).toBe(true);
      expect(result.ok).toBe(true);
      expect(connectCalls.count).toBe(1);
      // flush-push recovers a missed prior stop, then pull peer changes.
      expect(engine.calls).toEqual(['connect', 'push', 'pull', 'close']);
      // The remote url + token were assembled from config + the token stub.
      expect(engine.connectOpts?.url).toBe('libsql://prove-acme-acme.turso.io');
      expect(engine.connectOpts?.authToken).toBe('db-scoped-token');
    } finally {
      store.close();
    }
  });

  test('stop: push only', async () => {
    const root = project(CLOUD_ON);
    const store = await openScrumStore({ override: join(root, '.prove', 'prove.db') });
    try {
      const engine = makeFakeEngine();
      const { deps } = makeDeps(engine);
      await runSyncPhase(store, root, join(root, '.prove', 'prove.db'), 'stop', deps);
      expect(engine.calls).toEqual(['connect', 'push', 'close']);
    } finally {
      store.close();
    }
  });

  test('subagent-stop: push only', async () => {
    const root = project(CLOUD_ON);
    const store = await openScrumStore({ override: join(root, '.prove', 'prove.db') });
    try {
      const engine = makeFakeEngine();
      const { deps } = makeDeps(engine);
      await runSyncPhase(store, root, join(root, '.prove', 'prove.db'), 'subagent-stop', deps);
      expect(engine.calls).toEqual(['connect', 'push', 'close']);
    } finally {
      store.close();
    }
  });
});

describe('degrade — pull/push failure warns + proceeds local (exit 0, no block)', () => {
  test('a push rejection degrades: warns, ok=false, store still usable', async () => {
    const root = project(CLOUD_ON);
    const store = await openScrumStore({ override: join(root, '.prove', 'prove.db') });
    try {
      const engine = makeFakeEngine({
        async push() {
          throw new Error('transport reset');
        },
      });
      const warns: string[] = [];
      const { deps } = makeDeps(engine, { warns });

      const result = await runSyncPhase(
        store,
        root,
        join(root, '.prove', 'prove.db'),
        'stop',
        deps,
      );

      expect(result.attempted).toBe(true);
      expect(result.ok).toBe(false);
      expect(result.degradedReason).toContain('transport reset');
      expect(warns.join('')).toContain('proceeding local');
      // The local store survives the degrade — the primary output is unaffected.
      await store.createMilestone({ id: 'm1', title: 'survives' });
      expect((await store.getMilestone('m1'))?.title).toBe('survives');
    } finally {
      store.close();
    }
  });

  test('a hung pull is bounded by the timeout: degrades within budget', async () => {
    const root = project(CLOUD_ON);
    const store = await openScrumStore({ override: join(root, '.prove', 'prove.db') });
    try {
      const engine = makeFakeEngine({
        // Never resolves — only the timeout can end this op.
        pull: () => new Promise<boolean>(() => {}),
      });
      const warns: string[] = [];
      const { deps } = makeDeps(engine, { warns });

      const started = Date.now();
      const result = await runSyncPhase(
        store,
        root,
        join(root, '.prove', 'prove.db'),
        'session-start',
        deps,
      );
      const elapsed = Date.now() - started;

      expect(result.ok).toBe(false);
      expect(result.degradedReason).toContain('timed out');
      // The 200ms budget bounds the wait; a generous ceiling avoids flake.
      expect(elapsed).toBeLessThan(2000);
    } finally {
      store.close();
    }
  });

  test('an offline connect() fast-fails: degrades, store still local', async () => {
    const root = project(CLOUD_ON);
    const store = await openScrumStore({ override: join(root, '.prove', 'prove.db') });
    try {
      const engine = makeFakeEngine({
        async connect() {
          throw new Error('ENOTFOUND');
        },
      });
      const warns: string[] = [];
      const { deps } = makeDeps(engine, { warns });
      const result = await runSyncPhase(
        store,
        root,
        join(root, '.prove', 'prove.db'),
        'session-start',
        deps,
      );
      expect(result.ok).toBe(false);
      expect(warns.join('')).toContain('proceeding local');
    } finally {
      store.close();
    }
  });
});

describe('transform + collision sink — surfaced for the anomaly pass', () => {
  test('a secondary-UNIQUE INSERT on an existing key is skipped and surfaced', async () => {
    const root = project(CLOUD_ON);
    const store = await openScrumStore({ override: join(root, '.prove', 'prove.db') });
    try {
      // Seed an existing contributor so its slug is in the pre-pull snapshot.
      await store.registerContributor({ slug: 'alice', displayName: 'Alice' });

      // The fake engine fires the transform on connect, simulating a replay of a
      // peer's INSERT of a contributor with the SAME slug.
      const engine = makeFakeEngine({
        async connect() {
          engine.calls.push('connect');
          const out = engine.connectOpts?.transform?.({
            changeTime: 0,
            tableName: 'scrum_contributors',
            id: 1,
            changeType: 'insert' as never,
            after: { slug: 'alice', display_name: 'Alice (peer)' },
          });
          // The transform returns `skip` for a colliding INSERT.
          expect(out).toEqual({ operation: 'skip' });
        },
      });
      const { deps } = makeDeps(engine);

      const result = await runSyncPhase(
        store,
        root,
        join(root, '.prove', 'prove.db'),
        'session-start',
        deps,
      );

      // The collision was recorded into the sink the anomaly pass drains.
      expect(result.collisions).toHaveLength(1);
      expect(result.collisions[0]?.table).toBe('scrum_contributors');
      expect(result.collisions[0]?.key).toEqual({ slug: 'alice' });
    } finally {
      store.close();
    }
  });

  test('a non-colliding INSERT passes through (null) — no surfaced collision', async () => {
    const root = project(CLOUD_ON);
    const store = await openScrumStore({ override: join(root, '.prove', 'prove.db') });
    try {
      const engine = makeFakeEngine({
        async connect() {
          engine.calls.push('connect');
          const out = engine.connectOpts?.transform?.({
            changeTime: 0,
            tableName: 'scrum_contributors',
            id: 2,
            changeType: 'insert' as never,
            after: { slug: 'bob', display_name: 'Bob' },
          });
          expect(out).toBeNull();
        },
      });
      const { deps } = makeDeps(engine);
      const result = await runSyncPhase(
        store,
        root,
        join(root, '.prove', 'prove.db'),
        'session-start',
        deps,
      );
      expect(result.collisions).toEqual([]);
    } finally {
      store.close();
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
