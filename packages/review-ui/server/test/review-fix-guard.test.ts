/**
 * HTTP-level coverage for the `/fix` route's empty-note guard.
 *
 * An empty reviewer note mints a content-free rework brief and silently drops
 * the reviewer's intent, so the route must reject it with a 400 the same way
 * `/discuss` does. A non-empty note proceeds and returns the composed prompt.
 *
 * Harness mirrors `schema-guard.test.ts`: a tmp root registered with an empty
 * `.prove/` (NO `prove.db`). An uninitialized store is fail-open, so the
 * behind-schema guard passes and the write service creates/migrates its own db
 * — exercising the note guard, not the schema guard.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { add as registryAdd } from '@claude-prove/store';
import { ensureAcbSchemaRegistered } from '@claude-prove/cli/acb/store';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/index';

let baseDir: string;
let workspace: string;

/** Register a tmp root with an empty `.prove/` (no db) — fail-open, so the
 * write service owns db creation and the schema guard passes. */
function registerRoot(name: string): string {
  const root = join(workspace, name);
  mkdirSync(join(root, '.prove'), { recursive: true });
  registryAdd(root, baseDir);
  return root;
}

async function build(startupRoot: string): Promise<FastifyInstance> {
  const app = await buildApp({
    repoRoot: startupRoot,
    webRoot: null,
    registryBaseOverride: baseDir,
  });
  await app.ready();
  return app;
}

beforeEach(() => {
  ensureAcbSchemaRegistered();
  baseDir = mkdtempSync(join(tmpdir(), 'prove-fix-base-'));
  workspace = mkdtempSync(join(tmpdir(), 'prove-fix-ws-'));
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

describe('POST /api/runs/:slug/review/:groupId/fix empty-note guard', () => {
  test('an all-whitespace note is rejected with 400 (matching /discuss)', async () => {
    const root = registerRoot('alpha');
    const app = await build(root);
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/runs/main%2Fadd-login/review/grp-1/fix?project=${encodeURIComponent(root)}`,
        payload: { note: '   ' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'note required' });
    } finally {
      await app.close();
    }
  });

  test('a missing note field is rejected with 400', async () => {
    const root = registerRoot('alpha');
    const app = await build(root);
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/runs/main%2Fadd-login/review/grp-1/fix?project=${encodeURIComponent(root)}`,
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'note required' });
    } finally {
      await app.close();
    }
  });

  test('a non-empty note proceeds and returns the composed prompt', async () => {
    const root = registerRoot('alpha');
    const app = await build(root);
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/runs/main%2Fadd-login/review/grp-1/fix?project=${encodeURIComponent(root)}`,
        payload: { note: 'fix the off-by-one', title: 'Add login', files: ['src/a.ts'] },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { prompt: string; record: { verdict: string } };
      expect(body.prompt).toContain('fix the off-by-one');
      expect(body.record.verdict).toBe('rework');
    } finally {
      await app.close();
    }
  });
});
