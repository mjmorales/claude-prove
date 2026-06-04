/**
 * Tests for `review-ui serve` — arg dispatch and a real start/health/stop cycle.
 *
 * Dispatch tests inject a `SpawnFn` and a `resolveWebRoot` seam so each verb's
 * routing into the daemon lifecycle is asserted without forking a real process:
 * the injected spawn records the `SpawnContext` and returns a controlled pid,
 * and a loopback health server stands in for the booted child.
 *
 * The integration cycle forks the REAL detached child (`serve-child.ts` under
 * bun), waits for `/api/health`, then asserts the listener is bound to
 * 127.0.0.1 ONLY: reachable on loopback, NOT reachable on this host's
 * non-loopback interface address. It uses a tmp base dir (the daemon pidfile
 * seam) so the developer's real `~/.claude-prove/review-ui/` is never touched.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import { connect } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpawnContext } from './daemon';
import { readPidfile, removePidfile, stop } from './daemon';
import { DEFAULT_REVIEW_UI_PORT } from './port-config';
import { resolvePort, resolveRepoRoot, runServe } from './serve';
import { CHILD_PORT_ENV, CHILD_REPO_ROOT_ENV, CHILD_WEB_ROOT_ENV } from './serve-child';

const HOST = '127.0.0.1';

let baseDir: string;
let server: Server | null;

/** Start a loopback HTTP server answering `/api/health` 200 on the given port. */
function startHealthServer(port: number): Promise<void> {
  return new Promise((resolveServer) => {
    server = createServer((req, res) => {
      if (req.url === '/api/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(port, HOST, () => resolveServer());
  });
}

function stopHealthServer(): Promise<void> {
  return new Promise((resolveStop) => {
    if (server === null) {
      resolveStop();
      return;
    }
    server.close(() => resolveStop());
    server = null;
  });
}

/** Pick a free loopback port by binding an ephemeral listener and reading it back. */
function freePort(): Promise<number> {
  return new Promise((resolveFree) => {
    const probe = createServer();
    probe.listen(0, HOST, () => {
      const addr = probe.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      probe.close(() => resolveFree(port));
    });
  });
}

/** First non-internal IPv4 address on this host, or null when none exists. */
function nonLoopbackAddress(): string | null {
  const ifaces = networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const addr of ifaces[name] ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return null;
}

/** True when something accepts a TCP connection at host:port within the timeout. */
function reachable(host: string, port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const socket = connect({ host, port });
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveProbe(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'rui-serve-base-'));
  server = null;
});

afterEach(async () => {
  await stopHealthServer();
  // Reap any daemon a start test recorded so a forked child never leaks — but
  // NEVER SIGTERM our own pid (the injected spawn records process.pid, and
  // stop() would otherwise kill the test runner). Drop our own record; signal
  // only a genuinely-foreign forked child.
  const recorded = readPidfile(baseDir);
  if (recorded === process.pid) removePidfile(baseDir);
  else stop({ baseOverride: baseDir });
  try {
    rmSync(baseDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('review-ui serve — arg dispatch', () => {
  test('an unknown sub-verb errors with exit 1', async () => {
    const code = await runServe({ verb: 'frobnicate', baseOverride: baseDir });
    expect(code).toBe(1);
  });

  test('an empty sub-verb errors with exit 1', async () => {
    expect(await runServe({ verb: '', baseOverride: baseDir })).toBe(1);
  });

  test('start routes through the injected spawn, threading port + host to the child', async () => {
    const port = await freePort();
    await startHealthServer(port);

    let captured: SpawnContext | null = null;
    const spawnFn = (ctx: SpawnContext) => {
      captured = ctx;
      return process.pid; // a live pid the lifecycle records
    };

    const code = await runServe({
      verb: 'start',
      cwd: process.cwd(),
      baseOverride: baseDir,
      port,
      spawnFn,
      resolveWebRoot: async () => '/tmp/some/web/dist',
      warn: () => {},
    });

    expect(code).toBe(0);
    expect(captured).not.toBeNull();
    const ctx = captured as unknown as SpawnContext;
    expect(ctx.host).toBe(HOST);
    expect(ctx.port).toBe(port);
    expect(readPidfile(baseDir)).toBe(process.pid);
  });

  test('start warns and boots API-only when webRoot resolves null', async () => {
    const port = await freePort();
    await startHealthServer(port);

    const warnings: string[] = [];
    const spawnFn = () => process.pid;
    const code = await runServe({
      verb: 'start',
      baseOverride: baseDir,
      port,
      spawnFn,
      resolveWebRoot: async () => null,
      warn: (m) => warnings.push(m),
    });

    expect(code).toBe(0);
    expect(warnings.some((w) => /API-only/.test(w))).toBe(true);
  });

  test('start surfaces exit 1 when the daemon health poll fails', async () => {
    // No health server bound on the pinned port → the poll exhausts its
    // injected sub-second budget and rejects; runServe maps that to exit 1.
    const port = await freePort();
    const spawnFn = () => process.pid;
    const code = await runServe({
      verb: 'start',
      baseOverride: baseDir,
      port,
      spawnFn,
      resolveWebRoot: async () => null,
      pollTimeoutMs: 300,
      pollIntervalMs: 50,
      warn: () => {},
    });
    expect(code).toBe(1);
  });

  test('status prints JSON and reports stopped with no pidfile', async () => {
    const writes: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    // Capture the single JSON line status emits on stdout.
    (process.stdout.write as unknown) = (chunk: string) => {
      writes.push(chunk);
      return true;
    };
    try {
      const code = await runServe({ verb: 'status', baseOverride: baseDir });
      expect(code).toBe(0);
    } finally {
      (process.stdout.write as unknown) = orig;
    }
    const parsed = JSON.parse(writes.join(''));
    expect(parsed.running).toBe(false);
    expect(parsed.pid).toBeNull();
    expect(typeof parsed.port).toBe('number');
  });

  test('stop is a no-op when nothing is recorded and exits 0', async () => {
    expect(await runServe({ verb: 'stop', baseOverride: baseDir })).toBe(0);
  });
});

describe('review-ui serve — input resolution', () => {
  test('resolveRepoRoot returns the git toplevel for a checkout', () => {
    const root = resolveRepoRoot(process.cwd());
    // The worktree IS a git working tree, so resolution must succeed and the
    // CLI package must live under the resolved root.
    expect(root.length).toBeGreaterThan(0);
    expect(process.cwd().startsWith(root)).toBe(true);
  });

  test('resolvePort reads the machine-global port and bumps upward off a busy one', async () => {
    // Bind a free port WE control, then write it as `review_ui_port` into a tmp
    // `~/.claude-prove/config.json` (the machine-config base seam) so the scan
    // starts on a port that is genuinely busy and must bump up.
    const busy = await freePort();
    await startHealthServer(busy);
    const machineBase = mkdtempSync(join(tmpdir(), 'rui-serve-mcfg-'));
    writeFileSync(
      join(machineBase, 'config.json'),
      JSON.stringify({ default_contributors: {}, review_ui_port: busy }),
    );

    const { port, requested } = await resolvePort({ machineConfigBase: machineBase });
    expect(requested).toBe(busy);
    expect(port).toBeGreaterThan(busy);

    rmSync(machineBase, { recursive: true, force: true });
  });

  test('resolvePort falls back to the default port when the machine config is absent', async () => {
    const machineBase = mkdtempSync(join(tmpdir(), 'rui-serve-mcfg-empty-'));
    try {
      const { requested } = await resolvePort({ machineConfigBase: machineBase });
      expect(requested).toBe(DEFAULT_REVIEW_UI_PORT);
    } finally {
      rmSync(machineBase, { recursive: true, force: true });
    }
  });
});

describe('review-ui serve — start/health/stop integration (real detached child)', () => {
  test('the booted listener is bound to 127.0.0.1 only', async () => {
    const port = await freePort();

    const code = await runServe({
      verb: 'start',
      cwd: process.cwd(),
      baseOverride: baseDir,
      port,
      // API-only keeps the child independent of a built web/dist bundle.
      resolveWebRoot: async () => null,
      warn: () => {},
    });
    expect(code).toBe(0);

    // The real child must answer health on loopback.
    expect(await reachable(HOST, port)).toBe(true);

    // And must NOT be reachable on this host's non-loopback interface, proving
    // the loopback-only bind. Skipped when the host has no external interface.
    const external = nonLoopbackAddress();
    if (external) {
      expect(await reachable(external, port)).toBe(false);
    }

    expect(stop({ baseOverride: baseDir })).toBe(true);
  }, 20_000);
});
