/**
 * Integration tests for review-ui server's acb.ts storage adapter.
 *
 * Each test opens a temp repo dir, drives the exported functions against
 * `.prove/prove.db`, and asserts round-trip fidelity with the same shapes
 * the server routes consume (GroupVerdictRecord, IntentManifest, etc.).
 *
 * Covers three scenarios:
 *   1. Fresh db: verdict write + read round-trip.
 *   2. Legacy db: a .prove/prove.db created by the old review-ui server
 *      (has a bare `group_verdicts` table) still reads correctly after
 *      the v2 migration auto-backfills rows into `acb_group_verdicts`.
 *   3. Read-only paths: missing db returns nulls/empties without
 *      auto-creating the file.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
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
  test('upsert → list returns the written record', () => {
    const rec = upsertVerdict(repoRoot, 'my-slug', 'g1', 'accepted', 'lgtm', null);
    expect(rec).toMatchObject({
      slug: 'my-slug',
      groupId: 'g1',
      verdict: 'accepted',
      note: 'lgtm',
      fixPrompt: null,
    });
    expect(typeof rec.updatedAt).toBe('string');

    const rows = listVerdicts(repoRoot, 'my-slug');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(rec);
  });

  test('upsert twice on the same (slug, groupId) overwrites', () => {
    upsertVerdict(repoRoot, 'my-slug', 'g1', 'accepted', null, null);
    const updated = upsertVerdict(
      repoRoot,
      'my-slug',
      'g1',
      'rework',
      'add tests',
      'Please add a test',
    );
    expect(updated.verdict).toBe('rework');
    expect(updated.fixPrompt).toBe('Please add a test');

    const rows = listVerdicts(repoRoot, 'my-slug');
    expect(rows).toHaveLength(1);
    expect(rows[0].verdict).toBe('rework');
  });

  test('clearVerdict removes the row; subsequent clear is a no-op', () => {
    upsertVerdict(repoRoot, 'my-slug', 'g1', 'accepted', null, null);
    clearVerdict(repoRoot, 'my-slug', 'g1');
    expect(listVerdicts(repoRoot, 'my-slug')).toEqual([]);
    // Idempotent: no throw on a fresh slate.
    clearVerdict(repoRoot, 'my-slug', 'g1');
  });

  test('verdicts are scoped by slug', () => {
    upsertVerdict(repoRoot, 'slug-a', 'g1', 'accepted', null, null);
    upsertVerdict(repoRoot, 'slug-b', 'g1', 'rejected', null, null);
    const a = listVerdicts(repoRoot, 'slug-a');
    const b = listVerdicts(repoRoot, 'slug-b');
    expect(a).toHaveLength(1);
    expect(a[0].verdict).toBe('accepted');
    expect(b).toHaveLength(1);
    expect(b[0].verdict).toBe('rejected');
  });

  test('first verdict write auto-creates .prove/prove.db', () => {
    expect(existsSync(join(repoRoot, '.prove/prove.db'))).toBe(false);
    upsertVerdict(repoRoot, 'my-slug', 'g1', 'accepted', null, null);
    expect(existsSync(join(repoRoot, '.prove/prove.db'))).toBe(true);
  });
});

describe('legacy group_verdicts backfill', () => {
  test('v2 migration absorbs a pre-phase-11 bare group_verdicts table', () => {
    // Fabricate a legacy .prove/prove.db: v1 acb schema applied, then the
    // old review-ui server created a bare `group_verdicts` table and
    // inserted a row. Simulate both.
    const dbDir = join(repoRoot, '.prove');
    mkdirSync(dbDir, { recursive: true });
    const dbFile = join(dbDir, 'prove.db');
    const db = new Database(dbFile, { create: true });
    db.exec(`
      CREATE TABLE _migrations_log (
        domain TEXT NOT NULL,
        version INTEGER NOT NULL,
        description TEXT NOT NULL,
        applied_at TEXT NOT NULL,
        PRIMARY KEY (domain, version)
      );
      INSERT INTO _migrations_log (domain, version, description, applied_at)
        VALUES ('acb', 1, 'create acb_manifests + acb_acb_documents + acb_review_state', '2026-01-01T00:00:00Z');

      CREATE TABLE acb_manifests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        branch TEXT NOT NULL,
        commit_sha TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL,
        run_slug TEXT
      );
      CREATE TABLE acb_acb_documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        branch TEXT NOT NULL UNIQUE,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE acb_review_state (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        branch TEXT NOT NULL UNIQUE,
        acb_hash TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE group_verdicts (
        slug        TEXT NOT NULL,
        group_id    TEXT NOT NULL,
        verdict     TEXT NOT NULL,
        note        TEXT,
        fix_prompt  TEXT,
        updated_at  TEXT NOT NULL,
        PRIMARY KEY (slug, group_id)
      );
      INSERT INTO group_verdicts (slug, group_id, verdict, note, fix_prompt, updated_at)
        VALUES ('pre-phase-11', 'g1', 'approved', 'carryover', NULL, '2026-01-01T00:00:00Z');
    `);
    db.close();

    // First call through the adapter triggers the v2 backfill (legacy
    // `group_verdicts` → `acb_group_verdicts`) and the v3 normalization
    // (`'approved'` → canonical `'accepted'`). The legacy row should
    // appear in the listing under the new table with the canonical verdict.
    const rows = listVerdicts(repoRoot, 'pre-phase-11');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      slug: 'pre-phase-11',
      groupId: 'g1',
      verdict: 'accepted',
      note: 'carryover',
      fixPrompt: null,
      updatedAt: '2026-01-01T00:00:00Z',
    });

    // Legacy table is gone.
    const check = new Database(dbFile, { readonly: true });
    try {
      const legacy = check
        .prepare<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'group_verdicts'",
        )
        .all();
      expect(legacy).toHaveLength(0);
    } finally {
      check.close();
    }
  });
});

describe('read-only manifest queries', () => {
  test('all read paths return empty/null when .prove/prove.db is absent', () => {
    expect(getManifestForCommit(repoRoot, 'deadbeef')).toBeNull();
    expect(listManifestsForBranches(repoRoot, ['feat/x'])).toEqual([]);
    expect(listManifestsForCommits(repoRoot, ['deadbeef'])).toEqual([]);
    expect(listManifestsForSlug(repoRoot, 'slug-x')).toEqual([]);
    expect(listManifestsForBranch(repoRoot, 'feat/x')).toEqual([]);
    expect(getAcbDocument(repoRoot, 'feat/x')).toBeNull();
    // Verifies the read paths don't auto-create the file.
    expect(existsSync(join(repoRoot, '.prove/prove.db'))).toBe(false);
  });
});
