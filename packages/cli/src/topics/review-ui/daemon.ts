/**
 * Pidfile-managed lifecycle for the long-lived review-ui server process.
 *
 * State lives under `~/.claude-prove/review-ui/` — a subdir of the same
 * machine-global anchor the project registry and stable-root chain use:
 *
 *   review-ui.pid   the recorded server pid (one line, the integer)
 *   review-ui.log   the server's combined stdout/stderr (spawn target)
 *
 * Liveness is two-factor: a recorded pid is only RUNNING when the process
 * still exists (signal-0 probe) AND is actually listening on its port. A
 * pidfile whose pid is dead, or alive but not serving, is STALE and must be
 * reaped before a fresh start — never treated as a running server. This guards
 * against pid reuse (the OS handing the recorded number to an unrelated
 * process) and against a half-dead server that holds the pidfile but stopped
 * accepting connections.
 *
 * Base-dir resolution mirrors the project-registry seam exactly: an explicit
 * override param wins, then the `CLAUDE_PROVE_HOME` env var, else
 * `~/.claude-prove`. The override is the test seam — tests point it at a tmp
 * dir so they NEVER touch the developer's real `~/.claude-prove/`.
 *
 * The detached spawn is injected (`SpawnFn`) so unit tests drive the full
 * lifecycle — write the pidfile, poll health, reap stale, refuse a live
 * server — without ever forking a real process.
 *
 * Writes follow the codebase's atomic + non-clobber discipline: the dir is
 * created recursively, the pidfile is written to a sibling tmp file then
 * `rename(2)`d into place (a concurrent reader sees old-or-new, never a
 * partial), and a path occupied by a non-regular file (a dir or symlink the
 * user planted) is surfaced rather than silently clobbered.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { registryBaseDir } from '@claude-prove/store';

/** Subdir of the machine-global base dir holding the daemon's pid + log. */
export const REVIEW_UI_SUBDIR = 'review-ui';

/** Pidfile name under the review-ui subdir. */
export const PIDFILE_NAME = 'review-ui.pid';

/** Log file name under the review-ui subdir — the detached spawn's output sink. */
export const LOGFILE_NAME = 'review-ui.log';

/** Loopback host the server binds to; health probes target the same. */
const DEFAULT_HOST = '127.0.0.1';

/** Default review-ui port — matches the `review-ui config` port default. */
const DEFAULT_PORT = 5174;

/** Health-poll budget: total wait split into fixed-interval attempts. */
const HEALTH_POLL_TIMEOUT_MS = 10_000;
const HEALTH_POLL_INTERVAL_MS = 200;

/** Per-probe TCP connect timeout for the listening check. */
const LISTEN_PROBE_TIMEOUT_MS = 500;

/** Per-request timeout for the `/api/health` probe. */
const HEALTH_REQUEST_TIMEOUT_MS = 1000;

/** What `start` needs to launch the detached server and record it. */
export interface SpawnContext {
  /** Resolved review-ui subdir (the spawn's cwd / log location anchor). */
  dir: string;
  /** Absolute path the server's combined output should be appended to. */
  logFile: string;
  /** Host the server should bind / the health probe targets. */
  host: string;
  /** Port the server should bind / the health probe targets. */
  port: number;
}

/**
 * Launch the detached server and return its pid. The real implementation forks
 * a `detached` child writing to `logFile`; the injected test double returns a
 * synthetic pid without forking. Returning the pid (not a child handle) keeps
 * the lifecycle decoupled from the spawn mechanism.
 */
export type SpawnFn = (ctx: SpawnContext) => number | Promise<number>;

/** The resolved status of the recorded daemon. */
export interface DaemonStatus {
  /** True only when a recorded pid is both alive and listening + serving health. */
  running: boolean;
  /** The recorded pid, or null when no (valid) pidfile is present. */
  pid: number | null;
  /** The port the daemon is/was recorded against. */
  port: number;
}

/** Knobs shared by the lifecycle verbs; all default to the loopback server. */
export interface DaemonOptions {
  /** Base-dir override — the test seam. Real `~/.claude-prove/` when unset. */
  baseOverride?: string;
  /** Bind/probe host. Defaults to loopback. */
  host?: string;
  /** Bind/probe port. Defaults to the review-ui port. */
  port?: number;
}

/**
 * Ensure `~/.claude-prove/review-ui/` exists and return its absolute path.
 * Recursive mkdir is idempotent. Refuses to proceed when the path is occupied
 * by a non-directory (a file or symlink the user planted) — that is user data
 * we did not create; surface it rather than clobber it.
 */
