/**
 * Session-boundary cloud sync lifecycle for the scrum store.
 *
 * Cadence (the no-daemon, per-invocation model): a `pull()` runs on
 * session-start (plus a cheap flush-`push()` at session-start to recover a
 * missed prior `stop`), and a `push()` runs on `stop` / `subagent-stop`. Every
 * other entry point — ordinary `scrum` commands and per-tool-event hooks
 * (`cafi gate`, `run-state`) — opens the store LOCAL via `openCliStore` and
 * performs ZERO network: the same reasoning that forbids a resident daemon
 * forbids syncing on every tool event.
 *
 * Hard gate: the lifecycle reaches the network ONLY when
 * `cloud.enabled && token && online`. With `cloud.enabled` absent/false (the
 * default), `runSyncPhase` never constructs a sync connection — the cloud path
 * is dead code and the command behaves exactly as the local path.
 *
 * Degradation contract: pull/push are wrapped in try/catch + a short timeout.
 * On ANY failure (offline fast-fail, timeout, transport error) the lifecycle
 * warns to stderr and proceeds local with exit 0 — the command's primary output
 * never blocks on the network. "Online" is folded into the timeout: an offline
 * machine fast-fails inside the budget and degrades identically.
 *
 * Conflict recovery: `makeScrumSyncTransform` is registered at `connect()` with
 * a SYNCHRONOUS `keyExists` bound to a pre-pull snapshot of the existing
 * secondary-UNIQUE keys (the engine's transform callback cannot be async). Each
 * surfaced collision is recorded into the `collisions` sink, which the post-pull
 * anomaly pass drains.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  type CloudCoordinates,
  type SyncDatabase,
  type SyncOpenDeps,
  openSyncDatabase,
  resolveCloudToken,
  resolveDbPath,
} from '@claude-prove/store';
import { readCloudConfig } from '../../store-provision';
import { type ScrumStore, openScrumStore } from '../store';
import { type KeyExists, type SurfacedCollision, makeScrumSyncTransform } from '../sync-transform';

/** Default wall-clock budget (ms) for a single pull or push before degrading. */
export const DEFAULT_SYNC_TIMEOUT_MS = 5000;

/** Which session boundary the sync phase fires at. */
export type SyncBoundary = 'session-start' | 'stop' | 'subagent-stop';

/**
 * The secondary-UNIQUE keys the transform guards, per table — mirrors the
 * mapping inside `makeScrumSyncTransform` so the pre-pull snapshot probes
 * exactly the keys the transform will check.
 */
const SNAPSHOT_KEYS: Record<string, string[]> = {
  scrum_contributors: ['slug'],
  scrum_acceptance_criteria: ['task_id', 'criterion_id'],
};

/** Resolve the db-scoped sync token for a cloud db. Default: machine config. */
export type ResolveToken = (dbName: string) => string | null;

/** Injectable seams for the sync lifecycle — production wires the real engine. */
export interface SyncLifecycleDeps extends Partial<SyncOpenDeps> {
  /** Resolve the db-scoped token. Default: `resolveCloudToken` (machine config). */
  resolveToken?: ResolveToken;
  /** Per-op timeout (ms). Default: `DEFAULT_SYNC_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Sink the warning text is written to. Default: `process.stderr.write`. */
  warn?: (line: string) => void;
}

/** Outcome of a sync phase — for the caller's digest / surfacing pass. */
export interface SyncPhaseResult {
  /** True when the cloud gate opened and a sync was attempted. */
  attempted: boolean;
  /** True when the attempted sync (pull/push) completed without degrading. */
  ok: boolean;
  /** Secondary-UNIQUE collisions the transform surfaced this phase. */
  collisions: SurfacedCollision[];
  /** A short reason the sync degraded, when `attempted && !ok`. */
  degradedReason?: string;
}

/** A no-op phase result — the local-only / gate-closed outcome. */
const LOCAL_ONLY: SyncPhaseResult = { attempted: false, ok: true, collisions: [] };

/**
 * Open the scrum store and, when the cloud gate is open for this boundary, run
 * the session-boundary sync around it. ALWAYS returns an open local `ScrumStore`
 * the caller works against — the sync is layered on top and never gates store
 * access. The returned `result` carries any surfaced collisions for the
 * post-pull anomaly pass.
 *
 * The caller owns the store's lifetime (must `store.close()`); the sync
 * connection is opened and closed inside this call.
 */
