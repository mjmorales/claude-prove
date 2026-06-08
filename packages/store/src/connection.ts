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
}

const MEMORY_PATH = ':memory:';

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
 * those pragmas. Async because the driver's `connect()` is async.
 */
export async function openStore(opts: StoreOptions = {}): Promise<Store> {
  const path = opts.path ?? resolveDbPath({ cwd: opts.cwd, override: opts.override });
  if (path !== MEMORY_PATH && !opts.readonly) {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = opts.readonly ? await connect(path, { readonly: true }) : await connect(path);
  if (path !== MEMORY_PATH) {
    // WAL is a journal-mode write — illegal on a readonly handle (errors or
    // no-ops depending on the SQLite build). foreign_keys is a harmless
    // connection-scoped pragma either way.
    if (!opts.readonly) await db.exec('PRAGMA journal_mode = WAL');
    await db.exec('PRAGMA foreign_keys = ON');
  }
  return new Store(path, db);
}