export function ensureReviewUiDir(baseOverride?: string): string {
  const dir = join(registryBaseDir(baseOverride), REVIEW_UI_SUBDIR);
  try {
    const st = lstatSync(dir);
    if (!st.isDirectory()) {
      throw new Error(
        `ensureReviewUiDir: ${dir} exists and is not a directory — move it aside and re-run`,
      );
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Absolute path to the pidfile under the resolved review-ui dir. */
export function pidfilePath(baseOverride?: string): string {
  return join(registryBaseDir(baseOverride), REVIEW_UI_SUBDIR, PIDFILE_NAME);
}

/** Absolute path to the log file under the resolved review-ui dir. */
export function logfilePath(baseOverride?: string): string {
  return join(registryBaseDir(baseOverride), REVIEW_UI_SUBDIR, LOGFILE_NAME);
}

/**
 * Read the recorded pid. Returns null on an absent, empty, or malformed
 * pidfile — a non-integer body is treated as no pidfile (it cannot name a
 * process), so callers reap and re-create rather than trusting garbage.
 */
export function readPidfile(baseOverride?: string): number | null {
  const path = pidfilePath(baseOverride);
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const pid = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return pid;
}

/**
 * Write the pid atomically: the dir is ensured, the integer is written to a
 * sibling tmp file, then `rename(2)`d over the pidfile so a concurrent reader
 * never observes a partial line.
 */
export function writePidfile(pid: number, baseOverride?: string): void {
  ensureReviewUiDir(baseOverride);
  const path = pidfilePath(baseOverride);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${pid}\n`, 'utf8');
  renameSync(tmp, path);
}

/** Remove the pidfile. Idempotent — a no-op when it is already absent. */
export function removePidfile(baseOverride?: string): void {
  rmSync(pidfilePath(baseOverride), { force: true });
}

/**
 * Signal-0 liveness probe: `kill(pid, 0)` succeeds iff the process exists and
 * is signalable by us. `ESRCH` means dead; `EPERM` means alive but owned by
 * another user (still alive). Any other error is treated as dead.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * True when a TCP connection to `host:port` succeeds within the probe timeout.
 * A successful connect proves something is accepting on the port; the deeper
 * `/api/health` check confirms it is OUR server and not an unrelated listener.
 */
export function isListening(
  host: string,
  port: number,
  timeoutMs = LISTEN_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const socket = connect({ host, port });
    let settled = false;
    const finish = (alive: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveProbe(alive);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/**
 * Probe `GET http://host:port/api/health`; true on a 200. Distinguishes our
 * server from an arbitrary listener that merely holds the port. Any network
 * error, timeout, or non-200 is false.
 */
async function probeHealth(host: string, port: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`http://${host}:${port}/api/health`, {
      signal: controller.signal,
    });
    return res.status === 200;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve the recorded daemon's status. `running` is true only when a pid is
 * recorded, that pid is alive, and the port answers `/api/health` with 200 —
 * the full two-factor liveness check. A dead or non-serving pid reports
 * `running: false` (a stale pidfile), leaving the recorded pid visible for the
 * caller's reap decision.
 */
export async function status(opts: DaemonOptions = {}): Promise<DaemonStatus> {
  const host = opts.host ?? DEFAULT_HOST;
  const port = opts.port ?? DEFAULT_PORT;
  const pid = readPidfile(opts.baseOverride);
  if (pid === null) return { running: false, pid: null, port };
  if (!isPidAlive(pid)) return { running: false, pid, port };
  const healthy = await probeHealth(host, port);
  return { running: healthy, pid, port };
}

/**
 * Start the daemon. Refuses (throws) when a recorded pid is already alive and
 * serving health — never double-starts. Otherwise reaps any stale pidfile,
 * invokes the injected detached spawn, records the returned pid atomically,
 * then polls `/api/health` for a 200 within the bounded budget. On poll
 * timeout the (likely wedged) pid is left recorded and the error surfaces, so
 * the caller can inspect the log and `stop` to reap.
 *
 * Returns the live pid on success.
 */
export async function start(spawnFn: SpawnFn, opts: DaemonOptions = {}): Promise<number> {
  const host = opts.host ?? DEFAULT_HOST;
  const port = opts.port ?? DEFAULT_PORT;
  const dir = ensureReviewUiDir(opts.baseOverride);

  const recorded = readPidfile(opts.baseOverride);
  if (recorded !== null && isPidAlive(recorded) && (await probeHealth(host, port))) {
    throw new Error(`review-ui already running (pid ${recorded}, port ${port})`);
  }

  // Anything else — dead pid, alive-but-not-serving, or no pidfile — is stale.
  // Reap before spawning so the fresh pid is the only recorded one.
  removePidfile(opts.baseOverride);

  const pid = await spawnFn({ dir, logFile: logfilePath(opts.baseOverride), host, port });
  writePidfile(pid, opts.baseOverride);

  await pollHealth(host, port);
  return pid;
}

/** Poll `/api/health` until a 200 or the timeout, throwing on timeout. */
async function pollHealth(host: string, port: number): Promise<void> {
  const deadline = Date.now() + HEALTH_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await probeHealth(host, port)) return;
    await delay(HEALTH_POLL_INTERVAL_MS);
  }
  throw new Error(
    `review-ui health check did not pass within ${HEALTH_POLL_TIMEOUT_MS}ms (port ${port})`,
  );
}

/**
 * Stop the daemon: SIGTERM the recorded pid (when one is alive) and remove the
 * pidfile. A no-op when nothing is recorded. The pidfile is removed
 * unconditionally once we have signalled, so a dead-but-recorded pid is also
 * reaped. Returns true when a live process was signalled.
 */
export function stop(opts: DaemonOptions = {}): boolean {
  const pid = readPidfile(opts.baseOverride);
  if (pid === null) return false;

  let signalled = false;
  if (isPidAlive(pid)) {
    try {
      process.kill(pid, 'SIGTERM');
      signalled = true;
    } catch {
      // The process died between the liveness probe and the signal — treat as
      // already-stopped and fall through to pidfile removal.
    }
  }
  removePidfile(opts.baseOverride);
  return signalled;
}

/** Stop then start — the full restart cycle, reusing the same options. */
export async function restart(spawnFn: SpawnFn, opts: DaemonOptions = {}): Promise<number> {
  stop(opts);
  return start(spawnFn, opts);
}

/** Promise-based sleep for the bounded health-poll backoff. */
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
