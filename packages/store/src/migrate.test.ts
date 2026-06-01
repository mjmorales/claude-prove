import { afterEach, describe, expect, test } from 'bun:test';
import { type Store, openStore } from './connection';
import { MigrationError, dropAllDomainTables, runMigrations } from './migrate';
import { clearRegistry, registerSchema } from './registry';

function makeStore(): Store {
  return openStore({ path: ':memory:' });
}

describe('runMigrations', () => {
  afterEach(() => {
    clearRegistry();
  });

  test('applies all pending migrations on a fresh store', () => {
    registerSchema({
      domain: 'widgets',
      migrations: [
        {
          version: 1,
          description: 'create widgets table',
          up: (db) => db.run('CREATE TABLE widgets (id INTEGER PRIMARY KEY)'),
        },
        {
          version: 2,
          description: 'add widgets.name',
          up: (db) => db.run('ALTER TABLE widgets ADD COLUMN name TEXT'),
        },
      ],
    });

    const store = makeStore();
    try {
      const result = runMigrations(store);
      expect(result.applied.map((a) => `${a.domain}:${a.version}`)).toEqual([
        'widgets:1',
        'widgets:2',
      ]);
      expect(result.alreadyUpToDate).toEqual([]);

      const log = store.all<{ domain: string; version: number }>(
        'SELECT domain, version FROM _migrations_log ORDER BY version',
      );
      expect(log).toEqual([
        { domain: 'widgets', version: 1 },
        { domain: 'widgets', version: 2 },
      ]);
    } finally {
      store.close();
    }
  });

  test('is idempotent across reruns', () => {
    registerSchema({
      domain: 'gadgets',
      migrations: [
        {
          version: 1,
          description: 'create gadgets',
          up: (db) => db.run('CREATE TABLE gadgets (id INTEGER)'),
        },
      ],
    });

    const store = makeStore();
    try {
      runMigrations(store);
      const second = runMigrations(store);
      expect(second.applied).toEqual([]);
      expect(second.alreadyUpToDate).toEqual([{ domain: 'gadgets', version: 1 }]);
    } finally {
      store.close();
    }
  });

  test('applies only new migrations when a version lands after an initial run', () => {
    registerSchema({
      domain: 'incremental',
      migrations: [
        {
          version: 1,
          description: 'init',
          up: (db) => db.run('CREATE TABLE incremental (id INTEGER)'),
        },
      ],
    });

    const store = makeStore();
    try {
      runMigrations(store);
      // Simulate a later release that adds a new migration.
      clearRegistry();
      registerSchema({
        domain: 'incremental',
        migrations: [
          {
            version: 1,
            description: 'init',
            up: (db) => db.run('CREATE TABLE incremental (id INTEGER)'),
          },
          {
            version: 2,
            description: 'add label',
            up: (db) => db.run('ALTER TABLE incremental ADD COLUMN label TEXT'),
          },
        ],
      });

      const result = runMigrations(store);
      expect(result.applied).toEqual([
        { domain: 'incremental', version: 2, description: 'add label' },
      ]);
    } finally {
      store.close();
    }
  });

  test('rolls back the current batch when a migration throws', () => {
    registerSchema({
      domain: 'bad',
      migrations: [
        {
          version: 1,
          description: 'first',
          up: (db) => db.run('CREATE TABLE bad_a (id INTEGER)'),
        },
        {
          version: 2,
          description: 'boom',
          up: () => {
            throw new Error('synthetic failure');
          },
        },
      ],
    });

    const store = makeStore();
    try {
      expect(() => runMigrations(store)).toThrow('synthetic failure');
      const tables = store.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'bad_a'",
      );
      expect(tables).toEqual([]);
      const log = store.all<{ version: number }>('SELECT version FROM _migrations_log');
      expect(log).toEqual([]);
    } finally {
      store.close();
    }
  });

  test('reports already-committed domains on a later domain failure', () => {
    // Domains migrate in alphabetical order (listDomains sorts), so 'a-good'
    // commits before 'z-bad' throws. Cross-domain commits are NOT rolled back,
    // so the throw must surface what 'a-good' durably applied.
    registerSchema({
      domain: 'a-good',
      migrations: [
        {
          version: 1,
          description: 'good init',
          up: (db) => db.run('CREATE TABLE a_good (id INTEGER)'),
        },
      ],
    });
    registerSchema({
      domain: 'z-bad',
      migrations: [
        {
          version: 1,
          description: 'boom',
          up: () => {
            throw new Error('synthetic failure');
          },
        },
      ],
    });

    const store = makeStore();
    try {
      let caught: unknown;
      try {
        runMigrations(store);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(MigrationError);
      const partial = (caught as MigrationError).partial;
      // 'a-good' committed; 'z-bad' rolled back and contributes nothing.
      expect(partial.applied.map((a) => `${a.domain}:${a.version}`)).toEqual(['a-good:1']);

      // The committed domain is durably present in the DB despite the throw.
      const log = store.all<{ domain: string }>('SELECT domain FROM _migrations_log');
      expect(log).toEqual([{ domain: 'a-good' }]);
    } finally {
      store.close();
    }
  });

  test('runs migrations per-domain independently', () => {
    registerSchema({
      domain: 'dom-a',
      migrations: [
        {
          version: 1,
          description: 'a init',
          up: (db) => db.run('CREATE TABLE dom_a (id INTEGER)'),
        },
      ],
    });
    registerSchema({
      domain: 'dom-b',
      migrations: [
        {
          version: 1,
          description: 'b init',
          up: (db) => db.run('CREATE TABLE dom_b (id INTEGER)'),
        },
        {
          version: 2,
          description: 'b extend',
          up: (db) => db.run('ALTER TABLE dom_b ADD COLUMN extra TEXT'),
        },
      ],
    });

    const store = makeStore();
    try {
      const result = runMigrations(store);
      expect(result.applied.map((a) => `${a.domain}:${a.version}`)).toEqual([
        'dom-a:1',
        'dom-b:1',
        'dom-b:2',
      ]);
    } finally {
      store.close();
    }
  });
});

describe('dropAllDomainTables', () => {
  afterEach(() => {
    clearRegistry();
  });

  test('wipes domain tables and _migrations_log', () => {
    registerSchema({
      domain: 'cleanup',
      migrations: [
        {
          version: 1,
          description: 'create cleanup',
          up: (db) => db.run('CREATE TABLE cleanup_rows (id INTEGER)'),
        },
      ],
    });

    const store = makeStore();
    try {
      runMigrations(store);
      dropAllDomainTables(store);
      const remaining = store.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      );
      expect(remaining).toEqual([]);
    } finally {
      store.close();
    }
  });
});
