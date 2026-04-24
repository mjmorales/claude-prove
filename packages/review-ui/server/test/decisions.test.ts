/**
 * Tests for `resolveDecisionById` (task 3.2 — DB-first decision read with
 * disk fallback) and the `/api/decisions/:id` route wiring.
 *
 * Coverage matrix:
 *   - DB hit: resolver returns DB content with `source: 'db'` even when a
 *     .md file also exists on disk (DB wins).
 *   - Disk fallback: no DB row → resolver reads
 *     `.prove/decisions/<id>.md` and returns `source: 'disk'`.
 *   - 404: neither DB nor disk has the id → resolver returns null;
 *     route returns 404.
 *   - Route integration: `/api/decisions/:id` returns the resolved shape
 *     including the additive `source` field.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openScrumStore } from '@claude-prove/cli/scrum/store';
import Fastify from 'fastify';
import { resolveDecisionById } from '../src/decisions';
import { registerProveRoutes } from '../src/routes/prove';

const DECISION_ID_DB_ONLY = '2026-04-24-db-only';
const DECISION_ID_DISK_ONLY = '2026-04-24-disk-only';
const DECISION_ID_BOTH = '2026-04-24-both';
const DECISION_ID_MISSING = '2026-04-24-missing';

const DB_CONTENT_BOTH = '# DB version\n\nauthoritative body from sqlite';
const DISK_CONTENT_BOTH = '# Disk version\n\nstale body from working tree';
const DB_CONTENT_DB_ONLY = '# DB only\n\nbody persisted only in sqlite';
const DISK_CONTENT_DISK_ONLY = '# Disk only\n\nbody persisted only on disk';

let repoRoot: string;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'prove-decisions-'));
  mkdirSync(join(repoRoot, '.prove/decisions'), { recursive: true });

  // Seed DB rows for DB-only and both-sources cases.
  const dbFile = join(repoRoot, '.prove/prove.db');
  const store = openScrumStore({ override: dbFile });
  try {
    store.recordDecision({
      id: DECISION_ID_DB_ONLY,
      title: 'DB only',
      content: DB_CONTENT_DB_ONLY,
    });
    store.recordDecision({
      id: DECISION_ID_BOTH,
      title: 'Both sources',
      content: DB_CONTENT_BOTH,
    });
  } finally {
    store.close();
  }

  // Seed disk files for disk-only and both-sources cases.
  writeFileSync(
    join(repoRoot, '.prove/decisions', `${DECISION_ID_DISK_ONLY}.md`),
    DISK_CONTENT_DISK_ONLY,
  );
  writeFileSync(
    join(repoRoot, '.prove/decisions', `${DECISION_ID_BOTH}.md`),
    DISK_CONTENT_BOTH,
  );
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// resolveDecisionById
// ---------------------------------------------------------------------------

describe('resolveDecisionById', () => {
  test('DB hit wins when both sources are present', async () => {
    const resolved = await resolveDecisionById(repoRoot, DECISION_ID_BOTH);
    expect(resolved).not.toBeNull();
    expect(resolved?.source).toBe('db');
    expect(resolved?.content).toBe(DB_CONTENT_BOTH);
    expect(resolved?.id).toBe(DECISION_ID_BOTH);
    expect(resolved?.path.endsWith(`${DECISION_ID_BOTH}.md`)).toBe(true);
  });

  test('DB hit when disk file is absent', async () => {
    const resolved = await resolveDecisionById(repoRoot, DECISION_ID_DB_ONLY);
    expect(resolved).not.toBeNull();
    expect(resolved?.source).toBe('db');
    expect(resolved?.content).toBe(DB_CONTENT_DB_ONLY);
  });

  test('falls back to disk when DB row is missing', async () => {
    const resolved = await resolveDecisionById(repoRoot, DECISION_ID_DISK_ONLY);
    expect(resolved).not.toBeNull();
    expect(resolved?.source).toBe('disk');
    expect(resolved?.content).toBe(DISK_CONTENT_DISK_ONLY);
  });

  test('returns null when neither source has the id', async () => {
    const resolved = await resolveDecisionById(repoRoot, DECISION_ID_MISSING);
    expect(resolved).toBeNull();
  });

  test('falls back to disk when prove.db does not exist', async () => {
    // Fresh repo with only a disk file and no .prove/prove.db — mirrors a
    // pre-scrum repo still using the legacy filesystem-only decisions flow.
    const legacyRoot = mkdtempSync(join(tmpdir(), 'prove-decisions-legacy-'));
    try {
      mkdirSync(join(legacyRoot, '.prove/decisions'), { recursive: true });
      writeFileSync(
        join(legacyRoot, '.prove/decisions', `${DECISION_ID_DISK_ONLY}.md`),
        DISK_CONTENT_DISK_ONLY,
      );
      const resolved = await resolveDecisionById(legacyRoot, DECISION_ID_DISK_ONLY);
      expect(resolved?.source).toBe('disk');
      expect(resolved?.content).toBe(DISK_CONTENT_DISK_ONLY);
    } finally {
      rmSync(legacyRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// GET /api/decisions/:id route
// ---------------------------------------------------------------------------

describe('GET /api/decisions/:id', () => {
  test('returns DB content when the id is in the DB', async () => {
    const app = Fastify({ logger: false });
    registerProveRoutes(app, repoRoot);
    await app.ready();
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/decisions/${DECISION_ID_BOTH}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        id: string;
        path: string;
        content: string;
        source?: string;
      };
      expect(body.id).toBe(DECISION_ID_BOTH);
      expect(body.content).toBe(DB_CONTENT_BOTH);
      expect(body.source).toBe('db');
    } finally {
      await app.close();
    }
  });

  test('returns disk content when only disk has the id', async () => {
    const app = Fastify({ logger: false });
    registerProveRoutes(app, repoRoot);
    await app.ready();
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/decisions/${DECISION_ID_DISK_ONLY}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { content: string; source?: string };
      expect(body.content).toBe(DISK_CONTENT_DISK_ONLY);
      expect(body.source).toBe('disk');
    } finally {
      await app.close();
    }
  });

  test('404 when neither DB nor disk has the id', async () => {
    const app = Fastify({ logger: false });
    registerProveRoutes(app, repoRoot);
    await app.ready();
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/decisions/${DECISION_ID_MISSING}`,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'not found' });
    } finally {
      await app.close();
    }
  });

  test('400 on malformed id', async () => {
    const app = Fastify({ logger: false });
    registerProveRoutes(app, repoRoot);
    await app.ready();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/decisions/bad%20id%21',
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
