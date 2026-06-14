import { afterEach, describe, expect, test } from 'bun:test';
import { type Store, openStore } from './connection';
import { runMigrations } from './migrate';
import { type Migration, clearRegistry, registerSchema } from './registry';
import { SchemaIncompatibleError, assertStoreSchemaCompatible } from './schema-guard';

function makeStore(): Promise<Store> {
  return openStore({ path: ':memory:' });
}

/**
 * Register a domain whose migration chain runs v1..maxVersion, each hop creating
 * one tiny table. `scrum` and `acb` carry a legacy floor in the guard; an
 * arbitrary name (e.g. `widgets`) has no floor and exercises the no-floor path.
 */
function registerDomain(domain: string, maxVersion = 1): void {
  const migrations: Migration[] = [];
  for (let v = 1; v <= maxVersion; v++) {
    migrations.push({
      version: v,
      description: `create ${domain} v${v}`,
      up: (store) => store.run(`CREATE TABLE IF NOT EXISTS ${domain}_t${v} (id TEXT PRIMARY KEY)`),
    });
  }
  registerSchema({ domain, migrations });
}

/** Stamp a logged max version for a domain directly into `_migrations_log`. */
async function logVersion(store: Store, domain: string, version: number): Promise<void> {
  await store.run(
    'INSERT INTO _migrations_log (domain, version, description, applied_at) VALUES (?, ?, ?, ?)',
    [domain, version, `forced v${version}`, '2026-01-01T00:00:00Z'],
  );
}

describe('assertStoreSchemaCompatible', () => {
  afterEach(() => {
    clearRegistry();
  });

  test('a never-migrated store passes (no lineage to be incompatible with)', async () => {
    registerDomain('scrum');
    const store = await makeStore();
    try {
      // No _migrations_log yet — the guard must not throw.
      await assertStoreSchemaCompatible(store);
    } finally {
      store.close();
    }
  });

  test('a clean v1 store passes', async () => {
    registerDomain('scrum');
    const store = await makeStore();
    try {
      await runMigrations(store);
      await assertStoreSchemaCompatible(store);
    } finally {
      store.close();
    }
  });

  test('a clean scrum-v2 store opens (the registered chain advanced past v1)', async () => {
    // The binary now registers scrum up to v2 — the first real v1→v2 hop. A store
    // migrated to that registered max must open cleanly, not be refused as ahead.
    registerDomain('scrum', 2);
    const store = await makeStore();
    try {
      await runMigrations(store);
      await assertStoreSchemaCompatible(store);
      const max = await store.get<{ v: number }>(
        "SELECT MAX(version) v FROM _migrations_log WHERE domain = 'scrum'",
      );
      expect(max?.v).toBe(2);
    } finally {
      store.close();
    }
  });

  test('a legacy scrum store (logged v28) is refused with the migrate-to-turso remedy', async () => {
    // Pre-Turso lineage: the old incremental chain climbed to v28. The binary
    // registers only the small Turso chain, so v28 sits at-or-above the scrum
    // legacy floor and reads as legacy, not ahead.
    registerDomain('scrum', 2);
    const store = await makeStore();
    try {
      await runMigrations(store);
      await logVersion(store, 'scrum', 28);
      await expect(assertStoreSchemaCompatible(store)).rejects.toThrow(SchemaIncompatibleError);
      await expect(assertStoreSchemaCompatible(store)).rejects.toThrow(
        /predates the Turso v1 schema/,
      );
      await expect(assertStoreSchemaCompatible(store)).rejects.toThrow(/migrate-to-turso/);
    } finally {
      store.close();
    }
  });

  test('a legacy acb store (logged v4) is refused with the migrate-to-turso remedy', async () => {
    // acb's pre-Turso chain reached v4; the floor is v4, so a logged v4 reads as
    // legacy. The binary registers only acb v1.
    registerDomain('acb', 1);
    const store = await makeStore();
    try {
      await runMigrations(store);
      await logVersion(store, 'acb', 4);
      await expect(assertStoreSchemaCompatible(store)).rejects.toThrow(SchemaIncompatibleError);
      await expect(assertStoreSchemaCompatible(store)).rejects.toThrow(/migrate-to-turso/);
    } finally {
      store.close();
    }
  });

  test('an ahead store (logged version above the registered max, below the legacy floor) is refused with the upgrade remedy', async () => {
    // The binary registers scrum up to v2. A future binary advanced the small
    // Turso chain to v3 and recorded it. v3 < the scrum legacy floor (10), so it
    // is AHEAD (a newer binary), not legacy — the distinct upgrade remedy fires.
    registerDomain('scrum', 2);
    const store = await makeStore();
    try {
      await runMigrations(store);
      await logVersion(store, 'scrum', 3);
      await expect(assertStoreSchemaCompatible(store)).rejects.toThrow(SchemaIncompatibleError);
      await expect(assertStoreSchemaCompatible(store)).rejects.toThrow(/ahead of this binary/);
      await expect(assertStoreSchemaCompatible(store)).rejects.toThrow(/Upgrade the binary/);
    } finally {
      store.close();
    }
  });

  test('an ahead store in a domain with no legacy floor is refused as ahead', async () => {
    // A domain with no recorded legacy lineage (no floor): any logged version
    // above the registered max is treated as ahead — the conservative reading,
    // since the safe failure for an unknown future version is "upgrade".
    registerDomain('widgets', 1);
    const store = await makeStore();
    try {
      await runMigrations(store);
      await logVersion(store, 'widgets', 99);
      await expect(assertStoreSchemaCompatible(store)).rejects.toThrow(SchemaIncompatibleError);
      await expect(assertStoreSchemaCompatible(store)).rejects.toThrow(/ahead of this binary/);
    } finally {
      store.close();
    }
  });

  test('an unknown domain in the log is ignored (another tool table)', async () => {
    registerDomain('scrum', 2);
    const store = await makeStore();
    try {
      await runMigrations(store);
      // A domain this binary does not register, logged at a high version, must
      // not trip the guard — it is not this binary's concern.
      await logVersion(store, 'some_other_tool', 99);
      await assertStoreSchemaCompatible(store);
    } finally {
      store.close();
    }
  });
});
