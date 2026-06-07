import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Store, openStore, withTx } from './connection';

describe('openStore', () => {
  test('opens an in-memory database with :memory: path', async () => {
    const store = await openStore({ path: ':memory:' });
    try {
      expect(store.path).toBe(':memory:');
      expect(store.getDb()).toBeDefined();
    } finally {
      store.close();
    }
  });

  test('run + all round-trip a simple schema', async () => {
    const store = await openStore({ path: ':memory:' });
    try {
      await store.run('CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT)');
      await store.run('INSERT INTO widgets (id, name) VALUES (?, ?)', [1, 'alpha']);
      await store.run('INSERT INTO widgets (id, name) VALUES (?, ?)', [2, 'beta']);
      const rows = await store.all<{ id: number; name: string }>(
        'SELECT id, name FROM widgets ORDER BY id',
      );
      expect(rows).toEqual([
        { id: 1, name: 'alpha' },
        { id: 2, name: 'beta' },
      ]);
    } finally {
      store.close();
    }
  });

  test('get returns the first row or undefined', async () => {
    const store = await openStore({ path: ':memory:' });
    try {
      await store.run('CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT)');
      await store.run('INSERT INTO widgets (id, name) VALUES (?, ?)', [1, 'alpha']);
      const hit = await store.get<{ id: number; name: string }>(
        'SELECT id, name FROM widgets WHERE id = ?',
        [1],
      );
      expect(hit).toEqual({ id: 1, name: 'alpha' });
      const miss = await store.get('SELECT id FROM widgets WHERE id = ?', [99]);
      expect(miss).toBeUndefined();
    } finally {
      store.close();
    }
  });

  test('getDb throws after close', async () => {
    const store = await openStore({ path: ':memory:' });
    store.close();
    expect(() => store.getDb()).toThrow('Store is closed');
  });

  test('close is idempotent', async () => {
    const store = await openStore({ path: ':memory:' });
    store.close();
    expect(() => store.close()).not.toThrow();
  });

  test('opening a file-backed store readonly skips the WAL journal-mode write', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'store-ro-'));
    const dbPath = join(dir, 'prove.db');
    try {
      // Create the file in write mode first (readonly cannot create).
      const writer = await openStore({ path: dbPath });
      await writer.run('CREATE TABLE widgets (id INTEGER PRIMARY KEY)');
      writer.close();

      // A readonly handle must not attempt `PRAGMA journal_mode = WAL`
      // (a write that errors on a readonly database).
      const reader = await openStore({ path: dbPath, readonly: true });
      const rows = await reader.all('SELECT id FROM widgets');
      expect(rows).toEqual([]);
      reader.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('withTx', () => {
  async function memStore(): Promise<Store> {
    const store = await openStore({ path: ':memory:' });
    await store.run('CREATE TABLE rows (id INTEGER PRIMARY KEY, label TEXT)');
    return store;
  }

  test('commits the work on success', async () => {
    const store = await memStore();
    try {
      const out = await withTx(store, async () => {
        await store.run('INSERT INTO rows (id, label) VALUES (?, ?)', [1, 'committed']);
        return 'done';
      });
      expect(out).toBe('done');
      expect(store.txDepth).toBe(0);
      const rows = await store.all<{ id: number }>('SELECT id FROM rows');
      expect(rows).toEqual([{ id: 1 }]);
    } finally {
      store.close();
    }
  });

  test('rolls back and re-raises the original error on throw', async () => {
    const store = await memStore();
    try {
      const boom = new Error('synthetic failure');
      let caught: unknown;
      try {
        await withTx(store, async () => {
          await store.run('INSERT INTO rows (id, label) VALUES (?, ?)', [1, 'doomed']);
          throw boom;
        });
      } catch (err) {
        caught = err;
      }
      // The exact error object is re-raised, not wrapped.
      expect(caught).toBe(boom);
      expect(store.txDepth).toBe(0);
      const rows = await store.all('SELECT id FROM rows');
      expect(rows).toEqual([]);
    } finally {
      store.close();
    }
  });

  test('nests via savepoints: inner rollback keeps the outer commit', async () => {
    const store = await memStore();
    try {
      await withTx(store, async () => {
        await store.run('INSERT INTO rows (id, label) VALUES (?, ?)', [1, 'outer']);
        expect(store.txDepth).toBe(1);

        // Inner transaction throws; its savepoint rolls back without
        // unwinding the outer BEGIN IMMEDIATE.
        await expect(
          withTx(store, async () => {
            await store.run('INSERT INTO rows (id, label) VALUES (?, ?)', [2, 'inner-doomed']);
            expect(store.txDepth).toBe(2);
            throw new Error('inner failure');
          }),
        ).rejects.toThrow('inner failure');

        // Depth restored to the outer frame after the inner unwinds.
        expect(store.txDepth).toBe(1);

        // A second inner transaction that succeeds releases its savepoint.
        await withTx(store, async () => {
          await store.run('INSERT INTO rows (id, label) VALUES (?, ?)', [3, 'inner-ok']);
        });
      });

      expect(store.txDepth).toBe(0);
      const rows = await store.all<{ id: number }>('SELECT id FROM rows ORDER BY id');
      // Outer (1) and the successful inner (3) survive; the doomed inner (2)
      // rolled back to its savepoint.
      expect(rows).toEqual([{ id: 1 }, { id: 3 }]);
    } finally {
      store.close();
    }
  });
});
