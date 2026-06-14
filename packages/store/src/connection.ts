import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { type Database, connect } from '@tursodatabase/database';
import { type ResolveOptions, resolveDbPath } from './paths';

// Runtime contract: this package runs on the @tursodatabase/database local
// engine, an async NAPI driver. Its NAPI binding resolves only from a local
// node_modules — there is no global-cache fallback — so every consumer keeps
// the package in its dependency tree. The whole driver surface is async:
// `connect(path)` returns a Promise<Database>, and `prepare`/`run`/`all`/`get`/
// `exec` all return Promises.
//
// await-prepare rule: ALWAYS `await db.prepare(sql)` before binding or
// executing. The local engine sometimes tolerates an unawaited Statement, but
// shared store code must never lean on that — an unawaited prepare can bind
// against an unresolved handle and silently misbehave.
//
// Transactions: the driver exposes no usable per-call transaction wrapper and no
// `db.pragma()` shortcut for our purposes. BEGIN IMMEDIATE / COMMIT / ROLLBACK
// and SAVEPOINT / RELEASE / ROLLBACK TO all run through `db.exec(...)`. A
// nested BEGIN errors ("cannot start a transaction within a transaction"), so
// the canonical `withTx` helper tracks transaction depth and switches to
// savepoints when re-entrant — see its docstring.

export type SqlParam = string | number | bigint | boolean | null | Uint8Array;

export interface StoreOptions extends ResolveOptions {
  /** Explicit database path. `:memory:` selects an in-memory SQLite instance. */
  path?: string;
  /** Open the database read-only. Defaults to false. */
  readonly?: boolean;
  /**
   * Busy-timeout in milliseconds the driver waits for the file lock at open and
   * on every locked operation before failing. Defaults to `DEFAULT_BUSY_TIMEOUT_MS`.
   */
  busyTimeoutMs?: number;
}

const MEMORY_PATH = ':memory:';

/**
 * Default wall-clock budget (ms) for acquiring the database file lock at open.
 * The local engine takes an exclusive file lock when it opens a writable
 * connection; with no envelope, two opens racing on the same `.prove/prove.db`
 * collide and one hard-fails at `connect()` with "File is locked by another
 * process" instead of waiting. Claude Code fires reconciliation hooks
 * (scrum/acb) in concurrent batches, so this race is the normal case, not an
 * edge — a lost open silently drops the hook's reconciliation write.
 *
 * The driver's native `timeout` option governs in-flight SQLITE_BUSY on a live
 * connection, NOT the file-lock acquisition during `connect()` itself, so the
 * open path needs its own retry envelope: `openStore` retries `connect()` on a
 * lock error with jittered backoff until this budget elapses, turning a lost
 * write into a brief wait. Five seconds absorbs realistic hook bursts while
 * still surfacing a genuine deadlock.
 */
export const DEFAULT_BUSY_TIMEOUT_MS = 5000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * True when an error is the driver's file-lock-contention failure at open. The
 * local engine reports this as a "Locking error: Failed locking file ... File
 * is locked by another process"; matching the stable substrings keeps the
 * retry envelope from swallowing unrelated open failures (corruption, bad path,
 * schema mismatch), which must surface immediately.
 */
function isLockContentionError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /Locking error|File is locked/i.test(message);
}

/**
 * Wraps a @tursodatabase/database Database with a narrower async API aimed at
 * domain packages.
 *
 * Domain code should prefer `run(sql, params?)` / `all(sql, params?)` /
 * `get(sql, params?)` over reaching into `getDb()` for raw access; the raw
 * accessor exists for migrations, transactions (`withTx`), and other
 * low-level operations. Every method here awaits its `prepare()` per the
 * await-prepare rule documented at the top of this file.
 */
export class Store {
  readonly path: string;
  private db: Database | null;
  /**
   * Transaction nesting depth. 0 = no open transaction; `withTx` increments on
   * entry and switches BEGIN IMMEDIATE vs SAVEPOINT off this counter.
   */
  txDepth: number;

  constructor(path: string, db: Database) {
    this.path = path;
    this.db = db;
    this.txDepth = 0;
  }

  getDb(): Database {
    if (!this.db) throw new Error('Store is closed');
    return this.db;
  }

  async run(sql: string, params: SqlParam[] = []): Promise<void> {
    const stmt = await this.getDb().prepare(sql);
    await stmt.run(...params);
  }

  async all<T = Record<string, unknown>>(sql: string, params: SqlParam[] = []): Promise<T[]> {
    const stmt = await this.getDb().prepare(sql);
    return (await stmt.all(...params)) as T[];
  }

  async get<T = Record<string, unknown>>(
    sql: string,
    params: SqlParam[] = [],
  ): Promise<T | undefined> {
    const stmt = await this.getDb().prepare(sql);
    const row = await stmt.get(...params);
    return (row ?? undefined) as T | undefined;
  }

