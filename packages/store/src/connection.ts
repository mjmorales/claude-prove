import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { type ResolveOptions, resolveDbPath } from './paths';

export interface StoreOptions extends ResolveOptions {
  /** Explicit database path. `:memory:` selects an in-memory SQLite instance. */
  path?: string;
  /** Open the database read-only. Defaults to false. */
  readonly?: boolean;
}

const MEMORY_PATH = ':memory:';

/**
 * Wraps a bun:sqlite Database with a narrower API aimed at domain packages.
 *
 * Domain code should prefer `run(sql, params?)` and `all(sql, params?)`
 * over reaching into `getDb()` for raw access; the raw accessor exists
 * for migrations and other low-level operations that need features like
 * prepared-statement caching or transactions.
 */
export class Store {
  readonly path: string;
  private db: Database | null;

  constructor(path: string, db: Database) {
    this.path = path;
    this.db = db;
  }

  getDb(): Database {
    if (!this.db) throw new Error('Store is closed');
    return this.db;
  }

  run(sql: string, params: SQLQueryBindings[] = []): void {
    const stmt = this.getDb().prepare(sql);
    stmt.run(...params);
  }

  all<T = Record<string, unknown>>(sql: string, params: SQLQueryBindings[] = []): T[] {
    const stmt = this.getDb().prepare<T, SQLQueryBindings[]>(sql);
    return stmt.all(...params);
  }

  exec(sql: string): void {
    this.getDb().exec(sql);
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

/**
 * Open a prove store connection. With no options, resolves `path` via
 * `resolveDbPath()` against the enclosing git repository. File-backed
 * stores enable WAL journaling and foreign keys; `:memory:` stores skip
 * those pragmas.
 */
export function openStore(opts: StoreOptions = {}): Store {
  const path = opts.path ?? resolveDbPath({ cwd: opts.cwd, override: opts.override });
  if (path !== MEMORY_PATH && !opts.readonly) {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = opts.readonly
    ? new Database(path, { readonly: true })
    : new Database(path, { create: true });
  if (path !== MEMORY_PATH) {
    db.run('PRAGMA journal_mode = WAL');
    db.run('PRAGMA foreign_keys = ON');
  }
  return new Store(path, db);
}
