/**
 * Integration tests for `claude-prove install upgrade`.
 *
 * The dev/compiled gate is provenance-based: a `bun run` source invocation
 * (which is what these tests spawn) classifies as dev and must exit 1 with
 * the documented stderr — regardless of what any plugin-root env var points
 * at. The compiled download path is exercised via the `PROVE_FORCE_MODE=
 * compiled` override plus a Bun.serve() stub on 127.0.0.1 replacing the
 * GitHub CDN: we verify the atomic swap lands the expected payload, at
 * 0o755, under the configured --prefix.
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
  CLAUDE_PROVE_PLUGIN_DIR?: string;
  PROVE_RELEASE_URL_BASE?: string;
  PROVE_FORCE_MODE?: string;
}

function runBin(args: string[], env: RunEnv): RunResult {
  const result = spawnSync('bun', ['run', BIN, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      // The session may inject CLAUDE_PROVE_PLUGIN_DIR (settings.local.json
      // env block), which outranks the CLAUDE_PLUGIN_ROOT pins these tests
      // rely on for mode detection. Empty string = unset for the resolver.
      CLAUDE_PROVE_PLUGIN_DIR: '',
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

describe('claude-prove install upgrade — dev provenance', () => {
  test('a bun-run source invocation exits 1 with the dev-mode error', () => {
    const { stderr, status } = runBin(['install', 'upgrade'], {});
    expect(status).toBe(1);
    expect(stderr).toContain('upgrade is a compiled-mode command; use git pull in dev checkouts');
  });

  test('plugin-root env vars cannot flip a source invocation to compiled', () => {
    // Provenance wins: even a compiled-shaped plugin root (no packages/cli/src)
    // pinned via both env vars must not unlock the download path when the
    // process itself runs from sources.
    const pluginRoot = makeCompiledPluginFixture();
    try {
      const { stderr, status } = runBin(['install', 'upgrade'], {
        CLAUDE_PLUGIN_ROOT: pluginRoot,
        CLAUDE_PROVE_PLUGIN_DIR: pluginRoot,
      });
      expect(status).toBe(1);
      expect(stderr).toContain('upgrade is a compiled-mode command; use git pull in dev checkouts');
    } finally {
      rmSync(pluginRoot, { recursive: true, force: true });
    }
  });

  test('PROVE_FORCE_MODE=dev refuses even when set explicitly', () => {
    const { status, stderr } = runBin(['install', 'upgrade'], { PROVE_FORCE_MODE: 'dev' });
    expect(status).toBe(1);
    expect(stderr).toContain('upgrade is a compiled-mode command');
  });
});

describe('claude-prove install upgrade — compiled mode with stubbed CDN', () => {
  // bun-run provenance classifies as dev; force compiled to reach the
  // download path under test.
  const FORCE = { PROVE_FORCE_MODE: 'compiled' };
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
  });

  test('downloads payload, chmods +x, and atomic-renames to --prefix', () => {
    const prefix = mkdtempSync(join(tmpdir(), 'prove-install-upgrade-prefix-'));
    try {
      const { stdout, stderr, status } = runBin(['install', 'upgrade', '--prefix', prefix], {
        ...FORCE,
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
        ...FORCE,
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
