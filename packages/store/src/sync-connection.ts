/**
 * Cloud sync-enabled store open for the optional Turso sync layer.
 *
 * `openSyncDatabase` is the engine half of the session-boundary sync lifecycle:
 * it builds the `@tursodatabase/sync` `Database` from the project's non-secret
 * `{ org, group, db_name }` cloud config plus the machine-local db-scoped token,
 * registers the scrum `transform` hook at `connect()`, and returns a thin
 * `SyncDatabase` handle offering `pull()` / `push()` over the live connection.
 *
 * This module is DEAD CODE when `cloud.enabled` is absent or false — the CLI
 * lifecycle only reaches it after gating on `cloud.enabled && token && online`,
 * so a local-only project never constructs a sync `Database` and never touches
 * the network. The local store open path (`openStore` / `openScrumStore`) is
 * entirely independent and unchanged.
 *
 * Dependency injection: the `@tursodatabase/sync` `connect()` is reached through
 * the `connectSync` seam (default wires the real package). Tests inject a fake
 * `connect()` so the sync lifecycle, the transform registration, and the
 * collision sink are exercised without ever opening a network connection —
 * mirroring how `provisionDatabase` injects `@tursodatabase/api`.
 *
 * Transform + collision sink: the scrum `transform` (built by
 * `makeScrumSyncTransform` in the CLI layer) maps a known secondary-UNIQUE
 * collision to a `skip` and records it through the caller's `onCollision` sink.
 * The sink is wired by the lifecycle and DRAINED by the post-pull anomaly pass —
 * every surfaced collision becomes an
 * anomaly the operator can deconflict, never a hard `pull()`/`push()` failure.
 */

import type { Database } from '@tursodatabase/database';
import type { DatabaseRowMutation, DatabaseRowTransformResult } from '@tursodatabase/sync';

/**
 * The minimal `@tursodatabase/sync` `Database` surface the sync lifecycle uses.
 * Declared locally (rather than importing the concrete class) so the injection
 * seam stays narrow and tests pass a hand-rolled fake — the same pattern
 * `provision.ts` uses for `TursoApiClient`.
 */
export interface SyncEngineDatabase {
  /** Connect + initialize on a clean start; registers the `transform` hook. */
  connect(): Promise<void>;
  /** Pull remote changes (rollback → apply-remote → replay-local, atomic). */
  pull(): Promise<boolean>;
  /** Push queued local changes to the remote primary. */
  push(): Promise<void>;
  /** Close the sync connection. */
  close(): Promise<void>;
}

/** The `@tursodatabase/sync` `connect(opts)` options the lifecycle supplies. */
export interface SyncConnectOptions {
  /** Local file the synced db materializes at (the project's `.prove/prove.db`). */
  path: string;
  /** Remote primary URL (`libsql://<db_name>-<org>.turso.io`). */
  url: string;
  /** Db-scoped sync token (the machine-local least-privilege secret). */
  authToken: string;
  /** The scrum conflict-recovery transform fired per CDC mutation. */
  transform: (mutation: DatabaseRowMutation) => DatabaseRowTransformResult;
}

/** Factory the engine calls to build a sync `Database`. */
export type ConnectSync = (opts: SyncConnectOptions) => Promise<SyncEngineDatabase>;

/** Non-secret cloud coordinates needed to build the remote URL. */
export interface CloudCoordinates {
  /** Turso organization slug that owns the database. */
  org: string;
  /** Cloud database name (e.g. `prove-<slug>`). */
  dbName: string;
}

/** Injectable dependencies — the default wires the real `@tursodatabase/sync`. */
export interface SyncOpenDeps {
  /** Build + connect a sync `Database`. Default: `@tursodatabase/sync`'s `connect`. */
  connectSync: ConnectSync;
}

/** A live sync handle: the connected `Database` plus its pull/push surface. */
export interface SyncDatabase {
  /**
   * The connected synced handle. The scrum store MUST be built on this
   * connection (`openScrumStore({ connection })`) so its writes flow through the
   * sync engine's per-handle change-capture and replicate on `push()`. A store
   * opened as a separate connection to the same file is invisible to sync.
   */
  connection: Database;
  /** Pull remote changes onto the local store (atomic rollback-and-replay). */
  pull(): Promise<boolean>;
  /** Push queued local changes to the remote primary. */
  push(): Promise<void>;
  /** Close the sync connection. */
  close(): Promise<void>;
}

/**
 * Build the canonical Turso libsql URL for a cloud database. The hostname
 * follows Turso's `<db_name>-<org>.turso.io` convention, so the URL is derived
 * deterministically from the non-secret config without a Platform API lookup.
 */
export function syncRemoteUrl(coords: CloudCoordinates): string {
  return `libsql://${coords.dbName}-${coords.org}.turso.io`;
}

/**
 * Default dep: the real `@tursodatabase/sync` `connect()`. The import is dynamic
 * so the sync NAPI addon is loaded ONLY on the cloud-enabled path — a local-only
 * project (the default) never pulls the second native addon into the process.
 */
function defaultDeps(): SyncOpenDeps {
  return {
    connectSync: async (opts) => {
      const { connect } = await import('@tursodatabase/sync');
      return (await connect({
        path: opts.path,
        url: opts.url,
        authToken: opts.authToken,
        transform: opts.transform,
      })) as unknown as SyncEngineDatabase;
    },
  };
}

/**
 * Open a sync-enabled connection to the project's cloud database and connect it,
 * registering the supplied `transform` hook. Returns a `SyncDatabase` handle for
 * the session-boundary `pull()` / `push()` calls.
 *
 * Callers MUST have already gated on `cloud.enabled && token` — this function
 * assumes a non-empty token and live cloud config. `deps` is partially
 * overridable; an unset field falls back to its real default, so tests inject
 * only `connectSync`.
 */
export async function openSyncDatabase(
  input: {
    /** Local db path the synced database materializes at. */
    path: string;
    /** Non-secret cloud coordinates (org + db name). */
    coords: CloudCoordinates;
    /** Db-scoped sync token (machine-local secret). */
    token: string;
    /** Per-CDC-mutation conflict-recovery transform. */
    transform: (mutation: DatabaseRowMutation) => DatabaseRowTransformResult;
  },
  deps: Partial<SyncOpenDeps> = {},
): Promise<SyncDatabase> {
  const { connectSync } = { ...defaultDeps(), ...deps };

  const db = await connectSync({
    path: input.path,
    url: syncRemoteUrl(input.coords),
    authToken: input.token,
    transform: input.transform,
  });
  await db.connect();

  return {
    // The @tursodatabase/sync handle is structurally a `Database` (exec/prepare/
    // close) plus pull/push; expose it so the scrum store binds to THIS handle.
    connection: db as unknown as Database,
    pull: () => db.pull(),
    push: () => db.push(),
    close: () => db.close(),
  };
}
