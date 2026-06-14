/**
 * `claude-prove install upgrade` — download a claude-prove release binary for
 * the current platform and atomically swap it in place.
 *
 *   claude-prove install upgrade [--prefix <dir>] [--tag <vX.Y.Z>]
 *
 * With no `--tag`, fetches the newest release (`/releases/latest/download`).
 * With `--tag v4.0.1` (a leading `v` is optional), pins the download to that
 * release (`/releases/download/<tag>`) — the in-tool path to install a
 * specific known-good version instead of only `latest`, e.g. to step back off
 * a release that regressed. (A binary that is already broken cannot run this
 * command at all — it fails before argument parsing — so a full recovery from
 * a non-running binary still goes through `install.sh` or a manual download;
 * `--tag` covers pinning from a working binary.)
 *
 * The dev/compiled gate is PROVENANCE-based — how this process was launched
 * (`runningFromCompiledBinary`), not what `resolvePluginRoot()` points at.
 * Dev machines export `CLAUDE_PROVE_PLUGIN_DIR` toward their checkout, which
 * would make a plugin-root-based check classify even the installed binary at
 * ~/.local/bin as 'dev' and refuse. A `bun run` source invocation exits 1
 * with a pointer to `git pull`; the compiled binary fetches the asset from
 * the GitHub Releases root (`PROVE_RELEASE_URL_BASE` overrides the root for
 * tests; default is the canonical GitHub Releases URL), writes to a sibling
 * tmp file, chmods +x, and `rename(2)`s onto the destination so a concurrent
 * `claude-prove` caller never observes a partial file.
 *
 * `PROVE_FORCE_MODE=dev|compiled` overrides provenance detection — the
 * test-suite escape hatch (tests always run via `bun run`).
 *
 * Platform targets (`<platform>-<arch>`): darwin-arm64, linux-arm64,
 * linux-x64. Intel mac (darwin-x64) is rejected (no published asset);
 * anything else errors out rather than silently guessing.
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
import { runningFromCompiledBinary } from '@claude-prove/installer';

// The GitHub Releases ROOT (no trailing path). The asset URL is built off it:
// `/latest/download/<asset>` for the newest release, `/download/<tag>/<asset>`
// for a pinned `--tag`. PROVE_RELEASE_URL_BASE overrides this root in tests.
const DEFAULT_RELEASES_ROOT = 'https://github.com/mjmorales/claude-prove/releases';
const DEFAULT_PREFIX_REL = join('.local', 'bin');
// Binary was renamed from `prove` → `claude-prove` in v2.0.0 (commit ace69a6)
// to avoid collision with /usr/bin/prove (Perl TAP test runner). Release
// assets, install.sh, and the CI matrix all emit `claude-prove-<target>`.
const BINARY_NAME = 'claude-prove';

const DEV_MODE_MESSAGE = 'upgrade is a compiled-mode command; use git pull in dev checkouts';

export interface UpgradeFlags {
  prefix?: string;
  /** Pin the download to a specific release tag (e.g. `v4.0.1`). Default: latest. */
  tag?: string;
}

export async function runUpgrade(flags: UpgradeFlags): Promise<number> {
  // Provenance gate: only the compiled binary may replace itself. See the
  // header comment for why this must not consult resolvePluginRoot().
  const force = process.env.PROVE_FORCE_MODE;
  const compiled = force !== undefined ? force === 'compiled' : runningFromCompiledBinary();
  if (!compiled) {
    process.stderr.write(`${DEV_MODE_MESSAGE}\n`);
    return 1;
  }

  let target: string;
  let tag: string | undefined;
  try {
    target = resolveTarget();
    tag = flags.tag !== undefined ? normalizeTag(flags.tag) : undefined;
  } catch (err) {
    process.stderr.write(`${errMessage(err)}\n`);
    return 1;
  }

  const root = process.env.PROVE_RELEASE_URL_BASE ?? DEFAULT_RELEASES_ROOT;
  const url = buildReleaseUrl(root, target, tag);
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

  process.stdout.write(
    `upgraded to ${destPath} from ${tag ?? 'latest'} (${bytes.byteLength} bytes)\n`,
  );
  return 0;
}

