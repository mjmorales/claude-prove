/**
 * Advisory cross-process file lock — O_EXCL lockfile with PID liveness.
 *
 * Serializes load→merge→write critical sections across concurrent CLI
 * processes (e.g. parallel `cafi save` batch agents writing one cache file).
 * `openSync(path, 'wx')` (O_CREAT|O_EXCL) is atomic on local filesystems and
 * survives the spawn boundary, unlike flock(2) advisory semantics.
 *
 * Staleness: a held lock is reclaimed only when BOTH its file mtime exceeds
 * `staleMs` AND its recorded PID is no longer alive (`process.kill(pid, 0)`).
 * A wall-clock-only timeout could steal the lock from a slow-but-live writer
 * mid-rewrite — the exact lost-update race the lock exists to prevent. A
 * lockfile with unparseable content falls back to age-only reclaim.
 */

import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

export interface FileLockOptions {
  /** Total wait for acquisition before throwing. Default: 30s. */
  timeoutMs?: number;
  /** Delay between acquisition attempts. Default: 50ms. */
  retryDelayMs?: number;
  /** Lockfile age before a dead-PID (or unreadable) lock may be reclaimed. Default: 30s. */
  staleMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_DELAY_MS = 50;
const DEFAULT_STALE_MS = 30_000;

export class FileLockTimeoutError extends Error {
  constructor(lockPath: string, timeoutMs: number) {
    super(`Timed out after ${timeoutMs}ms waiting for lock: ${lockPath}`);
    this.name = 'FileLockTimeoutError';
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user — alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Read the holder PID from a lockfile; null when missing or unparseable. */
function readLockPid(lockPath: string): number | null {
  try {
    const raw = readFileSync(lockPath, 'utf8');
    const pid = Number.parseInt(raw.split('\n')[0] ?? '', 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Reclaim the lock at `lockPath` if it is stale (old AND holder dead, or old
 * AND unreadable). Returns true when the lockfile was removed.
 */
function tryReclaimStale(lockPath: string, staleMs: number): boolean {
  let ageMs: number;
  try {
    ageMs = Date.now() - statSync(lockPath).mtimeMs;
  } catch {
    // Vanished between attempts — the next open('wx') will settle it.
    return true;
  }
  if (ageMs < staleMs) return false;

  const pid = readLockPid(lockPath);
  if (pid !== null && pidAlive(pid)) return false;

  try {
    rmSync(lockPath);
  } catch {
    // A racing waiter unlinked first; both proceed to re-attempt open('wx').
  }
  return true;
}

/** Attempt one atomic acquisition. Returns true when this process now holds the lock. */
function tryAcquire(lockPath: string): boolean {
  // First locker on a cold project creates the parent dir (e.g. `.prove/`).
  const parent = dirname(lockPath);
  if (parent && parent !== '.') {
    mkdirSync(parent, { recursive: true });
  }
  let fd: number;
  try {
    fd = openSync(lockPath, 'wx');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  try {
    writeSync(fd, `${process.pid}\n${new Date().toISOString()}\n`);
  } finally {
    closeSync(fd);
  }
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `fn` while holding the advisory lock at `lockPath`.
 *
 * The lock must wrap the caller's ENTIRE read-modify-write sequence — locking
 * only the write still loses updates when two processes both read before
 * either writes. Released in `finally`; throws `FileLockTimeoutError` when
 * acquisition exceeds `timeoutMs`.
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => T | Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;

  const deadline = Date.now() + timeoutMs;
  while (!tryAcquire(lockPath)) {
    if (tryReclaimStale(lockPath, staleMs)) continue;
    if (Date.now() >= deadline) throw new FileLockTimeoutError(lockPath, timeoutMs);
    await sleep(retryDelayMs);
  }

  try {
    return await fn();
  } finally {
    try {
      rmSync(lockPath);
    } catch {
      // Already gone (e.g. wrongly reclaimed) — nothing further to release.
    }
  }
}