  async exec(sql: string): Promise<void> {
    await this.getDb().exec(sql);
  }

  close(): void {
    if (this.db) {
      // The driver's close() returns a Promise that resolves teardown; the
      // store contract is synchronous, so fire-and-forget — there is nothing
      // to observe after the handle is dropped.
      this.db.close();
      this.db = null;
    }
  }
}

/**
 * Run `fn` inside a transaction on `store`, committing on success and rolling
 * back (re-raising the original error) on throw.
 *
 * Re-entrancy: at depth 0 this issues `BEGIN IMMEDIATE` + `COMMIT`/`ROLLBACK`;
 * when already inside a transaction it issues `SAVEPOINT sp<n>` +
 * `RELEASE sp<n>` / `ROLLBACK TO sp<n>` (a nested `BEGIN` would error). This
 * preserves the nesting contract callers like cancelTaskCascade and the
 * migration runner depend on. Depth is tracked on `store.txDepth`.
 */
export async function withTx<T>(store: Store, fn: () => Promise<T>): Promise<T> {
  const depth = store.txDepth;
  const savepoint = `sp${depth}`;
  const begin = depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`;
  const commit = depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`;
  const rollback = depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}`;

  await store.exec(begin);
  store.txDepth = depth + 1;
  try {
    const value = await fn();
    await store.exec(commit);
    return value;
  } catch (err) {
    // Re-raise the original error after unwinding; a savepoint rollback must
    // also RELEASE so the savepoint name is not left dangling on the stack.
    await store.exec(rollback);
    if (depth !== 0) await store.exec(`RELEASE ${savepoint}`);
    throw err;
  } finally {
    store.txDepth = depth;
  }
}

/**
 * Open a prove store connection. With no options, resolves `path` via
 * `resolveDbPath()` against the enclosing git repository. File-backed
 * stores enable WAL journaling and foreign keys; `:memory:` stores skip
 * those pragmas. A concurrent open racing on the file lock is retried with
 * jittered backoff until `busyTimeoutMs` elapses instead of hard-failing (see
 * `DEFAULT_BUSY_TIMEOUT_MS`). Async because the driver's `connect()` is async.
 */
export async function openStore(opts: StoreOptions = {}): Promise<Store> {
  const path = opts.path ?? resolveDbPath({ cwd: opts.cwd, override: opts.override });
  if (path !== MEMORY_PATH && !opts.readonly) {
    mkdirSync(dirname(path), { recursive: true });
  }
  // `:memory:` stores are private to one connection and never contend, so the
  // busy-timeout (native `timeout` for in-flight SQLITE_BUSY + open retry
  // envelope) applies only to file-backed opens.
  const budgetMs = opts.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  const connectOpts =
    path === MEMORY_PATH ? {} : { timeout: budgetMs, ...(opts.readonly ? { readonly: true } : {}) };
  const db = await connectWithBusyRetry(path, connectOpts, budgetMs);
  if (path !== MEMORY_PATH) {
    // WAL is a journal-mode write — illegal on a readonly handle (errors or
    // no-ops depending on the SQLite build). foreign_keys is a harmless
    // connection-scoped pragma either way.
    if (!opts.readonly) await db.exec('PRAGMA journal_mode = WAL');
    await db.exec('PRAGMA foreign_keys = ON');
  }
  return new Store(path, db);
}

/**
 * `connect()` with a bounded busy-retry envelope on file-lock contention. The
 * native `timeout` option does not cover the exclusive file lock the engine
 * takes during `connect()`, so a racing open fails immediately; this retries
 * the open on a lock-contention error with exponential backoff plus jitter
 * (jitter de-synchronizes a thundering herd of hooks) until `budgetMs` of
 * wall-clock elapses, then re-raises the last error. Non-lock errors propagate
 * on the first attempt. In-memory stores never reach this path.
 */
async function connectWithBusyRetry(
  path: string,
  connectOpts: Record<string, unknown>,
  budgetMs: number,
): Promise<Database> {
  const deadline = Date.now() + budgetMs;
  let backoffMs = 5;
  for (let attempt = 0; ; attempt++) {
    try {
      return await connect(path, connectOpts);
    } catch (err) {
      if (!isLockContentionError(err) || Date.now() >= deadline) throw err;
      // Sleep the smaller of the backoff and the time left, with jitter in
      // [0, backoff) so concurrent retriers spread out instead of re-colliding.
      const jittered = backoffMs + Math.random() * backoffMs;
      const remaining = deadline - Date.now();
      await sleep(Math.max(0, Math.min(jittered, remaining)));
      backoffMs = Math.min(backoffMs * 2, 100);
    }
  }
}