/**
 * Build the GitHub Releases asset URL off the releases `root`. GitHub serves
 * the newest release at `/latest/download/<asset>` and a pinned release at
 * `/download/<tag>/<asset>`.
 */
export function buildReleaseUrl(root: string, target: string, tag: string | undefined): string {
  const asset = `${BINARY_NAME}-${target}`;
  return tag ? `${root}/download/${tag}/${asset}` : `${root}/latest/download/${asset}`;
}

// Release tags are `vMAJOR.MINOR.PATCH`, optionally with a prerelease suffix
// (e.g. `v4.0.0-pre.1`). Accept a bare or v-prefixed semver and normalize to
// the v-prefixed tag GitHub uses. A strict pattern also keeps a stray value
// from being spliced into the download path.
const TAG_PATTERN = /^v?\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;

/** Validate and v-prefix a `--tag` value, throwing on anything non-semver. */
export function normalizeTag(raw: string): string {
  const trimmed = raw.trim();
  if (!TAG_PATTERN.test(trimmed)) {
    throw new Error(`invalid --tag '${raw}': expected a release version like v4.0.1 or 4.0.1`);
  }
  return trimmed.startsWith('v') ? trimmed : `v${trimmed}`;
}

/**
 * Map (platform, arch) to the release asset suffix. Must stay in lockstep
 * with `scripts/install.sh` — both consumers pull the same
 * `claude-prove-<target>` assets from GitHub Releases.
 */
export function resolveTarget(): string {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64';
  if (platform === 'linux' && arch === 'arm64') return 'linux-arm64';
  if (platform === 'linux' && arch === 'x64') return 'linux-x64';
  // Intel mac is unsupported: the store's @tursodatabase NAPI engine ships no
  // Intel-mac binding, so no darwin-x64 release asset is published. Fail with a
  // clear message rather than 404 on a fetch for an asset that does not exist.
  if (platform === 'darwin' && arch === 'x64') {
    throw new Error(
      'Intel mac (darwin-x64) is not supported: the store backend publishes no Intel-mac native binding, so no claude-prove-darwin-x64 release exists. Apple Silicon and Linux (x64/arm64) are supported.',
    );
  }
  throw new Error(`unsupported platform: ${platform}-${arch}`);
}

async function fetchBinary(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`fetch failed: ${res.status} ${res.statusText} (${url})`);
  }
  // Guard against CDN/proxy returning an HTML error page with 200 OK.
  // Peek at the first 256 bytes to detect an HTML body regardless of the
  // content-type header value (proxies sometimes serve text/plain for errors).
  const bytes = await res.arrayBuffer();
  const head = new TextDecoder().decode(bytes.slice(0, 256));
  const contentType = res.headers.get('content-type') ?? '';
  if (looksLikeHtmlError(contentType, head)) {
    throw new Error(`unexpected HTML response from release URL: ${contentType}`);
  }
  if (bytes.byteLength === 0) {
    throw new Error(`empty binary at ${url}`);
  }
  return bytes;
}

/**
 * Denylist for HTML error pages served with 200 OK by CDNs or auth proxies.
 * Accepts any content-type except known HTML/XHTML types, and additionally
 * rejects a body that opens with an HTML doctype regardless of header — the
 * combination catches both correctly-labeled and mislabeled error pages.
 * A denylist is used (rather than an allowlist) so that a CDN content-type
 * change from `application/octet-stream` to another binary-ish type does not
 * silently break every upgrade.
 */
function looksLikeHtmlError(contentType: string, bodyHead: string): boolean {
  const ct = contentType.toLowerCase();
  if (ct.startsWith('text/html') || ct.startsWith('application/xhtml+xml')) return true;
  const trimmed = bodyHead.trimStart().toLowerCase();
  return trimmed.startsWith('<!doctype html') || trimmed.startsWith('<html');
}

function tryUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    // Best-effort cleanup — the partial tmp file may not exist.
    // Log at warn level so failures are visible without changing control flow.
    console.warn('claude-prove upgrade: failed to unlink tmp binary:', err);
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
