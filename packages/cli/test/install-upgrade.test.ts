/**
 * Integration tests for `prove install upgrade`.
 *
 * Dev mode: a fixture with `packages/cli/src/` present forces `detectMode`
 * to return 'dev'; the command must exit 1 with the documented stderr.
 *
 * Compiled mode: a sibling fixture without `packages/cli/src/` plus a
 * Bun.serve() stub on 127.0.0.1 replaces the GitHub CDN. We verify the
 * atomic swap lands the expected payload, at 0o755, under the configured
 * --prefix.
 *
 * CLAUDE_PLUGIN_ROOT is set in the child env so `resolvePluginRoot`
 * bypasses its walk-upward search and classifies the fixture directly.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = join(__dirname, '..', 'bin', 'run.ts');

interface RunResult {
  stdout: string;
  stderr: string;
  status: number;
}

interface RunEnv {
  CLAUDE_PLUGIN_ROOT?: string;
  PROVE_RELEASE_URL_BASE?: string;
}

function runBin(args: string[], env: RunEnv): RunResult {
  const result = spawnSync('bun', ['run', BIN, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      ...env,
    },
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? -1,
  };
}

function makeDevPluginFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'prove-install-upgrade-dev-'));
  mkdirSync(join(root, 'packages', 'cli', 'src'), { recursive: true });
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(root, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'dev-fixture', version: '0.0.0' }),
  );
  return root;
}

function makeCompiledPluginFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'prove-install-upgrade-compiled-'));
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(root, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'compiled-fixture', version: '0.0.0' }),
  );
  return root;
}

function currentTarget(): string {
  const platform = process.platform;
  const arch = process.arch;
  return `${platform}-${arch}`;
}

describe('prove install upgrade — dev mode', () => {
  test('exits 1 with the dev-mode error when invoked from a dev checkout', () => {
    const pluginRoot = makeDevPluginFixture();
    try {
      const { stderr, status } = runBin(['install', 'upgrade'], {
        CLAUDE_PLUGIN_ROOT: pluginRoot,
      });
      expect(status).toBe(1);
      expect(stderr).toContain('upgrade is a compiled-mode command; use git pull in dev checkouts');
    } finally {
      rmSync(pluginRoot, { recursive: true, force: true });
    }
  });
});

describe('prove install upgrade — compiled mode with stubbed CDN', () => {
  const pluginRoot = makeCompiledPluginFixture();
  const payload = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]); // ELF magic + padding
  const target = currentTarget();

  let server: ReturnType<typeof Bun.serve>;
  let baseUrl: string;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === `/claude-prove-${target}`) {
          return new Response(payload, { status: 200 });
        }
        return new Response('not found', { status: 404 });
      },
    });
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
    rmSync(pluginRoot, { recursive: true, force: true });
  });

  test('downloads payload, chmods +x, and atomic-renames to --prefix', () => {
    const prefix = mkdtempSync(join(tmpdir(), 'prove-install-upgrade-prefix-'));
    try {
      const { stdout, stderr, status } = runBin(['install', 'upgrade', '--prefix', prefix], {
        CLAUDE_PLUGIN_ROOT: pluginRoot,
        PROVE_RELEASE_URL_BASE: baseUrl,
      });
      expect(stderr).toBe('');
      expect(status).toBe(0);

      const destPath = join(prefix, 'claude-prove');
      expect(stdout).toContain(`upgraded to ${destPath}`);
      expect(stdout).toContain(`(${payload.byteLength} bytes)`);

      const written = readFileSync(destPath);
      expect(written.length).toBe(payload.byteLength);
      for (let i = 0; i < payload.byteLength; i++) {
        expect(written[i]).toBe(payload[i]);
      }

      const stat = statSync(destPath);
      const mode = stat.mode & 0o777;
      expect(mode).toBe(0o755);
    } finally {
      rmSync(prefix, { recursive: true, force: true });
    }
  });

  test('exits 1 when the CDN responds with 404', () => {
    const prefix = mkdtempSync(join(tmpdir(), 'prove-install-upgrade-404-'));
    try {
      const { stderr, status } = runBin(['install', 'upgrade', '--prefix', prefix], {
        CLAUDE_PLUGIN_ROOT: pluginRoot,
        // Point at a path the stub returns 404 for.
        PROVE_RELEASE_URL_BASE: `${baseUrl}/missing`,
      });
      expect(status).toBe(1);
      expect(stderr).toContain('fetch failed');
      expect(stderr).toContain('404');
    } finally {
      rmSync(prefix, { recursive: true, force: true });
    }
  });
});
