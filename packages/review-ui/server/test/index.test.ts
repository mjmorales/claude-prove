/**
 * Tests for the importable boot path: `buildApp` wires the health route and
 * the same-origin CORS allow-list, and `resolveWebRoot` honors its three-tier
 * precedence (embedded → plugin-dir dist → WEB_ROOT env).
 *
 * Importing `../src/index` must have no side effect (no listen/exit), which is
 * itself part of the contract under test — the module loads cleanly here.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, resolveWebRoot } from '../src/index';

const REPO_ROOT = '/nonexistent-repo-root';
const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 5174);

describe('buildApp', () => {
  test('wires /api/health returning ok + roots without listening', async () => {
    const app = await buildApp({ repoRoot: REPO_ROOT, webRoot: null });
    await app.ready();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/health' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, repoRoot: REPO_ROOT, webRoot: null });
    } finally {
      await app.close();
    }
  });

  test('CORS reflects only the host:port and localhost:port allow-list', async () => {
    const app = await buildApp({ repoRoot: REPO_ROOT, webRoot: null });
    await app.ready();
    try {
      const allowed = `http://${HOST}:${PORT}`;
      const allowedRes = await app.inject({
        method: 'GET',
        url: '/api/health',
        headers: { origin: allowed },
      });
      expect(allowedRes.headers['access-control-allow-origin']).toBe(allowed);

      const localhost = `http://localhost:${PORT}`;
      const localhostRes = await app.inject({
        method: 'GET',
        url: '/api/health',
        headers: { origin: localhost },
      });
      expect(localhostRes.headers['access-control-allow-origin']).toBe(localhost);

      // An off-allow-list origin is not reflected — the CSRF guard holds.
      const evilRes = await app.inject({
        method: 'GET',
        url: '/api/health',
        headers: { origin: 'http://evil.example' },
      });
      expect(evilRes.headers['access-control-allow-origin']).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});

describe('resolveWebRoot tier order', () => {
  let tmp: string;
  const savedWebRoot = process.env.WEB_ROOT;
  const savedPluginDir = process.env.CLAUDE_PROVE_PLUGIN_DIR;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'prove-webroot-'));
    process.env.WEB_ROOT = undefined as unknown as string;
    delete process.env.WEB_ROOT;
    delete process.env.CLAUDE_PROVE_PLUGIN_DIR;
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    if (savedWebRoot === undefined) delete process.env.WEB_ROOT;
    else process.env.WEB_ROOT = savedWebRoot;
    if (savedPluginDir === undefined) delete process.env.CLAUDE_PROVE_PLUGIN_DIR;
    else process.env.CLAUDE_PROVE_PLUGIN_DIR = savedPluginDir;
  });

  test('returns null when no tier resolves', () => {
    expect(resolveWebRoot()).toBeNull();
  });

  test('WEB_ROOT env override resolves when the dir exists', () => {
    const dist = join(tmp, 'env-dist');
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'index.html'), '<html></html>');
    process.env.WEB_ROOT = dist;
    expect(resolveWebRoot()).toBe(dist);
  });

  test('plugin-dir dist outranks WEB_ROOT', () => {
    // Plugin-install layout: <pluginDir>/packages/review-ui/web/dist
    const pluginDist = join(tmp, 'plugin', 'packages', 'review-ui', 'web', 'dist');
    mkdirSync(pluginDist, { recursive: true });
    const envDist = join(tmp, 'env-dist');
    mkdirSync(envDist, { recursive: true });

    process.env.CLAUDE_PROVE_PLUGIN_DIR = join(tmp, 'plugin');
    process.env.WEB_ROOT = envDist;

    expect(resolveWebRoot()).toBe(pluginDist);
  });

  test('falls through to WEB_ROOT when plugin-dir dist is absent', () => {
    const envDist = join(tmp, 'env-dist');
    mkdirSync(envDist, { recursive: true });

    // Plugin dir set but its dist does not exist.
    process.env.CLAUDE_PROVE_PLUGIN_DIR = join(tmp, 'plugin-without-dist');
    process.env.WEB_ROOT = envDist;

    expect(resolveWebRoot()).toBe(envDist);
  });

  test('injected embedded accessor outranks WEB_ROOT when it returns an existing dir', () => {
    // The embedded tier is the compiled-binary cache dir; inject a stub returning
    // it so the tier ordering is exercised without an actual compiled binary.
    const embeddedDir = join(tmp, 'embedded-cache');
    mkdirSync(embeddedDir, { recursive: true });
    const envDist = join(tmp, 'env-dist');
    mkdirSync(envDist, { recursive: true });
    process.env.WEB_ROOT = envDist;

    expect(resolveWebRoot(() => embeddedDir)).toBe(embeddedDir);
  });

  test('falls through past the embedded tier when the accessor returns null', () => {
    const envDist = join(tmp, 'env-dist');
    mkdirSync(envDist, { recursive: true });
    process.env.WEB_ROOT = envDist;

    // A null accessor (not a compiled binary) leaves WEB_ROOT to win.
    expect(resolveWebRoot(() => null)).toBe(envDist);
  });

  test('skips a non-existent embedded dir and falls through', () => {
    const envDist = join(tmp, 'env-dist');
    mkdirSync(envDist, { recursive: true });
    process.env.WEB_ROOT = envDist;

    // Accessor returns a path that does not exist — existsSync guard rejects it.
    expect(resolveWebRoot(() => join(tmp, 'no-such-embedded'))).toBe(envDist);
  });
});
