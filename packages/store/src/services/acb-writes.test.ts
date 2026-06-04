import { describe, expect, test } from 'bun:test';
import { type Store, openStore } from '../connection';
import { type GroupVerdictRecord, upsertGroupVerdict } from './acb-writes';

/**
 * `acb_group_verdicts` is registered by the CLI-side acb domain schema, not
 * by `@claude-prove/store`'s own migration registry — so `openStore` on a
 * tmp path does not auto-create it. The DDL below is copied verbatim from the
 * CLI's `ACB_MIGRATION_V2_SQL` (`packages/cli/src/topics/acb/store.ts`) so the
 * service exercises the exact table shape it targets in production.
 */
const ACB_GROUP_VERDICTS_DDL = `
CREATE TABLE IF NOT EXISTS acb_group_verdicts (
    slug        TEXT NOT NULL,
    group_id    TEXT NOT NULL,
    verdict     TEXT NOT NULL,
    note        TEXT,
    fix_prompt  TEXT,
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (slug, group_id)
);
CREATE INDEX IF NOT EXISTS idx_acb_group_verdicts_slug ON acb_group_verdicts(slug);
`;

function makeStore(): Store {
  const store = openStore({ path: ':memory:' });
  store.exec(ACB_GROUP_VERDICTS_DDL);
  return store;
}

function rowsFor(store: Store, slug: string): GroupVerdictRecord[] {
  return store
    .all<{
      slug: string;
      group_id: string;
      verdict: string;
      note: string | null;
      fix_prompt: string | null;
      updated_at: string;
    }>(
      'SELECT slug, group_id, verdict, note, fix_prompt, updated_at FROM acb_group_verdicts WHERE slug = ?',
      [slug],
    )
    .map((r) => ({
      slug: r.slug,
      groupId: r.group_id,
      verdict: r.verdict as GroupVerdictRecord['verdict'],
      note: r.note,
      fixPrompt: r.fix_prompt,
      updatedAt: r.updated_at,
    }));
}

describe('upsertGroupVerdict', () => {
  test('a single upsert lands exactly one row with the returned shape', () => {
    const store = makeStore();
    try {
      const record = upsertGroupVerdict(store, 'add-login', 'g1', 'accepted', 'looks good', null);

      expect(record.slug).toBe('add-login');
      expect(record.groupId).toBe('g1');
      expect(record.verdict).toBe('accepted');
      expect(record.note).toBe('looks good');
      expect(record.fixPrompt).toBeNull();
      expect(typeof record.updatedAt).toBe('string');

      const rows = rowsFor(store, 'add-login');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(record);
    } finally {
      store.close();
    }
  });

  test('a re-upsert on the same (slug, groupId) updates in place', () => {
    const store = makeStore();
    try {
      const first = upsertGroupVerdict(store, 'add-login', 'g1', 'pending', null, null);

      // Force a distinct ISO timestamp so the bump is observable; the stamp is
      // millisecond-resolution and a synchronous re-upsert can collide otherwise.
      const original = Date.prototype.toISOString;
      const bumped = new Date(Date.parse(first.updatedAt) + 1000).toISOString();
      Date.prototype.toISOString = () => bumped;
      let second: GroupVerdictRecord;
      try {
        second = upsertGroupVerdict(
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

      const rows = rowsFor(store, 'add-login');
      expect(rows).toHaveLength(1);
      expect(rows[0].verdict).toBe('rework');
      expect(rows[0].note).toBe('fix the thing');
      expect(rows[0].fixPrompt).toBe('apply this patch');
      expect(rows[0].updatedAt).toBe(bumped);
      expect(second.updatedAt).not.toBe(first.updatedAt);
    } finally {
      store.close();
    }
  });
});
