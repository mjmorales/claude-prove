/**
 * Integration tests for review-ui server's acb.ts storage adapter.
 *
 * Each test opens a temp repo dir, drives the exported functions against
 * `.prove/prove.db`, and asserts round-trip fidelity with the same shapes
 * the server routes consume (GroupVerdictRecord, IntentManifest, etc.).
 *
 * Covers three scenarios:
 *   1. Fresh db: verdict write + read round-trip.
 *   2. Legacy verdict value: a `'approved'` string hand-written into the v1
 *      table reads back canonical (`'accepted'`) — canonicalization lives on
 *      the read path, not an in-chain migration.
 *   3. Read-only paths: missing db returns nulls/empties without
 *      auto-creating the file.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { openStore } from '@claude-prove/store';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearVerdict,
  getAcbDocument,
  getManifestForCommit,
  listManifestsForBranch,
  listManifestsForBranches,
  listManifestsForCommits,
  listManifestsForSlug,
  listVerdicts,
  upsertVerdict,
} from '../src/acb';

let repoRoot: string;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'prove-review-ui-'));
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

describe('verdict round-trip on a fresh db', () => {
  test('upsert → list returns the written record', async () => {
    const rec = await upsertVerdict(repoRoot, 'my-slug', 'g1', 'accepted', 'lgtm', null);
    expect(rec).toMatchObject({
      slug: 'my-slug',
      groupId: 'g1',
      verdict: 'accepted',
      note: 'lgtm',
      fixPrompt: null,
    });
    expect(typeof rec.updatedAt).toBe('string');

    const rows = await listVerdicts(repoRoot, 'my-slug');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(rec);
  });

  test('a second verdict on the same (slug, groupId) appends; list returns the latest via the head view', async () => {
    await upsertVerdict(repoRoot, 'my-slug', 'g1', 'accepted', null, null);
    const updated = await upsertVerdict(
      repoRoot,
      'my-slug',
      'g1',
      'rework',
      'add tests',
      'Please add a test',
    );
    expect(updated.verdict).toBe('rework');
    expect(updated.fixPrompt).toBe('Please add a test');

    // The head view collapses the two revisions to the latest.
    const rows = await listVerdicts(repoRoot, 'my-slug');
    expect(rows).toHaveLength(1);
    expect(rows[0].verdict).toBe('rework');

    // Append-only: both revisions persist in the base table; nothing was
    // overwritten.
    const db = await openStore({ path: join(repoRoot, '.prove/prove.db') });
    try {
      const counted = await db.all<{ n: number }>(
        'SELECT COUNT(*) AS n FROM acb_group_verdicts WHERE slug = ? AND group_id = ?',
        ['my-slug', 'g1'],
      );
      expect(counted[0]?.n).toBe(2);
    } finally {
      db.close();
    }
  });

  test('clearVerdict removes the row; subsequent clear is a no-op', async () => {
    await upsertVerdict(repoRoot, 'my-slug', 'g1', 'accepted', null, null);
    await clearVerdict(repoRoot, 'my-slug', 'g1');
    expect(await listVerdicts(repoRoot, 'my-slug')).toEqual([]);
    // Idempotent: no throw on a fresh slate.
    await clearVerdict(repoRoot, 'my-slug', 'g1');
  });

  test('verdicts are scoped by slug', async () => {
    await upsertVerdict(repoRoot, 'slug-a', 'g1', 'accepted', null, null);
    await upsertVerdict(repoRoot, 'slug-b', 'g1', 'rejected', null, null);
    const a = await listVerdicts(repoRoot, 'slug-a');
    const b = await listVerdicts(repoRoot, 'slug-b');
    expect(a).toHaveLength(1);
    expect(a[0].verdict).toBe('accepted');
    expect(b).toHaveLength(1);
    expect(b[0].verdict).toBe('rejected');
  });

  test('first verdict write auto-creates .prove/prove.db', async () => {
    expect(existsSync(join(repoRoot, '.prove/prove.db'))).toBe(false);
    await upsertVerdict(repoRoot, 'my-slug', 'g1', 'accepted', null, null);
    expect(existsSync(join(repoRoot, '.prove/prove.db'))).toBe(true);
  });
});

describe('legacy verdict canonicalization at the read boundary', () => {
  test('a legacy verdict string hand-written into the v1 table reads back canonical', async () => {
    // The clean v1 schema drops the in-chain verdict-normalization migration;
    // canonicalization lives entirely on the read path (coerceLegacyVerdict).
    // Stand up a fresh v1 db (the adapter migrates it on first open), then
    // hand-insert the legacy `'approved'` value directly into the v1 table —
    // the listing must still surface it as the canonical `'accepted'`.
    const dbDir = join(repoRoot, '.prove');
    mkdirSync(dbDir, { recursive: true });
    const dbFile = join(dbDir, 'prove.db');

    // First adapter call migrates the db to the v1 shape (creates every acb
    // table, including acb_group_verdicts).
    await listVerdicts(repoRoot, 'warmup');

    // Hand-write a legacy verdict value into the canonical v1 revision table.
    // The table is append-only with a ULID PK, so the insert supplies an `id`
    // and the `created_at` stamp (read back through the head view as
    // `updatedAt`).
    const db = await openStore({ path: dbFile });
    await db.run(
      'INSERT INTO acb_group_verdicts (id, slug, group_id, verdict, note, fix_prompt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['01HEAD000000000000000000V1', 'pre-phase-11', 'g1', 'approved', 'carryover', null, '2026-01-01T00:00:00Z'],
    );
    db.close();

    const rows = await listVerdicts(repoRoot, 'pre-phase-11');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      slug: 'pre-phase-11',
      groupId: 'g1',
      verdict: 'accepted',
      note: 'carryover',
      fixPrompt: null,
      updatedAt: '2026-01-01T00:00:00Z',
    });
  });
});

describe('read-only manifest queries', () => {
  test('all read paths return empty/null when .prove/prove.db is absent', async () => {
    expect(await getManifestForCommit(repoRoot, 'deadbeef')).toBeNull();
    expect(await listManifestsForBranches(repoRoot, ['feat/x'])).toEqual([]);
    expect(await listManifestsForCommits(repoRoot, ['deadbeef'])).toEqual([]);
    expect(await listManifestsForSlug(repoRoot, 'slug-x')).toEqual([]);
    expect(await listManifestsForBranch(repoRoot, 'feat/x')).toEqual([]);
    expect(await getAcbDocument(repoRoot, 'feat/x')).toBeNull();
    // Verifies the read paths don't auto-create the file.
    expect(existsSync(join(repoRoot, '.prove/prove.db'))).toBe(false);
  });
});
