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

  test('registers a synthetic domain, migrates, and lands a file-backed prove.db', async () => {
    const repo = makeTmpGitRepo();
    try {
      registerSchema({
        domain: 'orders',
        migrations: [
          {
            version: 1,
            description: 'create orders table',
            up: (store) => store.run('CREATE TABLE orders (id INTEGER PRIMARY KEY, total INTEGER)'),
          },
          {
            version: 2,
            description: 'add customer column',
            up: (store) => store.run('ALTER TABLE orders ADD COLUMN customer TEXT'),
          },
        ],
      });

      const expectedPath = resolveDbPath({ cwd: repo });
      expect(expectedPath).toBe(join(repo, '.prove', 'prove.db'));

      const store = await openStore({ cwd: repo });
      try {
        expect(store.path).toBe(expectedPath);
        expect(existsSync(expectedPath)).toBe(true);

        const result = await runMigrations(store);
        expect(result.applied.map((a) => `${a.domain}:${a.version}`)).toEqual([
          'orders:1',
          'orders:2',
        ]);

        // Verify the schema landed and rows round-trip through the Store API.
        await store.run('INSERT INTO orders (id, total, customer) VALUES (?, ?, ?)', [
          42,
          9900,
          'alice',
        ]);
        const rows = await store.all<{ id: number; total: number; customer: string }>(
          'SELECT id, total, customer FROM orders',
        );
        expect(rows).toEqual([{ id: 42, total: 9900, customer: 'alice' }]);

        // Migrations log reflects both applied versions.
        const log = await store.all<{ domain: string; version: number; description: string }>(
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
      const store2 = await openStore({ cwd: repo });
      try {
        const result = await runMigrations(store2);
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
