/**
 * Integration coverage for the per-request project-scoping contract every data
 * route shares (the resolver wired in `buildApp`):
 *
 *   (a) `?project=<registered-id>` scopes git/fs to THAT root — two registered
 *       roots holding the same run slug return their OWN file content.
 *   (b) an unregistered or escaping `?project=` key is rejected with the
 *       structured `unknown project` 404 BEFORE any fs read — proven by the
 *       error body shape (project-resolution error, not the route's own
 *       `not found`) even though the file the route would read exists in the
 *       startup root.
 *   (c) an ABSENT `?project=` key falls back to the buildApp startup root, so
 *       the single-project UX keeps working while the frontend selector lands.
 *
 * `/api/runs/:slug/doc/:file` is the probe: it reads
 * `<resolvedRoot>/.prove/runs/<branch>/<slug>/<file>` directly, so the returned
 * `path`/`content` is a direct witness of which root the request resolved to.
 *
 * The registry `baseOverride` seam (threaded as `registryBaseOverride`) points
 * every read at a tmp dir, so no test touches the real `~/.claude-prove/`. A
 * "registered" root is a tmp dir with a `.prove/prove.db` (so the registry's
 * prune-on-read in the listing path would keep it) registered via the store's
 * `add`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { add as registryAdd } from '@claude-prove/store';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/index';

let baseDir: string;
let workspace: string;

/** Tmp root with a `.prove/prove.db`, registered in the tmp-dir registry. */
function registerLiveProject(name: string): string {
  const root = join(workspace, name);
  mkdirSync(join(root, '.prove'), { recursive: true });
  writeFileSync(join(root, '.prove', 'prove.db'), '');
  registryAdd(root, baseDir);
  return root;
}

/**
 * Seed a run doc artifact at `<root>/.prove/runs/<branch>/<slug>/<file>` and
 * return its content (which encodes the root so cross-root leakage is visible).
 */
function seedRunDoc(root: string, branch: string, slug: string, file: string): string {
  const dir = join(root, '.prove', 'runs', branch, slug);
  mkdirSync(dir, { recursive: true });
  const content = JSON.stringify({ marker: root });
  writeFileSync(join(dir, file), content);
  return content;
}

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'prove-scope-base-'));
  workspace = mkdtempSync(join(tmpdir(), 'prove-scope-ws-'));
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

async function build(startupRoot: string): Promise<FastifyInstance> {
  const app = await buildApp({
    repoRoot: startupRoot,
    webRoot: null,
    registryBaseOverride: baseDir,
  });
  await app.ready();
  return app;
}

describe('per-request project scoping on data routes', () => {
  test('(a) ?project=<registered-id> scopes the fs read to that root', async () => {
    const alpha = registerLiveProject('alpha');
    const beta = registerLiveProject('beta');
    // Same run slug present in BOTH roots, distinct content per root.
    const alphaContent = seedRunDoc(alpha, 'main', 'add-login', 'plan.json');
    const betaContent = seedRunDoc(beta, 'main', 'add-login', 'plan.json');

    // Startup root is alpha; betaKey selects beta explicitly.
    const app = await build(alpha);
    try {
      const betaKey = encodeURIComponent(beta);
      const res = await app.inject({
        method: 'GET',
        url: `/api/runs/main%2Fadd-login/doc/plan.json?project=${betaKey}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { path: string; content: string };
      expect(body.content).toBe(betaContent);
      expect(body.content).not.toBe(alphaContent);
      expect(body.path.startsWith(beta)).toBe(true);
    } finally {
      await app.close();
    }
  });

  test('(b) an unregistered key is rejected with `unknown project` before any fs read', async () => {
    const alpha = registerLiveProject('alpha');
    // The file the route WOULD read exists in the startup root, so a 404 here
    // can only come from project resolution, not from a missing file.
    seedRunDoc(alpha, 'main', 'add-login', 'plan.json');

    const app = await build(alpha);
    try {
      // Fastify URL-decodes the query value before the handler sees it, so the
      // echoed `project` is the decoded path — the raw key the client supplied.
      const decoded = join(workspace, 'not-registered');
      const res = await app.inject({
        method: 'GET',
        url: `/api/runs/main%2Fadd-login/doc/plan.json?project=${encodeURIComponent(decoded)}`,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'unknown project', project: decoded });
    } finally {
      await app.close();
    }
  });

  test('(b) an escaping `..` key that lands off any registered root is rejected before fs', async () => {
    const alpha = registerLiveProject('alpha');
    seedRunDoc(alpha, 'main', 'add-login', 'plan.json');

    const app = await build(alpha);
    try {
      // `<alpha>/..` normalizes to the parent dir — a prefix of, but not equal
      // to, a registered root, so membership rejects it.
      const decoded = join(alpha, '..');
      const res = await app.inject({
        method: 'GET',
        url: `/api/runs/main%2Fadd-login/doc/plan.json?project=${encodeURIComponent(decoded)}`,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'unknown project', project: decoded });
    } finally {
      await app.close();
    }
  });

  test('(a) a registered root containing a literal `%` resolves via a properly-encoded URL', async () => {
    // Single-decode contract: Fastify decodes the query value once on the wire,
    // so the handler sees the raw registry path (with its literal `%`), and the
    // resolver must NOT decode again. A second decode would mangle the `%`-bytes
    // and miss the registered root, breaking that project fail-closed.
    const alpha = registerLiveProject('alpha');
    const pct = registerLiveProject('pct%2Fname');
    expect(pct).toContain('%');
    const alphaContent = seedRunDoc(alpha, 'main', 'add-login', 'plan.json');
    const pctContent = seedRunDoc(pct, 'main', 'add-login', 'plan.json');

    // Startup root is alpha; the `%`-bearing root is selected explicitly.
    const app = await build(alpha);
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/runs/main%2Fadd-login/doc/plan.json?project=${encodeURIComponent(pct)}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { path: string; content: string };
      expect(body.content).toBe(pctContent);
      expect(body.content).not.toBe(alphaContent);
      expect(body.path.startsWith(pct)).toBe(true);
    } finally {
      await app.close();
    }
  });

  test('(c) absent ?project= falls back to the startup root', async () => {
    const alpha = registerLiveProject('alpha');
    const alphaContent = seedRunDoc(alpha, 'main', 'add-login', 'plan.json');

    const app = await build(alpha);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/runs/main%2Fadd-login/doc/plan.json',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { path: string; content: string };
      expect(body.content).toBe(alphaContent);
      expect(body.path.startsWith(alpha)).toBe(true);
    } finally {
      await app.close();
    }
  });

  test('scrum routes are project-scoped too — unknown key rejected before store open', async () => {
    const alpha = registerLiveProject('alpha');
    const app = await build(alpha);
    try {
      const decoded = join(workspace, 'not-registered');
      const res = await app.inject({
        method: 'GET',
        url: `/api/scrum/tasks?project=${encodeURIComponent(decoded)}`,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'unknown project', project: decoded });
    } finally {
      await app.close();
    }
  });

  test('/api/health stays project-agnostic — no project param required', async () => {
    const alpha = registerLiveProject('alpha');
    const app = await build(alpha);
    try {
      const res = await app.inject({ method: 'GET', url: '/api/health' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, repoRoot: alpha, webRoot: null });
    } finally {
      await app.close();
    }
  });
});
