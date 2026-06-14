/**
 * Tests for the cloud sync-enabled store open (`sync-connection.ts`).
 *
 * Every test injects a FAKE `connectSync` through the `SyncOpenDeps` seam, so
 * the sync lifecycle, the transform registration, and the pull/push surface are
 * exercised WITHOUT ever opening a network connection — mirroring how
 * `provision.test.ts` injects `@tursodatabase/api`. There is no Turso org or
 * token in this environment and these tests never reach the real engine.
 */

import { describe, expect, test } from 'bun:test';
import type { DatabaseRowMutation } from '@tursodatabase/sync';
import {
  type SyncConnectOptions,
  type SyncEngineDatabase,
  openSyncDatabase,
  syncRemoteUrl,
} from './sync-connection';

/** A fake sync `Database` recording every call the lifecycle makes. */
interface FakeEngine extends SyncEngineDatabase {
  calls: string[];
  connectOpts: SyncConnectOptions | null;
}

function makeFakeEngine(overrides: Partial<SyncEngineDatabase> = {}): FakeEngine {
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
    ...overrides,
  };
  return engine;
}

describe('syncRemoteUrl', () => {
  test('builds the canonical libsql hostname from org + db name', () => {
    expect(syncRemoteUrl({ org: 'acme', dbName: 'prove-acme' })).toBe(
      'libsql://prove-acme-acme.turso.io',
    );
  });
});

describe('openSyncDatabase', () => {
  test('assembles url + token + transform and connects (no network — DI seam)', async () => {
    const engine = makeFakeEngine();
    let captured: SyncConnectOptions | null = null;
    const transform = (_m: DatabaseRowMutation) => null;

    const sync = await openSyncDatabase(
      {
        path: '/tmp/x/.prove/prove.db',
        coords: { org: 'acme', dbName: 'prove-acme' },
        token: 'db-scoped-token',
        transform,
      },
      {
        connectSync: async (opts) => {
          captured = opts;
          engine.connectOpts = opts;
          return engine;
        },
      },
    );

    // The url is derived deterministically; the token + transform pass through.
    expect(captured).not.toBeNull();
    const opts = captured as unknown as SyncConnectOptions;
    expect(opts.url).toBe('libsql://prove-acme-acme.turso.io');
    expect(opts.authToken).toBe('db-scoped-token');
    expect(opts.path).toBe('/tmp/x/.prove/prove.db');
    expect(opts.transform).toBe(transform);
    // connect() fires exactly once at open.
    expect(engine.calls).toEqual(['connect']);

    // The returned handle delegates pull/push/close to the engine.
    await sync.pull();
    await sync.push();
    await sync.close();
    expect(engine.calls).toEqual(['connect', 'pull', 'push', 'close']);
  });

  test('a connect() rejection propagates (the lifecycle catches it, not this layer)', async () => {
    const engine = makeFakeEngine({
      async connect() {
        throw new Error('offline');
      },
    });
    await expect(
      openSyncDatabase(
        {
          path: '/tmp/x/.prove/prove.db',
          coords: { org: 'acme', dbName: 'prove-acme' },
          token: 't',
          transform: () => null,
        },
        { connectSync: async () => engine },
      ),
    ).rejects.toThrow('offline');
  });
});
