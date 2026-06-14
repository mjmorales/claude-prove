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
 * anomaly pass (`cloud-sync-s1-anomaly`) drains.
 */

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
  // Resolve the local db path ONCE via the canonical git-root walk so the
  // store open and the sync engine materialize the same file.
  const dbPath = resolveDbPath({ cwd: workspaceRoot });
  const store = await openScrumStore({ override: dbPath });
  const result = await runSyncPhase(store, workspaceRoot, dbPath, boundary, deps);
  return { store, result };
}

/**
 * Run the session-boundary sync against an already-open local store. No-op
 * (returns `LOCAL_ONLY`) unless `cloud.enabled && token` resolve — the hard
 * default-off gate. Never throws: a degrade warns and returns
 * `{ attempted: true, ok: false }` so the caller proceeds local. `dbPath` is
 * the resolved local file both the store and the sync engine share.
 */
export async function runSyncPhase(
  store: ScrumStore,
  workspaceRoot: string,
  dbPath: string,
  boundary: SyncBoundary,
  deps: SyncLifecycleDeps = {},
): Promise<SyncPhaseResult> {
  const cloud = readCloudConfig(workspaceRoot);
  // Default-off: absent or disabled cloud block ⇒ dead code, zero network.
  if (cloud === null || !cloud.enabled) return LOCAL_ONLY;

  const resolveToken = deps.resolveToken ?? defaultResolveToken();
  const token = resolveToken(cloud.dbName);
  // No machine-local token ⇒ this machine has not provisioned ⇒ local-only.
  if (token === null || token.length === 0) return LOCAL_ONLY;

  const warn = deps.warn ?? ((line: string) => process.stderr.write(line));
  const timeoutMs = deps.timeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS;
  const coords: CloudCoordinates = { org: cloud.org, dbName: cloud.dbName };

  const collisions: SurfacedCollision[] = [];

  let sync: SyncDatabase | undefined;
  try {
    // Pre-pull snapshot: the engine's transform callback is synchronous, so
    // `keyExists` checks a frozen Set of the existing secondary-UNIQUE keys
    // taken before replay rather than probing the live (async) connection.
    const keyExists = await snapshotKeyExists(store);
    const transform = makeScrumSyncTransform({
      keyExists,
      onCollision: (c) => collisions.push(c),
    });

    sync = await openSyncDatabase({ path: dbPath, coords, token, transform }, deps);

    if (boundary === 'session-start') {
      // Flush a possibly-missed prior stop, then pull peer changes. Order:
      // push our queued local writes up first so a pull's replay rebases onto
      // an already-flushed remote, minimizing the collision surface.
      await withTimeout(sync.push(), timeoutMs, 'flush-push');
      await withTimeout(sync.pull(), timeoutMs, 'pull');
    } else {
      // stop / subagent-stop: push local writes to the remote.
      await withTimeout(sync.push(), timeoutMs, 'push');
    }

    return { attempted: true, ok: true, collisions };
  } catch (err) {
    const reason = errMsg(err);
    warn(`scrum sync (${boundary}): ${reason} — proceeding local\n`);
    return { attempted: true, ok: false, collisions, degradedReason: reason };
  } finally {
    if (sync) {
      // Closing the sync handle must never turn a successful command into a
      // failure — swallow a close error after warning.
      try {
        await sync.close();
      } catch (closeErr) {
        warn(`scrum sync (${boundary}): close failed: ${errMsg(closeErr)}\n`);
      }
    }
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
