/**
 * Tests for the review-ui daemon lifecycle.
 *
 * Each test drives the lifecycle against a tmp base dir (the `baseOverride`
 * seam) so the developer's real `~/.claude-prove/review-ui/` is never touched,
 * and against a real loopback HTTP server bound to an ephemeral port. The
 * server exposes `/api/health` so the genuine TCP + health probes run end to
 * end; the detached spawn is replaced by an injected `SpawnFn` returning a
 * controlled pid, so no real child process is ever forked.
 *
 * Liveness of a recorded pid is simulated two ways:
 *   - ALIVE  : record `process.pid` (the test runner itself — always alive).
 *   - DEAD   : record a pid that cannot exist (a freshly-spawned-then-reaped
 *              short-lived process whose pid is no longer in use).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureReviewUiDir,
  isListening,
  isPidAlive,
  pidfilePath,
  readPidfile,
  removePidfile,
  restart,
  start,
  status,
  stop,
  writePidfile,
} from './daemon';

const HOST = '127.0.0.1';

let baseDir: string;
let server: Server | null;
let port: number;

/** Start a loopback HTTP server answering `/api/health` 200, others 404. */
function startHealthServer(): Promise<number> {
  return new Promise((resolveServer) => {
    server = createServer((req, res) => {
      if (req.url === '/api/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"status":"ok"}');
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, HOST, () => {
      const addr = server?.address();
      port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      resolveServer(port);
    });
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

/**
 * A pid guaranteed dead: spawn a trivial process, wait for it to exit, and
 * return its pid. The OS will not have reassigned it within the test window.
 */
async function deadPid(): Promise<number> {
  const proc = Bun.spawn(['true']);
  await proc.exited;
  return proc.pid;
}

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'rui-daemon-base-'));
  server = null;
});

