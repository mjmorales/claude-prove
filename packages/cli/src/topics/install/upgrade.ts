/**
 * `prove install upgrade` — download the latest prove binary from GitHub
 * Releases for the current platform and atomically swap it in place.
 *
 *   prove install upgrade [--prefix <dir>]
 *
 * Dev mode (checkout with `packages/cli/src/`) exits 1 with a pointer to
 * `git pull`; compiled installs fetch
 * `${PROVE_RELEASE_URL_BASE}/prove-<target>` (env override; default is the
 * canonical GitHub Releases CDN URL), write to a sibling tmp file, chmod
 * +x, and `rename(2)` onto the destination so a concurrent `prove` caller
 * never observes a partial file.
 *
 * Platform targets (`<platform>-<arch>`) mirror the eventual bash
 * bootstrap (phase 10 task 8): darwin-arm64, darwin-x64, linux-arm64,
 * linux-x64. Anything else errors out rather than silently guessing.
 *
 * NOTE: this file does not register its own cac command -- it exports
 * `runUpgrade` and is dispatched from `topics/install/index.ts` alongside
 * sibling actions (init / init-hooks / init-config from task 4, doctor
 * from task 5). That keeps the install dispatch logic in one place after
 * the parallel merges.
 */

import { chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { detectMode, resolvePluginRoot } from '@claude-prove/installer';

const DEFAULT_RELEASE_URL_BASE =
  'https://github.com/mjmorales/claude-prove/releases/latest/download';
const DEFAULT_PREFIX_REL = join('.local', 'bin');
const BINARY_NAME = 'prove';

const DEV_MODE_MESSAGE = 'upgrade is a compiled-mode command; use git pull in dev checkouts';

export interface UpgradeFlags {
  prefix?: string;
}

export async function runUpgrade(flags: UpgradeFlags): Promise<number> {
  const mode = detectMode(resolvePluginRoot());
  if (mode === 'dev') {
    process.stderr.write(`${DEV_MODE_MESSAGE}\n`);
    return 1;
  }

  let target: string;
  try {
    target = resolveTarget();
  } catch (err) {
    process.stderr.write(`${errMessage(err)}\n`);
    return 1;
  }

  const base = process.env.PROVE_RELEASE_URL_BASE ?? DEFAULT_RELEASE_URL_BASE;
  const url = `${base}/${BINARY_NAME}-${target}`;
  const prefix = flags.prefix ?? join(homedir(), DEFAULT_PREFIX_REL);
  const destPath = join(prefix, BINARY_NAME);
  const tmpPath = `${destPath}.tmp.${process.pid}`;

  let bytes: ArrayBuffer;
  try {
    bytes = await fetchBinary(url);
  } catch (err) {
    process.stderr.write(`${errMessage(err)}\n`);
    return 1;
  }

  try {
    mkdirSync(prefix, { recursive: true });
    writeFileSync(tmpPath, new Uint8Array(bytes));
    chmodSync(tmpPath, 0o755);
    renameSync(tmpPath, destPath);
  } catch (err) {
    tryUnlink(tmpPath);
    process.stderr.write(`${errMessage(err)}\n`);
    return 1;
  }

  process.stdout.write(`upgraded to ${destPath} (${bytes.byteLength} bytes)\n`);
  return 0;
}

/**
 * Map (platform, arch) to the release asset suffix. Must stay in lockstep
 * with the bash bootstrap in phase 10 task 8 — both consumers pull the
 * same `prove-<target>` assets.
 */
export function resolveTarget(): string {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64';
  if (platform === 'darwin' && arch === 'x64') return 'darwin-x64';
  if (platform === 'linux' && arch === 'arm64') return 'linux-arm64';
  if (platform === 'linux' && arch === 'x64') return 'linux-x64';
  throw new Error(`unsupported platform: ${platform}-${arch}`);
}

async function fetchBinary(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`fetch failed: ${res.status} ${res.statusText} (${url})`);
  }
  const bytes = await res.arrayBuffer();
  if (bytes.byteLength === 0) {
    throw new Error(`empty binary at ${url}`);
  }
  return bytes;
}

function tryUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // best-effort cleanup — the partial tmp file may not exist
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
