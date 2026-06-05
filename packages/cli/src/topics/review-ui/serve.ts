/**
 * `claude-prove review-ui serve <start|stop|status|restart>` — drive the
 * long-lived loopback review-ui server through the pidfile daemon lifecycle.
 *
 * The parent CLI process owns all resolution the detached child cannot do for
 * itself, because the child does NOT inherit the Claude Code session's
 * `.claude/settings.local.json` env (where `CLAUDE_PROVE_PLUGIN_DIR` lives):
 *
 *   - repoRoot : `git rev-parse --show-toplevel` from cwd, else cwd itself.
 *   - port     : the machine-global `review_ui_port` (from
 *                `~/.claude-prove/config.json`), then an upward scan past any
 *                busy port (warning when the requested one is taken).
 *   - webRoot  : resolved HERE via the server's `resolveWebRoot()` three-tier
 *                lookup (which reads `CLAUDE_PROVE_PLUGIN_DIR`), then threaded
 *                to the child as a concrete path. A null resolution warns and
 *                boots the child API-only.
 *
 * These three values are handed to the detached child through env vars the
 * parent sets explicitly — never ambient inheritance. The child binds
 * 127.0.0.1 only and writes combined output to the daemon dir's review-ui.log.
 *
 * The server package depends on `@claude-prove/cli`, so the CLI reaches its
 * `resolveWebRoot()` through a runtime dynamic `import()` off the plugin root —
 * a static import would be a build cycle.
 */

import { type SpawnOptions, spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { openSync } from 'node:fs';
import { connect } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runningFromCompiledBinary } from '@claude-prove/installer';
import type { DaemonOptions, DaemonStatus, SpawnContext, SpawnFn } from './daemon';
import * as daemon from './daemon';
import { resolveReviewUiPort } from './port-config';
import {
  CHILD_PORT_ENV,
  CHILD_REPO_ROOT_ENV,
  CHILD_WEB_ROOT_ENV,
  loadServerModule,
} from './serve-child';

/** The four lifecycle verbs `review-ui serve` accepts. */
export const SERVE_VERBS = ['start', 'stop', 'status', 'restart'] as const;
export type ServeVerb = (typeof SERVE_VERBS)[number];

/**
 * Hidden re-invocation token. In compiled mode the parent re-execs its own
 * binary as `review-ui serve __child` so the bundled server entry boots without
 * a separate bun/tsx on PATH; the topic dispatch routes this token into the
 * child body rather than the verb table.
 */
export const SERVE_CHILD_TOKEN = '__child';

/** Loopback host the server binds and the daemon health-probes. */
const HOST = '127.0.0.1';

/** How far the upward busy-port scan walks before giving up. */
const PORT_SCAN_SPAN = 20;

/** Per-probe connect timeout for the busy-port check. */
const PORT_PROBE_TIMEOUT_MS = 300;

export interface RunServeOptions {
  /** Lifecycle verb (an unknown value is rejected by the dispatcher). */
  verb: string;
  /** Repo root to resolve from / spawn the child in. Defaults to cwd. */
  cwd?: string;
  /** Base-dir override for the daemon pidfile/log — the test seam. */
  baseOverride?: string;
  /**
   * Machine-config base-dir override (the `~/.claude-prove` root) for port
   * resolution — the test seam. Unset reads the developer's real config.
   */
  machineConfigBase?: string;
  /**
   * Pin the listen port, bypassing config + busy-scan. Tests use this to drive
   * a deterministic port; unset selects the machine-global port then scans upward.
   */
  port?: number;
  /** Injected spawn for tests; defaults to the real detached spawn. */
  spawnFn?: SpawnFn;
  /** Injected web-root resolver for tests; defaults to the server's. */
  resolveWebRoot?: () => Promise<string | null>;
  /** Health-poll budget override (ms); tests drive a sub-second timeout. */
  pollTimeoutMs?: number;
  /** Health-poll interval override (ms). */
  pollIntervalMs?: number;
  /** Sink for warnings; defaults to stderr. Stdout stays the parseable channel. */
  warn?: (message: string) => void;
}

