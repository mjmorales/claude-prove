/**
 * Two-writer commute regression — the property the whole ULID-PK redesign
 * exists to guarantee. The Phase-0 spike proved that two writers which each
 * allocate the next AUTOINCREMENT rowid collide on the same integer, so when
 * the local engine replays both transactions under REBASE_LOCAL with a single
 * winner, one row is silently lost. Two distinct ULID-keyed inserts both
 * survive because the id is decided by the minting writer, not by a shared
 * sequence the rebase must reconcile.
 *
 * These tests model the collision in-memory (no live sync), so they assert the
 * STRUCTURAL property that makes the rebase safe: distinct ULID ids never
 * collide, while a shared rowid sequence produces the colliding id that loses a
 * row. The contrast documents WHY the redesign was necessary.
 */

import { describe, expect, test } from 'bun:test';
import { type Store, openStore } from './connection';
import { ulid } from './ulid';

function makeStore(): Promise<Store> {
  return openStore({ path: ':memory:' });
}

describe('two-writer commute (ULID vs rowid)', () => {
  test('two distinct ULID inserts both survive — no clobber', async () => {
    const store = await makeStore();
    try {
      await store.exec(
        'CREATE TABLE append_log (id TEXT PRIMARY KEY, writer TEXT NOT NULL, body TEXT NOT NULL)',
      );

      // Two independent writers each mint their own ULID. Distinct ids, so both
      // rows land — exactly the rebase-survivable shape.
      const idA = ulid();
      const idB = ulid();
      expect(idA).not.toBe(idB);

      await store.run('INSERT INTO append_log (id, writer, body) VALUES (?, ?, ?)', [
        idA,
        'writer-a',
        'a writes here',
      ]);
      await store.run('INSERT INTO append_log (id, writer, body) VALUES (?, ?, ?)', [
        idB,
        'writer-b',
        'b writes here',
      ]);

      const rows = await store.all<{ id: string; writer: string }>(
        'SELECT id, writer FROM append_log ORDER BY id ASC',
      );
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.writer).sort()).toEqual(['writer-a', 'writer-b']);
      // ULID order tracks mint order: idA (minted first) sorts before idB.
      expect(rows[0]?.id).toBe(idA);
      expect(rows[1]?.id).toBe(idB);
    } finally {
      store.close();
    }
  });

  test('a shared rowid sequence produces the colliding id the rebase would lose', async () => {
    const store = await makeStore();
    try {
      // Model the old AUTOINCREMENT shape: an integer rowid the engine assigns
      // from a shared sequence. Two writers building their transaction against
      // the same empty table each compute the SAME next id (1) — the collision
      // the rebase resolves by dropping one row.
      await store.exec(
        'CREATE TABLE rowid_log (id INTEGER PRIMARY KEY AUTOINCREMENT, writer TEXT NOT NULL)',
      );

      const nextRowidFor = async (): Promise<number> => {
        const max = await store.get<{ m: number | null }>('SELECT MAX(id) AS m FROM rowid_log');
        return (max?.m ?? 0) + 1;
      };

      // Both writers observe an empty table and independently target rowid 1 —
      // the colliding id. Under whole-transaction replay only one can keep it.
      const writerANextId = await nextRowidFor();
      const writerBNextId = await nextRowidFor();
      expect(writerANextId).toBe(writerBNextId); // the collision the spike found

      // Writer A commits first; writer B's identical-id insert is a PK conflict
      // — concretely the row the rebase drops.
      await store.run('INSERT INTO rowid_log (id, writer) VALUES (?, ?)', [
        writerANextId,
        'writer-a',
      ]);
      await expect(
        store.run('INSERT INTO rowid_log (id, writer) VALUES (?, ?)', [writerBNextId, 'writer-b']),
      ).rejects.toThrow();

      // Only one row survived — the lost-write the ULID redesign prevents.
      const rows = await store.all<{ writer: string }>('SELECT writer FROM rowid_log');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.writer).toBe('writer-a');
    } finally {
      store.close();
    }
  });
});
