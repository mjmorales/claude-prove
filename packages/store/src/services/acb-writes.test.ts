import { describe, expect, test } from 'bun:test';
import { type Store, openStore } from '../connection';
import { type GroupVerdictRecord, appendGroupVerdict } from './acb-writes';

/** Read array element `i`, asserting it exists (noUncheckedIndexedAccess). */
function at<T>(arr: T[], i: number): T {
  const value = arr[i];
  if (value === undefined) throw new Error(`at: no element at index ${i}`);
  return value;
}

/**
 * `acb_group_verdicts` (and its head view) is registered by the CLI-side acb
 * domain schema, not by `@claude-prove/store`'s own migration registry — so
 * `openStore` on a tmp path does not auto-create it. The DDL below is copied
 * verbatim from the CLI's acb v1 migration (`packages/cli/src/topics/acb/store.ts`)
 * so the service exercises the exact append-only revision shape + head view it
 * targets in production.
 */
const ACB_GROUP_VERDICTS_DDL = `
CREATE TABLE IF NOT EXISTS acb_group_verdicts (
    id          TEXT PRIMARY KEY,
    slug        TEXT NOT NULL,
    group_id    TEXT NOT NULL,
    verdict     TEXT NOT NULL,
    note        TEXT,
    fix_prompt  TEXT,
    created_at  TEXT NOT NULL
);
CREATE VIEW IF NOT EXISTS acb_group_verdicts_head AS
SELECT
    h.slug,
    h.group_id,
    h.verdict,
    h.note,
    h.fix_prompt,
    h.created_at AS updated_at
FROM acb_group_verdicts h
WHERE h.id = (
    SELECT MAX(v2.id) FROM acb_group_verdicts v2
    WHERE v2.slug = h.slug AND v2.group_id = h.group_id
);
CREATE INDEX IF NOT EXISTS idx_acb_group_verdicts_slug ON acb_group_verdicts(slug);
`;

async function makeStore(): Promise<Store> {
  const store = await openStore({ path: ':memory:' });
  await store.exec(ACB_GROUP_VERDICTS_DDL);
  return store;
}

/** Latest verdict per (slug, group_id) for a slug, read through the head view. */
async function headRowsFor(store: Store, slug: string): Promise<GroupVerdictRecord[]> {
  const rows = await store.all<{
    slug: string;
    group_id: string;
    verdict: string;
    note: string | null;
    fix_prompt: string | null;
    updated_at: string;
  }>(
    'SELECT slug, group_id, verdict, note, fix_prompt, updated_at FROM acb_group_verdicts_head WHERE slug = ?',
    [slug],
  );
  return rows.map((r) => ({
    slug: r.slug,
    groupId: r.group_id,
    verdict: r.verdict as GroupVerdictRecord['verdict'],
    note: r.note,
    fixPrompt: r.fix_prompt,
    updatedAt: r.updated_at,
  }));
}

/** Count every base-table revision row for a (slug, group_id) key. */
async function revisionCount(store: Store, slug: string, groupId: string): Promise<number> {
  const rows = await store.all<{ n: number }>(
    'SELECT COUNT(*) AS n FROM acb_group_verdicts WHERE slug = ? AND group_id = ?',
    [slug, groupId],
  );
  return rows[0]?.n ?? 0;
}

describe('appendGroupVerdict', () => {
  test('a single append lands exactly one revision; the head returns the written shape', async () => {
    const store = await makeStore();
    try {
      const record = await appendGroupVerdict(
        store,
        'add-login',
        'g1',
        'accepted',
        'looks good',
        null,
      );

      expect(record.slug).toBe('add-login');
      expect(record.groupId).toBe('g1');
      expect(record.verdict).toBe('accepted');
      expect(record.note).toBe('looks good');
      expect(record.fixPrompt).toBeNull();
      expect(typeof record.updatedAt).toBe('string');

      const rows = await headRowsFor(store, 'add-login');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(record);
    } finally {
      store.close();
    }
  });

  test('a second append on the same (slug, groupId) retains both rows; the head returns the latest', async () => {
    const store = await makeStore();
    try {
      const first = await appendGroupVerdict(store, 'add-login', 'g1', 'pending', null, null);

      // Force a distinct ISO timestamp so the new revision's stamp is observable;
      // the stamp is millisecond-resolution and a back-to-back append can collide.
      const original = Date.prototype.toISOString;
      const bumped = new Date(Date.parse(first.updatedAt) + 1000).toISOString();
      Date.prototype.toISOString = () => bumped;
      let second: GroupVerdictRecord;
      try {
        second = await appendGroupVerdict(
          store,
          'add-login',
          'g1',
          'rework',
          'fix the thing',
          'apply this patch',
        );
      } finally {
        Date.prototype.toISOString = original;
      }

      // Append-only: both ULID-keyed revisions survive in the base table.
      expect(await revisionCount(store, 'add-login', 'g1')).toBe(2);

      // The head view collapses them to the latest revision.
      const rows = await headRowsFor(store, 'add-login');
      expect(rows).toHaveLength(1);
      const head = at(rows, 0);
      expect(head.verdict).toBe('rework');
      expect(head.note).toBe('fix the thing');
      expect(head.fixPrompt).toBe('apply this patch');
      expect(head.updatedAt).toBe(bumped);
      expect(second.updatedAt).not.toBe(first.updatedAt);
    } finally {
      store.close();
    }
  });
});
