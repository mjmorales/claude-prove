import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearRegistry, openStore, registerSchema, resolveDbPath, runMigrations } from '../src';

function makeTmpGitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'store-integration-'));
  mkdirSync(join(root, '.git'), { recursive: true });
  return root;
}

describe('packages/store end-to-end', () => {
  afterEach(() => {
    clearRegistry();
  });

  test('registers a synthetic domain, migrates, and lands a file-backed prove.db', () => {
    const repo = makeTmpGitRepo();
    try {
      registerSchema({
        domain: 'orders',
        migrations: [
          {
            version: 1,
            description: 'create orders table',
            up: (db) => {
              db.run('CREATE TABLE orders (id INTEGER PRIMARY KEY, total INTEGER)');
            },
          },
          {
            version: 2,
            description: 'add customer column',
            up: (db) => db.run('ALTER TABLE orders ADD COLUMN customer TEXT'),
          },
        ],
      });

      const expectedPath = resolveDbPath({ cwd: repo });
      expect(expectedPath).toBe(join(repo, '.prove', 'prove.db'));

      const store = openStore({ cwd: repo });
      try {
        expect(store.path).toBe(expectedPath);
        expect(existsSync(expectedPath)).toBe(true);

        const result = runMigrations(store);
        expect(result.applied.map((a) => `${a.domain}:${a.version}`)).toEqual([
          'orders:1',
          'orders:2',
        ]);

        // Verify the schema landed and rows round-trip through the Store API.
        store.run('INSERT INTO orders (id, total, customer) VALUES (?, ?, ?)', [42, 9900, 'alice']);
        const rows = store.all<{ id: number; total: number; customer: string }>(
          'SELECT id, total, customer FROM orders',
        );
        expect(rows).toEqual([{ id: 42, total: 9900, customer: 'alice' }]);

        // Migrations log reflects both applied versions.
        const log = store.all<{ domain: string; version: number; description: string }>(
          'SELECT domain, version, description FROM _migrations_log ORDER BY version',
        );
        expect(log).toEqual([
          { domain: 'orders', version: 1, description: 'create orders table' },
          { domain: 'orders', version: 2, description: 'add customer column' },
        ]);
      } finally {
        store.close();
      }

      // Rerun on a fresh connection: no additional migrations, same state.
      const store2 = openStore({ cwd: repo });
      try {
        const result = runMigrations(store2);
        expect(result.applied).toEqual([]);
        expect(result.alreadyUpToDate).toEqual([{ domain: 'orders', version: 2 }]);
      } finally {
        store2.close();
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
