import { afterEach, describe, expect, test } from 'bun:test';
import { type Store, openStore } from './connection';
import { MigrationError, dropAllDomainTables, runMigrations } from './migrate';
import { clearRegistry, registerSchema } from './registry';

function makeStore(): Promise<Store> {
  return openStore({ path: ':memory:' });
}

describe('runMigrations', () => {
  afterEach(() => {
    clearRegistry();
  });

  test('applies all pending migrations on a fresh store', async () => {
    registerSchema({
      domain: 'widgets',
      migrations: [
        {
          version: 1,
          description: 'create widgets table',
          up: (store) => store.run('CREATE TABLE widgets (id INTEGER PRIMARY KEY)'),
        },
        {
          version: 2,
          description: 'add widgets.name',
          up: (store) => store.run('ALTER TABLE widgets ADD COLUMN name TEXT'),
        },
      ],
    });

    const store = await makeStore();
    try {
      const result = await runMigrations(store);
      expect(result.applied.map((a) => `${a.domain}:${a.version}`)).toEqual([
        'widgets:1',
        'widgets:2',
      ]);
      expect(result.alreadyUpToDate).toEqual([]);

      const log = await store.all<{ domain: string; version: number }>(
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

  test('is idempotent across reruns', async () => {
    registerSchema({
      domain: 'gadgets',
      migrations: [
        {
          version: 1,
          description: 'create gadgets',
          up: (store) => store.run('CREATE TABLE gadgets (id INTEGER)'),
        },
      ],
    });

    const store = await makeStore();
    try {
      await runMigrations(store);
      const second = await runMigrations(store);
      expect(second.applied).toEqual([]);
      expect(second.alreadyUpToDate).toEqual([{ domain: 'gadgets', version: 1 }]);
    } finally {
      store.close();
    }
  });

  test('applies only new migrations when a version lands after an initial run', async () => {
    registerSchema({
      domain: 'incremental',
      migrations: [
        {
          version: 1,
          description: 'init',
          up: (store) => store.run('CREATE TABLE incremental (id INTEGER)'),
        },
      ],
    });

    const store = await makeStore();
    try {
      await runMigrations(store);
      // Simulate a later release that adds a new migration.
      clearRegistry();
      registerSchema({
        domain: 'incremental',
        migrations: [
          {
            version: 1,
            description: 'init',
            up: (store) => store.run('CREATE TABLE incremental (id INTEGER)'),
          },
          {
            version: 2,
            description: 'add label',
            up: (store) => store.run('ALTER TABLE incremental ADD COLUMN label TEXT'),
          },
        ],
      });

      const result = await runMigrations(store);
      expect(result.applied).toEqual([
        { domain: 'incremental', version: 2, description: 'add label' },
      ]);
    } finally {
      store.close();
    }
  });

  test('rolls back the current batch when a migration throws', async () => {
    registerSchema({
      domain: 'bad',
      migrations: [
        {
          version: 1,
          description: 'first',
          up: (store) => store.run('CREATE TABLE bad_a (id INTEGER)'),
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

    const store = await makeStore();
    try {
      await expect(runMigrations(store)).rejects.toThrow('synthetic failure');
      const tables = await store.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'bad_a'",
      );
      expect(tables).toEqual([]);
      const log = await store.all<{ version: number }>('SELECT version FROM _migrations_log');
      expect(log).toEqual([]);
    } finally {
      store.close();
    }
  });

  test('reports already-committed domains on a later domain failure', async () => {
    // Domains migrate in alphabetical order (listDomains sorts), so 'a-good'
    // commits before 'z-bad' throws. Cross-domain commits are NOT rolled back,
    // so the throw must surface what 'a-good' durably applied.
    registerSchema({
      domain: 'a-good',
      migrations: [
        {
          version: 1,
          description: 'good init',
          up: (store) => store.run('CREATE TABLE a_good (id INTEGER)'),
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

    const store = await makeStore();
    try {
      let caught: unknown;
      try {
        await runMigrations(store);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(MigrationError);
      const partial = (caught as MigrationError).partial;
      // 'a-good' committed; 'z-bad' rolled back and contributes nothing.
      expect(partial.applied.map((a) => `${a.domain}:${a.version}`)).toEqual(['a-good:1']);

      // The committed domain is durably present in the DB despite the throw.
      const log = await store.all<{ domain: string }>('SELECT domain FROM _migrations_log');
      expect(log).toEqual([{ domain: 'a-good' }]);
    } finally {
      store.close();
    }
  });

  test('runs migrations per-domain independently', async () => {
    registerSchema({
      domain: 'dom-a',
      migrations: [
        {
          version: 1,
          description: 'a init',
          up: (store) => store.run('CREATE TABLE dom_a (id INTEGER)'),
        },
      ],
    });
    registerSchema({
      domain: 'dom-b',
      migrations: [
        {
          version: 1,
          description: 'b init',
          up: (store) => store.run('CREATE TABLE dom_b (id INTEGER)'),
        },
        {
          version: 2,
          description: 'b extend',
          up: (store) => store.run('ALTER TABLE dom_b ADD COLUMN extra TEXT'),
        },
      ],
    });

    const store = await makeStore();
    try {
      const result = await runMigrations(store);
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

  test('wipes domain tables and _migrations_log', async () => {
    registerSchema({
      domain: 'cleanup',
      migrations: [
        {
          version: 1,
          description: 'create cleanup',
          up: (store) => store.run('CREATE TABLE cleanup_rows (id INTEGER)'),
        },
      ],
    });

    const store = await makeStore();
    try {
      await runMigrations(store);
      await dropAllDomainTables(store);
      const remaining = await store.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      );
      expect(remaining).toEqual([]);
    } finally {
      store.close();
    }
  });
});
