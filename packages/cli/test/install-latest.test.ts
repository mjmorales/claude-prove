/**
 * Integration tests for `claude-prove install latest`.
 *
 * `PROVE_PLUGIN_LIST_CMD` stubs the `claude plugin list --json` call so we
 * can feed known fixtures. `PROVE_GH_API_BASE` points remote lookups at a
 * local Bun.serve() so we never hit GitHub during CI.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = join(__dirname, '..', 'bin', 'run.ts');

interface RunResult {
  stdout: string;
  stderr: string;
  status: number;
}

function runBin(args: string[], env: Record<string, string>): RunResult {
  const result = spawnSync('bun', ['run', BIN, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', ...env },
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? -1,
  };
}

/** Build a fake `plugin list` command that prints the given JSON payload. */
function stubPluginList(payload: unknown): string {
  // `printf %s` is safer than `echo` (no backslash interpretation) and the
  // payload is JSON-escaped so embedded quotes survive the single-quote
  // shell wrapping.
  const json = JSON.stringify(payload).replace(/'/g, `'"'"'`);
  return `printf '%s' '${json}'`;
}

describe('claude-prove install latest — local resolution', () => {
  test('picks the highest-semver prove@prove entry', () => {
    const listPayload = [
      {
        id: 'prove@prove',
        version: '0.29.0',
        scope: 'user',
        enabled: true,
        installPath: '/fake/cache/prove/0.29.0',
      },
      {
        id: 'prove@prove',
        version: '2.3.0',
        scope: 'user',
        enabled: true,
        installPath: '/fake/cache/prove/2.3.0',
      },
      {
        id: 'other@marketplace',
        version: '1.0.0',
        scope: 'user',
        enabled: true,
        installPath: '/fake/other',
      },
    ];

    const { stdout, status } = runBin(['install', 'latest', '--offline'], {
      PROVE_PLUGIN_LIST_CMD: stubPluginList(listPayload),
    });

    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.local).toEqual({
      id: 'prove@prove',
      version: '2.3.0',
      installPath: '/fake/cache/prove/2.3.0',
      scope: 'user',
    });
    expect(parsed.remote).toBeNull();
    expect(parsed.upToDate).toBeNull();
    expect(parsed.errors).toEqual({});
  });

  test('reports a local error when no prove@prove entry exists', () => {
    const { stdout, status } = runBin(['install', 'latest', '--offline'], {
      PROVE_PLUGIN_LIST_CMD: stubPluginList([]),
    });

    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.local).toBeNull();
    expect(parsed.errors.local).toContain('no prove@prove entry');
  });

  test('reports a local error when the list command fails', () => {
    const { stdout, status } = runBin(['install', 'latest', '--offline'], {
      PROVE_PLUGIN_LIST_CMD: 'false',
    });

    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.local).toBeNull();
    expect(parsed.errors.local).toContain('exited');
  });
});

describe('claude-prove install latest — remote resolution', () => {
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl: string;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/repos/mjmorales/claude-prove/releases/latest') {
          return Response.json({
            tag_name: 'v9.9.9',
            html_url: 'https://example.invalid/releases/tag/v9.9.9',
          });
        }
        if (url.pathname.startsWith('/missing')) {
          return new Response('not found', { status: 404 });
        }
        return new Response('not found', { status: 404 });
      },
    });
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
  });

  test('fetches tag_name + html_url and computes upToDate=false when versions diverge', () => {
    const listPayload = [
      {
        id: 'prove@prove',
        version: '2.3.0',
        scope: 'user',
        enabled: true,
        installPath: '/fake/cache/prove/2.3.0',
      },
    ];

    const { stdout, status } = runBin(['install', 'latest'], {
      PROVE_PLUGIN_LIST_CMD: stubPluginList(listPayload),
      PROVE_GH_API_BASE: baseUrl,
    });

    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.remote).toEqual({
      tagName: 'v9.9.9',
      version: '9.9.9',
      url: 'https://example.invalid/releases/tag/v9.9.9',
    });
    expect(parsed.upToDate).toBe(false);
  });

  test('computes upToDate=true when local matches remote', () => {
    const listPayload = [
      {
        id: 'prove@prove',
        version: '9.9.9',
        scope: 'user',
        enabled: true,
        installPath: '/fake/cache/prove/9.9.9',
      },
    ];

    const { stdout, status } = runBin(['install', 'latest'], {
      PROVE_PLUGIN_LIST_CMD: stubPluginList(listPayload),
      PROVE_GH_API_BASE: baseUrl,
    });

    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.upToDate).toBe(true);
  });

  test('remote=null and error reported when releases API 404s', () => {
    const listPayload = [
      {
        id: 'prove@prove',
        version: '2.3.0',
        scope: 'user',
        enabled: true,
        installPath: '/fake/cache/prove/2.3.0',
      },
    ];

    const { stdout, status } = runBin(['install', 'latest'], {
      PROVE_PLUGIN_LIST_CMD: stubPluginList(listPayload),
      PROVE_GH_API_BASE: `${baseUrl}/missing`,
    });

    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.remote).toBeNull();
    expect(parsed.errors.remote).toContain('404');
    // With remote unknown the upToDate field must be null, not a guess.
    expect(parsed.upToDate).toBeNull();
  });
});