/** Dispatch a `serve` verb. Returns the process exit code. */
export async function runServe(opts: RunServeOptions): Promise<number> {
  if (!isServeVerb(opts.verb)) {
    process.stderr.write(
      `claude-prove review-ui serve: unknown sub-action '${opts.verb}'. expected one of: ${SERVE_VERBS.join(
        ', ',
      )}\n`,
    );
    return 1;
  }

  const cwd = opts.cwd ?? process.cwd();
  const warn = opts.warn ?? ((m: string) => process.stderr.write(`${m}\n`));

  switch (opts.verb) {
    case 'status':
      return runStatus(opts);
    case 'stop':
      return runStop(opts.baseOverride);
    case 'start':
      return runStart(cwd, opts, warn);
    case 'restart':
      return runRestart(cwd, opts, warn);
  }
}

function isServeVerb(value: string): value is ServeVerb {
  return (SERVE_VERBS as readonly string[]).includes(value);
}

/** `status` prints `{ running, pid, port }` as a JSON line on stdout. */
async function runStatus(opts: RunServeOptions): Promise<number> {
  const port = opts.port ?? (await resolvePort(opts)).port;
  const st: DaemonStatus = await daemon.status({
    baseOverride: opts.baseOverride,
    host: HOST,
    port,
  });
  process.stdout.write(`${JSON.stringify(st)}\n`);
  return 0;
}

/** `stop` SIGTERMs and reaps; reports the outcome on stderr. */
function runStop(baseOverride?: string): number {
  const signalled = daemon.stop({ baseOverride });
  process.stderr.write(signalled ? 'stopped review-ui\n' : 'review-ui was not running\n');
  return 0;
}

async function runStart(
  cwd: string,
  opts: RunServeOptions,
  warn: (m: string) => void,
): Promise<number> {
  const { repoRoot, port, webRoot } = await resolveStartInputs(cwd, opts, warn);
  const spawnFn = opts.spawnFn ?? makeDetachedSpawn(cwd, repoRoot, webRoot);
  try {
    const pid = await daemon.start(spawnFn, daemonOpts(opts, port));
    process.stdout.write(`${JSON.stringify({ running: true, pid, port })}\n`);
    return 0;
  } catch (err) {
    warn(`review-ui serve: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

async function runRestart(
  cwd: string,
  opts: RunServeOptions,
  warn: (m: string) => void,
): Promise<number> {
  const { repoRoot, port, webRoot } = await resolveStartInputs(cwd, opts, warn);
  const spawnFn = opts.spawnFn ?? makeDetachedSpawn(cwd, repoRoot, webRoot);
  try {
    const pid = await daemon.restart(spawnFn, daemonOpts(opts, port));
    process.stdout.write(`${JSON.stringify({ running: true, pid, port })}\n`);
    return 0;
  } catch (err) {
    warn(`review-ui serve: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

/** Project the serve options onto the daemon lifecycle options. */
function daemonOpts(opts: RunServeOptions, port: number): DaemonOptions {
  return {
    baseOverride: opts.baseOverride,
    host: HOST,
    port,
    pollTimeoutMs: opts.pollTimeoutMs,
    pollIntervalMs: opts.pollIntervalMs,
  };
}

interface StartInputs {
  repoRoot: string;
  port: number;
  webRoot: string | null;
}

/**
 * Resolve the three inputs the parent must thread to the child. Pure aside from
 * the optional injected web-root resolver, so the start/restart tests can drive
 * it deterministically.
 */
async function resolveStartInputs(
  cwd: string,
  opts: RunServeOptions,
  warn: (m: string) => void,
): Promise<StartInputs> {
  const repoRoot = resolveRepoRoot(cwd);

  // A pinned port skips the machine-config lookup + busy-scan entirely.
  const port = opts.port ?? (await selectPort(opts, warn));

  const resolveWeb = opts.resolveWebRoot ?? defaultResolveWebRoot;
  const webRoot = await resolveWeb();
  if (webRoot === null) {
    warn(
      'review-ui serve: web bundle not found — booting API-only (set WEB_ROOT or build web/dist)',
    );
  }

  return { repoRoot, port, webRoot };
}

/** Machine-global port then upward busy-scan; warns when the requested port is bumped. */
async function selectPort(opts: RunServeOptions, warn: (m: string) => void): Promise<number> {
  const { port, requested } = await resolvePort(opts);
  if (port !== requested) {
    warn(`review-ui serve: port ${requested} is busy, using ${port}`);
  }
  return port;
}

/** `git rev-parse --show-toplevel` from cwd; cwd itself when not a repo. */
export function resolveRepoRoot(cwd: string): string {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
    });
    return out.trim();
  } catch {
    return cwd;
  }
}

