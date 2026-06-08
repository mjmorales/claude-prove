/**
 * DDL byte-equality conformance gate for the sync-safe v1 store schema.
 *
 * The golden (`__fixtures__/store-schema.golden.txt`) pins the exact DDL the
 * redesigned v1 schema emits, so any future drift — a column, table, index, or
 * constraint change — surfaces as a failing golden diff rather than passing
 * silently. The snapshot encodes the redesign's invariants: every primary key
 * is a TEXT (ULID) id, a natural slug, or a composite key, and NO table uses
 * AUTOINCREMENT or an INTEGER rowid alias (the shape whole-transaction sync
 * replay would lose a row on).
 *
 * Scope note: the migration registry is process-global and `runMigrations` runs
 * every registered domain on store-open. Importing both the scrum and acb store
 * modules registers both domains, so opening either store emits the full union
 * (scrum + acb) schema. The test imports both and asserts against the union, so
 * the snapshot is deterministic regardless of which store is opened.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openAcbStore } from './acb/store';
import { openScrumStore } from './scrum/store';

const GOLDEN = join(import.meta.dir, '__fixtures__', 'store-schema.golden.txt');

const DUMP_SQL =
  "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type, name";

/** One schema object per line as `type\tname\tnormalized-sql`. */
function snapshot(rows: Array<{ type: string; name: string; sql: string }>): string {
  return `${rows.map((r) => `${r.type}\t${r.name}\t${r.sql.replace(/\s+/g, ' ').trim()}`).join('\n')}\n`;
}

describe('store schema — DDL byte-equality conformance', () => {
  test('the emitted DDL matches the committed golden (no schema drift from the async port)', async () => {
    // Importing openAcbStore registers the acb domain; openScrumStore then runs
    // all registered domains, emitting the full union schema.
    const store = await openScrumStore({ path: ':memory:' });
    try {
      const rows = (await store.getStore().all(DUMP_SQL)) as Array<{
        type: string;
        name: string;
        sql: string;
      }>;
      const actual = snapshot(rows);
      const golden = readFileSync(GOLDEN, 'utf8');
      expect(actual).toBe(golden);
    } finally {
      store.close();
    }
  });

  test('the emitted DDL carries zero AUTOINCREMENT — no rowid alias survives sync replay', async () => {
    const store = await openScrumStore({ path: ':memory:' });
    try {
      const rows = (await store.getStore().all(DUMP_SQL)) as Array<{ sql: string }>;
      for (const r of rows) {
        expect(r.sql).not.toContain('AUTOINCREMENT');
      }
    } finally {
      store.close();
    }
  });

  test('the emitted DDL carries the nullable F32_BLOB(32) embedding columns on decisions + lores', async () => {
    // vector32-present conformance: the Codex-record tables ship the embedding
    // column a later semantic-search phase populates with vector32(...) and
    // queries with vector_distance_cos(...). The column is present here, NULL on
    // every row (no population at this layer).
    const store = await openScrumStore({ path: ':memory:' });
    try {
      const rows = (await store.getStore().all(DUMP_SQL)) as Array<{ name: string; sql: string }>;
      const byName = new Map(rows.map((r) => [r.name, r.sql.replace(/\s+/g, ' ').trim()]));
      expect(byName.get('scrum_decisions')).toContain('embedding F32_BLOB (32)');
      expect(byName.get('scrum_lores')).toContain('embedding F32_BLOB (32)');
    } finally {
      store.close();
    }
  });

  test('opening the acb store emits the same union schema (domain-registration is global)', async () => {
    const store = await openAcbStore({ path: ':memory:' });
    try {
      const inner = store.getStore();
      const rows = (await inner.all(DUMP_SQL)) as Array<{
        type: string;
        name: string;
        sql: string;
      }>;
      expect(snapshot(rows)).toBe(readFileSync(GOLDEN, 'utf8'));
    } finally {
      store.close();
    }
  });
});
