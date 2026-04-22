import { describe, expect, test } from 'bun:test';
import { openStore } from './connection';

describe('openStore', () => {
  test('opens an in-memory database with :memory: path', () => {
    const store = openStore({ path: ':memory:' });
    try {
      expect(store.path).toBe(':memory:');
      expect(store.getDb()).toBeDefined();
    } finally {
      store.close();
    }
  });

  test('run + all round-trip a simple schema', () => {
    const store = openStore({ path: ':memory:' });
    try {
      store.run('CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT)');
      store.run('INSERT INTO widgets (id, name) VALUES (?, ?)', [1, 'alpha']);
      store.run('INSERT INTO widgets (id, name) VALUES (?, ?)', [2, 'beta']);
      const rows = store.all<{ id: number; name: string }>(
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

  test('getDb throws after close', () => {
    const store = openStore({ path: ':memory:' });
    store.close();
    expect(() => store.getDb()).toThrow('Store is closed');
  });

  test('close is idempotent', () => {
    const store = openStore({ path: ':memory:' });
    store.close();
    expect(() => store.close()).not.toThrow();
  });
});