export async function openStoreWithSync(
  workspaceRoot: string,
  boundary: SyncBoundary,
  deps: SyncLifecycleDeps = {},
): Promise<{ store: ScrumStore; result: SyncPhaseResult }> {
  const session = await openSyncSession(workspaceRoot, deps);
  let result = session.result;
  // session-start: flush a possibly-missed prior stop up first (so a pull's
  // replay rebases onto an already-flushed remote, minimizing the collision
  // surface), then pull peers' changes so the digest reflects fresh state.
  // `result.ok` gates the caller's post-pull anomaly pass.
  if (boundary === 'session-start' && session.result.attempted && session.result.ok) {
    const flushed = await session.push();
    result = flushed.ok ? await session.pull() : flushed;
  }
  // The caller owns the store's lifetime (`store.close()` closes the synced
  // connection); ordinary `scrum` commands defer their push to the next boundary.
  return { store: session.store, result };
}

/**
 * A cloud-sync session: the scrum store — built ON the synced
 * `@tursodatabase/sync` connection when `cloud.enabled && token` resolve, so its
 * writes are captured by the engine's per-handle change-log and ride the next
 * `push()` — plus boundary `pull()` / `push()` and `close()`. With cloud
 * off/unprovisioned, or on any sync-open failure, the store is a plain local
 * store and pull/push are no-ops, so the command never blocks on the network.
 *
 * The change-log persists across connection opens, so ordinary `scrum` commands
 * open a session, write, and close WITHOUT pull/push (zero network); their writes
 * accumulate and ride the next session-boundary `push()`.
 */
export interface SyncSession {
  store: ScrumStore;
  /** The open result; `collisions` accumulates across this session's pull/push. */
  result: SyncPhaseResult;
  /** Pull peers' changes onto the local store (no-op when local-only). */
  pull(): Promise<SyncPhaseResult>;
  /** Push accumulated local writes to the remote (no-op when local-only). */
  push(): Promise<SyncPhaseResult>;
  /** Close the store and its underlying connection. */
  close(): void;
}

function localSession(store: ScrumStore): SyncSession {
  return {
    store,
    result: LOCAL_ONLY,
    pull: async () => LOCAL_ONLY,
    push: async () => LOCAL_ONLY,
    close: () => store.close(),
  };
}

/**
 * Open a cloud-sync session. No-op cloud path (returns a `localSession`) unless
 * `cloud.enabled && token` resolve — the hard default-off gate. Never throws on a
 * sync-open failure: it degrades to a local store and warns, so the command
 * proceeds. The returned `pull`/`push` are individually degrade-safe.
 */