afterEach(async () => {
  await stopHealthServer();
  try {
    rmSync(baseDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('review-ui daemon — dir + pidfile primitives', () => {
  test('ensureReviewUiDir creates ~/.claude-prove/review-ui under the base', () => {
    const dir = ensureReviewUiDir(baseDir);
    expect(dir).toBe(join(baseDir, 'review-ui'));
    // Idempotent: a second call neither throws nor changes the path.
    expect(ensureReviewUiDir(baseDir)).toBe(dir);
  });

  test('writePidfile then readPidfile round-trips the pid; remove clears it', () => {
    writePidfile(4242, baseDir);
    expect(readFileSync(pidfilePath(baseDir), 'utf8').trim()).toBe('4242');
    expect(readPidfile(baseDir)).toBe(4242);
    removePidfile(baseDir);
    expect(readPidfile(baseDir)).toBeNull();
  });

  test('readPidfile returns null on absent and on malformed bodies', () => {
    expect(readPidfile(baseDir)).toBeNull();
    ensureReviewUiDir(baseDir);
    Bun.write(pidfilePath(baseDir), 'not-a-pid\n');
    expect(readPidfile(baseDir)).toBeNull();
  });

  test('removePidfile is a no-op when nothing is recorded', () => {
    expect(() => removePidfile(baseDir)).not.toThrow();
  });
});

describe('review-ui daemon — liveness probes', () => {
  test('isPidAlive is true for this process and false for a reaped pid', async () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(await deadPid())).toBe(false);
  });

  test('isListening true on a bound port, false on a closed one', async () => {
    const p = await startHealthServer();
    expect(await isListening(HOST, p)).toBe(true);
    await stopHealthServer();
    expect(await isListening(HOST, p)).toBe(false);
  });
});

describe('review-ui daemon — start', () => {
  test('fresh start writes the pidfile and waits for health', async () => {
    const p = await startHealthServer();
    let spawnCalls = 0;
    const spawnFn = () => {
      spawnCalls += 1;
      return process.pid; // a live pid the lifecycle records
    };

    const pid = await start(spawnFn, { baseOverride: baseDir, host: HOST, port: p });
    expect(spawnCalls).toBe(1);
    expect(pid).toBe(process.pid);
    expect(readPidfile(baseDir)).toBe(process.pid);

    const st = await status({ baseOverride: baseDir, host: HOST, port: p });
    expect(st).toEqual({ running: true, pid: process.pid, port: p });
  });

  test('stale pidfile (dead process) is reaped before a fresh start', async () => {
    const p = await startHealthServer();
    const stale = await deadPid();
    writePidfile(stale, baseDir);
    expect(isPidAlive(stale)).toBe(false);

    const spawnFn = () => process.pid;
    const pid = await start(spawnFn, { baseOverride: baseDir, host: HOST, port: p });
    // The stale pid was replaced by the freshly-spawned one.
    expect(pid).toBe(process.pid);
    expect(readPidfile(baseDir)).toBe(process.pid);
  });

  test('a live, listening, healthy pid refuses re-start', async () => {
    const p = await startHealthServer();
    // Seed a running daemon: live pid + serving health server already up.
    writePidfile(process.pid, baseDir);

    let spawnCalls = 0;
    const spawnFn = () => {
      spawnCalls += 1;
      return process.pid;
    };
    await expect(start(spawnFn, { baseOverride: baseDir, host: HOST, port: p })).rejects.toThrow(
      /already running/,
    );
    expect(spawnCalls).toBe(0);
    // Pidfile is untouched — the existing daemon keeps its record.
    expect(readPidfile(baseDir)).toBe(process.pid);
  });

  test('start times out and surfaces when health never passes', async () => {
    // Bind then immediately close so the port is reliably dead: every health
    // probe fails and the bounded poll exhausts its (injected sub-second)
    // budget, then rejects.
    const p = await startHealthServer();
    await stopHealthServer();

    const spawnFn = () => process.pid;
    await expect(
      start(spawnFn, {
        baseOverride: baseDir,
        host: HOST,
        port: p,
        pollTimeoutMs: 300,
        pollIntervalMs: 50,
      }),
    ).rejects.toThrow(/health check did not pass within 300ms/);
  });
});

describe('review-ui daemon — stop + status + restart', () => {
  test('stop SIGTERMs a live recorded pid and removes the pidfile', async () => {
    // Spawn a real, long-lived child we can legitimately SIGTERM.
    const child = Bun.spawn(['sleep', '30']);
    writePidfile(child.pid, baseDir);
    expect(isPidAlive(child.pid)).toBe(true);

    const signalled = stop({ baseOverride: baseDir });
    expect(signalled).toBe(true);
    expect(readPidfile(baseDir)).toBeNull();
    await child.exited; // SIGTERM delivered → child exits
    expect(isPidAlive(child.pid)).toBe(false);
  });

  test('stop is a no-op when nothing is recorded', () => {
    expect(stop({ baseOverride: baseDir })).toBe(false);
    expect(readPidfile(baseDir)).toBeNull();
  });

  test('stop reaps a dead recorded pid without signalling', async () => {
    const stale = await deadPid();
    writePidfile(stale, baseDir);
    expect(stop({ baseOverride: baseDir })).toBe(false);
    expect(readPidfile(baseDir)).toBeNull();
  });

  test('status reflects stopped when no pidfile and running when healthy', async () => {
    const p = await startHealthServer();
    expect(await status({ baseOverride: baseDir, host: HOST, port: p })).toEqual({
      running: false,
      pid: null,
      port: p,
    });

    writePidfile(process.pid, baseDir);
    expect(await status({ baseOverride: baseDir, host: HOST, port: p })).toEqual({
      running: true,
      pid: process.pid,
      port: p,
    });
  });

  test('status reports not-running for a dead recorded pid', async () => {
    const p = await startHealthServer();
    const stale = await deadPid();
    writePidfile(stale, baseDir);
    const st = await status({ baseOverride: baseDir, host: HOST, port: p });
    expect(st.running).toBe(false);
    expect(st.pid).toBe(stale);
  });

  test('restart cycles: stops the old record then starts fresh', async () => {
    const p = await startHealthServer();
    const stale = await deadPid();
    writePidfile(stale, baseDir);

    let spawnCalls = 0;
    const spawnFn = () => {
      spawnCalls += 1;
      return process.pid;
    };
    const pid = await restart(spawnFn, { baseOverride: baseDir, host: HOST, port: p });
    expect(spawnCalls).toBe(1);
    expect(pid).toBe(process.pid);
    expect(readPidfile(baseDir)).toBe(process.pid);
  });
});
