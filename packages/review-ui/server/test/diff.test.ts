/**
 * Integration tests for the diff route input guards (F-7-001 / F-7-002).
 *
 * These guards reject malformed git refs and traversal-style paths *before*
 * any git subprocess runs, so the tests need no real repository — a dummy
 * repoRoot suffices and every case asserts a 400 short-circuit.
 */

import { beforeAll, describe, expect, test } from 'bun:test';
import Fastify, { type FastifyInstance } from 'fastify';
import { makeProjectResolver } from '../src/projects';
import { registerDiffRoutes } from '../src/routes/diff';

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ logger: false });
  // No `?project=` is sent, so the resolver returns this fallback root; the ref/
  // path guards then fire before git is invoked, so the root is never reached.
  registerDiffRoutes(app, makeProjectResolver('/nonexistent-repo-root'));
  await app.ready();
});

describe('/api/diff ref guard (F-7-001)', () => {
  test('rejects leading-dash base as a bad ref', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/diff?base=--output=/tmp/pwn&head=main',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json() as { error: string }).toEqual({ error: 'bad ref' });
  });

  test('rejects leading-dash head as a bad ref', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/diff?base=main&head=-fientry',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json() as { error: string }).toEqual({ error: 'bad ref' });
  });

  test('rejects refs with disallowed characters', async () => {
    const res = await app.inject({
      method: 'GET',
      // space is outside the allowlist
      url: `/api/diff?base=${encodeURIComponent('main feature')}&head=main`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json() as { error: string }).toEqual({ error: 'bad ref' });
  });
});

describe('/api/diff/file guards (F-7-001 / F-7-002)', () => {
  test('rejects leading-dash ref', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/diff/file?base=-x&head=main&path=src/index.ts',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json() as { error: string }).toEqual({ error: 'bad ref' });
  });

  test('rejects absolute path', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/diff/file?base=main&head=feat&path=${encodeURIComponent('/etc/passwd')}`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json() as { error: string }).toEqual({ error: 'bad path' });
  });

  test('rejects parent-traversal path', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/diff/file?base=main&head=feat&path=${encodeURIComponent('../../etc/passwd')}`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json() as { error: string }).toEqual({ error: 'bad path' });
  });

  test('rejects leading-dash path', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/diff/file?base=main&head=feat&path=${encodeURIComponent('--output')}`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json() as { error: string }).toEqual({ error: 'bad path' });
  });
});

describe('/api/diff/pending path guard (F-7-002)', () => {
  test('rejects traversal path before resolving the run', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/diff/pending?slug=main/add-login&path=${encodeURIComponent('../../etc/passwd')}`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json() as { error: string }).toEqual({ error: 'bad path' });
  });
});