export async function openSyncSession(
  workspaceRoot: string,
  deps: SyncLifecycleDeps = {},
  dbPath: string = resolveDbPath({ cwd: workspaceRoot }),
): Promise<SyncSession> {
  // `dbPath` defaults to the git-root-aware resolution the session-boundary hooks
  // use; ordinary commands pass a fixed `<root>/.prove/prove.db` join instead (so a
  // non-repo open does not throw on findGitRoot). The sync engine's connect() opens
  // the replica file but does NOT create its parent dir, so ensure `.prove/` exists
  // or a first cloud open fails with an I/O "entity not found" and degrades to
  // local. (The local openStore path mkdirs its own parent.)
  mkdirSync(dirname(dbPath), { recursive: true });
  const cloud = readCloudConfig(workspaceRoot);
  // Default-off: absent or disabled cloud block ⇒ dead code, zero network.
  if (cloud === null || !cloud.enabled)
    return localSession(await openScrumStore({ override: dbPath }));

  const resolveToken = deps.resolveToken ?? defaultResolveToken();
  const token = resolveToken(cloud.dbName);
  // No machine-local token ⇒ this machine has not provisioned ⇒ local-only.
  if (token === null || token.length === 0)
    return localSession(await openScrumStore({ override: dbPath }));

  const warn = deps.warn ?? ((line: string) => process.stderr.write(line));
  const timeoutMs = deps.timeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS;
  const coords: CloudCoordinates = { org: cloud.org, dbName: cloud.dbName };
  const collisions: SurfacedCollision[] = [];

  // The engine's transform callback is synchronous, so `keyExists` reads a frozen
  // snapshot of the existing secondary-UNIQUE keys, populated right after the
  // store opens (post-connect, pre-pull) through this mutable binding.
  let keyExists: KeyExists = () => false;
  const transform = makeScrumSyncTransform({
    keyExists: (table, key) => keyExists(table, key),
    onCollision: (c) => collisions.push(c),
  });

  let sync: SyncDatabase | undefined;
  try {
    sync = await openSyncDatabase({ path: dbPath, coords, token, transform }, deps);
    // Build the scrum store ON the synced connection so its writes flow through
    // the engine's change-capture and replicate on push().
    const store = await openScrumStore({ connection: sync.connection });
    keyExists = await snapshotKeyExists(store);
    const liveSync = sync;
    const runPhase = async (
      op: () => Promise<unknown>,
      label: string,
    ): Promise<SyncPhaseResult> => {
      try {
        await withTimeout(op(), timeoutMs, label);
        return { attempted: true, ok: true, collisions };
      } catch (err) {
        const reason = errMsg(err);
        warn(`scrum sync (${label}): ${reason} — proceeding local\n`);
        return { attempted: true, ok: false, collisions, degradedReason: reason };
      }
    };
    return {
      store,
      result: { attempted: true, ok: true, collisions },
      pull: () => runPhase(() => liveSync.pull(), 'pull'),
      push: () => runPhase(() => liveSync.push(), 'push'),
      close: () => store.close(),
    };
  } catch (err) {
    // Sync open failed (offline, transport): degrade to a local-only store so the
    // command proceeds. Writes made this session are NOT captured by sync and
    // replicate only once a later open reconnects.
    const reason = errMsg(err);
    warn(`scrum sync: ${reason} — proceeding local\n`);
    if (sync) {
      try {
        await sync.close();
      } catch (closeErr) {
        warn(`scrum sync close: ${errMsg(closeErr)}\n`);
      }
    }
    const store = await openScrumStore({ override: dbPath });
    const degraded: SyncPhaseResult = {
      attempted: true,
      ok: false,
      collisions,
      degradedReason: reason,
    };
    return {
      store,
      result: degraded,
      pull: async () => degraded,
      push: async () => degraded,
      close: () => store.close(),
    };
  }
}

/**
 * Snapshot every existing secondary-UNIQUE key into an in-memory Set and return
 * a SYNCHRONOUS membership probe over it. Taken once before pull/push so the
 * engine's sync `transform` callback can decide a collision without an async
 * driver round-trip. A null/absent key column is skipped (SQLite treats
 * distinct NULLs as non-equal, so it cannot collide).
 */
async function snapshotKeyExists(store: ScrumStore): Promise<KeyExists> {
  const present = new Set<string>();
  const raw = store.getStore();
  for (const [table, columns] of Object.entries(SNAPSHOT_KEYS)) {
    const cols = columns.join(', ');
    let rows: Record<string, unknown>[];
    try {
      rows = await raw.all<Record<string, unknown>>(`SELECT ${cols} FROM ${table}`);
    } catch {
      // A missing table (a partially-migrated store) just yields no keys for it.
      rows = [];
    }
    for (const row of rows) {
      const composite = compositeKey(columns, row);
      if (composite !== null) present.add(`${table} ${composite}`);
    }
  }
  return (table: string, key: Record<string, unknown>) => {
    const columns = SNAPSHOT_KEYS[table];
    if (columns === undefined) return false;
    const composite = compositeKey(columns, key);
    if (composite === null) return false;
    return present.has(`${table} ${composite}`);
  };
}

/**
 * Build a stable composite-key string from the given columns, or null when any
 * column is null/undefined (an unconstrained key that cannot collide). Values
 * are NUL-separated so distinct tuples never alias (no id contains a NUL byte).
 */
function compositeKey(columns: string[], row: Record<string, unknown>): string | null {
  const parts: string[] = [];
  for (const column of columns) {
    const value = row[column];
    if (value === null || value === undefined) return null;
    parts.push(String(value));
  }
  return parts.join('\u0001');
}

/**
 * Race `promise` against a `timeoutMs` deadline. Rejects with a labeled
 * timeout error when the deadline wins, so an offline/hung sync degrades within
 * the budget instead of blocking the command's primary output. The timer is
 * always cleared so a settled promise never leaks a pending handle.
 */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** Default token resolver: the machine-config db-scoped token. */
function defaultResolveToken(): ResolveToken {
  return (dbName: string) => resolveCloudToken(dbName);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
