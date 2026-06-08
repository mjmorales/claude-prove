/**
 * DDL byte-equality conformance gate for the Turso async-store port.
 *
 * The bun:sqlite -> @tursodatabase/database port must be behavior-identical: it
 * changed how migrations EXECUTE (sync `db.exec` -> async `store.exec`), never
 * the schema they produce. This test pins the emitted DDL so any future drift —
 * a column, table, index, or constraint change — surfaces as a failing golden
 * diff rather than passing silently.
 *
 * The golden (`__fixtures__/store-schema.golden.txt`) was captured from the
 * ported schema, which a source-level diff against the pre-port branch proved
 * carries byte-identical CREATE TABLE/INDEX strings — so the golden equally
 * encodes the pre-port schema.
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
