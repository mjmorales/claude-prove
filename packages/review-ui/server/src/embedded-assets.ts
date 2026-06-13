/**
 * Materialize the web bundle embedded in the compiled `claude-prove` binary to
 * an on-disk cache dir, returning a real directory the Fastify static handler
 * can serve.
 *
 * Why a cache dir and not the embedded path directly: `bun build --compile`
 * embeds files into a per-file virtual filesystem (`/$bunfs/...`) that flattens
 * directory structure and content-hashes every basename — it has no `readdir`
 * or relative-path semantics. `@fastify/static` needs a real directory root with
 * the original `index.html` + `assets/...` layout intact. So the build embeds the
 * whole `web/dist` tree as a SINGLE tar (`web-dist.tar`), and on first boot we
 * extract that tar — which preserves the relative layout — into
 * `~/.claude-prove/review-ui/web-cache/<content-hash>/` and serve from there.
 *
 * The content hash keys the cache so a new binary (new bundle) extracts to a
 * fresh dir and the prior one stays untouched; a re-extracted identical bundle
 * is a no-op once the marker file is present.
 *
 * When NOT running from a compiled binary (`bun run`/`tsx` from source, the
 * Docker image, or a plugin install), `Bun.embeddedFiles` is empty — the reader
 * returns null and `resolveWebRoot` falls through to the plugin-dir / WEB_ROOT
 * tiers exactly as before.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runningFromCompiledBinary } from '@claude-prove/installer';
import { registryBaseDir } from '@claude-prove/store';

/** Subdir of the machine-global base dir holding extracted web bundles. */
const WEB_CACHE_SUBDIR = join('review-ui', 'web-cache');

/** Basename suffix the build gives the embedded bundle tarball. */
const BUNDLE_TAR_SUFFIX = '.tar';

/** Marker written after a successful extraction so re-boots skip the work. */
const EXTRACT_MARKER = '.extracted';

/**
 * Virtual-filesystem root prefixes a Bun compiled binary mounts its embedded
 * files under, in probe order: POSIX first, Windows second. `Bun.embeddedFiles`
 * exposes only the flattened basename, so the full readable path is rebuilt as
 * `<prefix><basename>`.
 */
const BUNFS_ROOT_PREFIXES = ['/$bunfs/root/', 'B:/~BUN/root/'];

/**
 * Read the embedded web-bundle tar's bytes, or null when nothing is embedded —
 * i.e. not running from a compiled binary.
 *
 * `Bun.embeddedFiles` is binary-global: it lists every file the compiler baked
 * in, regardless of which module declared the `type: "file"` import, so this
 * reader needs no static import of its own (which keeps the `.tar` out of the
 * server's `tsc` graph). The listed blob's `.name` is the flattened basename;
 * the bytes are read by reconstructing the `/$bunfs` path and `readFileSync`-ing
 * it synchronously (resident-in-binary, no I/O), keeping the resolver sync.
 */
function readEmbeddedBundle(): Buffer | null {
  // `Bun.embeddedFiles` lists named blobs. Guard the global so a plain-node load
  // (the tsc-built `dist/` run via `node`) doesn't throw on a missing `Bun`; the
  // compiled path only runs under Bun, where the global exists.
  const files = typeof Bun === 'undefined' ? [] : Bun.embeddedFiles;
  for (const file of files) {
    // Each entry is a Blob carrying a `.name` (the flattened basename). It is NOT
    // an `instanceof File` in a compiled binary, so read `.name` off the Blob
    // directly rather than narrowing to File.
    const name = (file as Blob & { name?: string }).name;
    if (typeof name !== 'string' || !name.endsWith(BUNDLE_TAR_SUFFIX)) continue;
    for (const prefix of BUNFS_ROOT_PREFIXES) {
      try {
        return readFileSync(prefix + name);
      } catch {
        // Wrong prefix for this platform; try the next.
      }
    }
  }
  return null;
}

/** Short content hash keying the per-bundle cache dir. */
function bundleHash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

/**
 * Extract the bundle tar into `dir` using the system `tar`. The hosts that run
 * the compiled binary (macOS / Linux) ship `tar`; the Docker image never reaches
 * here because it runs from source, not a compiled binary. Throws on a non-zero
 * exit so the caller surfaces a clear failure rather than serving an empty dir.
 */
function extractTar(tarPath: string, dir: string): void {
  const result = spawnSync('tar', ['-xf', tarPath, '-C', dir], { stdio: 'pipe' });
  if (result.status !== 0) {
    const stderr = result.stderr?.toString() ?? '';
    throw new Error(`embedded web bundle extraction failed (tar exit ${result.status}): ${stderr}`);
  }
}

/**
 * Resolve the embedded web bundle to a real on-disk directory, materializing it
 * on first boot. Returns null when not running from a compiled binary or when no
 * bundle is embedded, so the three-tier resolver falls through cleanly.
 *
 * `baseOverride` is the test seam: tests point it at a tmp dir so they never
 * touch the developer's real `~/.claude-prove/`.
 */
export function materializeEmbeddedWebRoot(baseOverride?: string): string | null {
  // Provenance gate: only a compiled binary carries embedded assets. Under
  // `bun run`/`tsx` (dev) or the from-source Docker image this is false, so we
  // never read `Bun.embeddedFiles` and resolution falls through to plugin-dir.
  if (!runningFromCompiledBinary()) return null;

  const bytes = readEmbeddedBundle();
  if (!bytes) return null;

  const hash = bundleHash(bytes);
  const cacheDir = join(registryBaseDir(baseOverride), WEB_CACHE_SUBDIR, hash);
  const marker = join(cacheDir, EXTRACT_MARKER);

  // A present marker means a prior boot extracted this exact bundle — reuse it.
  if (existsSync(marker)) return cacheDir;

  // Stale or partial cache dir (no marker): start clean so a half-extracted tree
  // from an interrupted prior boot never gets served.
  rmSync(cacheDir, { recursive: true, force: true });
  mkdirSync(cacheDir, { recursive: true });

  // Write the tar to a sibling tmp path, extract it, then drop the marker. The
  // tar bytes are transient; only the extracted tree and marker persist.
  const tmpTar = join(cacheDir, `bundle.${process.pid}${BUNDLE_TAR_SUFFIX}`);
  writeFileSync(tmpTar, bytes);
  extractTar(tmpTar, cacheDir);
  rmSync(tmpTar, { force: true });

  // Guard against a stub/empty bundle slipping into a release: the committed
  // `web-dist.tar` is an empty stub the build overwrites, and a binary built
  // without that overwrite would embed it. An extracted tree with no
  // `index.html` is not servable, so fall through to the plugin-dir / WEB_ROOT
  // tiers instead of serving a broken root. No marker is written, so a later
  // boot re-attempts rather than caching the bad state.
  if (!existsSync(join(cacheDir, 'index.html'))) {
    rmSync(cacheDir, { recursive: true, force: true });
    return null;
  }

  writeFileSync(marker, `${hash}\n`, 'utf8');

  return cacheDir;
}