/**
 * Resolve the listen port: the machine-global `review_ui_port` (from
 * `~/.claude-prove/config.json`), then scan upward past any busy port. Reports
 * both the chosen and the originally requested port so the caller can warn on a
 * bump. A busy port is one a loopback TCP connect succeeds against — something
 * already listens there. The review UI is one per-machine daemon serving every
 * registered project, so its port is a machine-global setting, not per-project.
 */
export async function resolvePort(
  opts: { machineConfigBase?: string } = {},
): Promise<{ port: number; requested: number }> {
  const requested = resolveReviewUiPort({ baseOverride: opts.machineConfigBase });
  for (let candidate = requested; candidate < requested + PORT_SCAN_SPAN; candidate += 1) {
    if (!(await isPortBusy(candidate))) return { port: candidate, requested };
  }
  // Every candidate was busy; hand back the requested one and let the daemon's
  // health poll surface the bind failure rather than silently picking nothing.
  return { port: requested, requested };
}

/** True when a loopback TCP connect to `port` succeeds — something listens. */
function isPortBusy(port: number): Promise<boolean> {
  return new Promise((resolveBusy) => {
    const socket = connect({ host: HOST, port });
    let settled = false;
    const finish = (busy: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveBusy(busy);
    };
    socket.setTimeout(PORT_PROBE_TIMEOUT_MS);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/** Resolve the server's `resolveWebRoot()` through the shared module loader. */
async function defaultResolveWebRoot(): Promise<string | null> {
  const mod = await loadServerModule();
  return mod.resolveWebRoot();
}

/**
 * Build the real detached spawn. Dev mode runs the child TypeScript entry under
 * bun; compiled mode re-execs the running binary with the hidden child token so
 * the bundled server boots without a bun/tsx on PATH. Either way the resolved
 * repoRoot/port/webRoot ride explicit env vars — never ambient inheritance —
 * and combined output appends to the daemon dir's review-ui.log.
 */
function makeDetachedSpawn(cwd: string, repoRoot: string, webRoot: string | null): SpawnFn {
  return (ctx: SpawnContext): number => {
    const logFd = openSync(ctx.logFile, 'a');
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      [CHILD_REPO_ROOT_ENV]: repoRoot,
      [CHILD_PORT_ENV]: String(ctx.port),
      // Empty string is the explicit API-only signal (distinct from "unset").
      [CHILD_WEB_ROOT_ENV]: webRoot ?? '',
    };
    const spawnOpts: SpawnOptions = {
      cwd,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: childEnv,
    };

    const [command, args] = childCommand();
    const child = spawn(command, args, spawnOpts);
    child.unref();
    if (child.pid === undefined) {
      throw new Error('review-ui serve: detached spawn produced no pid');
    }
    return child.pid;
  };
}

/**
 * Argv for the detached child, chosen by how THIS process was launched.
 *
 * Compiled: re-exec the running binary with the hidden child token so the
 * bundled server boots without a bun/tsx on PATH. Dev: run the sibling
 * `serve-child.ts` under bun, resolved relative to THIS module so the child
 * always comes from the same checkout as the parent CLI.
 */
function childCommand(): [string, string[]] {
  if (runningFromCompiledBinary()) {
    return [process.execPath, ['review-ui', 'serve', SERVE_CHILD_TOKEN]];
  }
  const here = fileURLToPath(import.meta.url);
  const entry = join(resolve(here, '..'), 'serve-child.ts');
  return ['bun', [entry]];
}
