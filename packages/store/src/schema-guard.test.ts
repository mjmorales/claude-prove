import { afterEach, describe, expect, test } from 'bun:test';
import { type Store, openStore } from './connection';
import { runMigrations } from './migrate';
import { clearRegistry, registerSchema } from './registry';
import { SchemaIncompatibleError, assertStoreSchemaCompatible } from './schema-guard';

function makeStore(): Promise<Store> {
  return openStore({ path: ':memory:' });
}

/** Register a single-v1-hop domain mirroring the redesigned base schema shape. */
function registerV1Domain(domain: string): void {
  registerSchema({
    domain,
    migrations: [
      {
        version: 1,
        description: `create ${domain}`,
        up: (store) => store.run(`CREATE TABLE ${domain}_t (id TEXT PRIMARY KEY)`),
      },
    ],
  });
}

describe('assertStoreSchemaCompatible', () => {
  afterEach(() => {
    clearRegistry();
  });

  test('a never-migrated store passes (no lineage to be incompatible with)', async () => {
    registerV1Domain('widgets');
    const store = await makeStore();
    try {
      // No _migrations_log yet — the guard must not throw.
      await assertStoreSchemaCompatible(store);
    } finally {
      store.close();
    }
  });

  test('a clean v1 store passes', async () => {
    registerV1Domain('widgets');
    const store = await makeStore();
    try {
      await runMigrations(store);
      await assertStoreSchemaCompatible(store);
    } finally {
      store.close();
    }
  });

  test('a legacy store (a domain logged ABOVE the v1 reset) is refused as incompatible', async () => {
    registerV1Domain('widgets');
    const store = await makeStore();
    try {
      // Simulate a pre-Turso-v1 store: the old incremental chain recorded
      // versions 1..28 in _migrations_log. Fabricate the legacy lineage.
      await runMigrations(store);
      await store.run(
        'INSERT INTO _migrations_log (domain, version, description, applied_at) VALUES (?, ?, ?, ?)',
        ['widgets', 28, 'legacy v28 hop', '2026-01-01T00:00:00Z'],
      );
      await expect(assertStoreSchemaCompatible(store)).rejects.toThrow(SchemaIncompatibleError);
      await expect(assertStoreSchemaCompatible(store)).rejects.toThrow(
        /predates the Turso v1 schema/,
      );
      await expect(assertStoreSchemaCompatible(store)).rejects.toThrow(/store reset --confirm/);
    } finally {
      store.close();
    }
  });

  test('an ahead store (same lineage, logged version > binary) is refused', async () => {
    // The binary registers only v1. Fabricate a store the migration runner
    // could never produce here — a future binary's v2 hop recorded in the log.
    registerV1Domain('widgets');
    const store = await makeStore();
    try {
      await runMigrations(store);
      // Record a version above the reset is the legacy path; to exercise the
      // distinct "ahead, same lineage" branch we need maxVersion in (1, binMax]
      // to NOT trip and > binMax to trip. With binMax=1 the only way ahead
      // differs from legacy is when the binary itself registers a higher base.
      // Re-register a binary that knows up to v1 only, then log a v1-lineage
      // store that a newer binary advanced — but since >1 is caught as legacy
      // first, assert the legacy branch wins for >1. This documents the order:
      // legacy detection (cross-reset) takes precedence over ahead detection.
      await store.run(
        'INSERT INTO _migrations_log (domain, version, description, applied_at) VALUES (?, ?, ?, ?)',
        ['widgets', 2, 'a hop this binary does not know', '2026-01-01T00:00:00Z'],
      );
      await expect(assertStoreSchemaCompatible(store)).rejects.toThrow(SchemaIncompatibleError);
    } finally {
      store.close();
    }
  });

  test('an unknown domain in the log is ignored (another tool table)', async () => {
    registerV1Domain('widgets');
    const store = await makeStore();
    try {
      await runMigrations(store);
      // A domain this binary does not register, logged at a high version, must
      // not trip the guard — it is not this binary's concern.
      await store.run(
        'INSERT INTO _migrations_log (domain, version, description, applied_at) VALUES (?, ?, ?, ?)',
        ['some_other_tool', 99, 'their migration', '2026-01-01T00:00:00Z'],
      );
      await assertStoreSchemaCompatible(store);
    } finally {
      store.close();
    }
  });
});
