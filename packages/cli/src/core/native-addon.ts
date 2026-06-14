/**
 * Materialize a @tursodatabase NAPI addon embedded in the compiled
 * `claude-prove` binary to a stable on-disk cache file, returning that path for
 * the addon's per-loader native-path env var (`TURSO_DATABASE_NATIVE_PATH` /
 * `TURSO_SYNC_NATIVE_PATH`).
 *
 * Two distinct addons are embedded — `@tursodatabase/database` (the local store
 * engine) and `@tursodatabase/sync` (the cloud sync engine) — each shipping its
 * own NAPI binding. Their stock loaders both read the single hardcoded
 * `NAPI_RS_NATIVE_LIBRARY_PATH`, which cannot point at two different addons at
 * once. The repo's loader patches therefore retarget each loader to its OWN env
 * var, and each addon is materialized under its own content-keyed filename
 * (prefixed by `name`) so the two never collide in the shared cache dir.
 *
 * Why not point the loader straight at the embedded `/$bunfs/root/…node` path:
 * `require()`-ing a `.node` out of the binary's virtual filesystem forces bun to
 * extract it to a SHARED, executable-derived temp path and then clean that path
 * up. When several `claude-prove` processes launch at once — which Claude Code
 * does on every hook batch (a single tool event fans out `cafi gate` +
 * `run-state` + `scrum` hooks simultaneously) — one process's extraction or
 * cleanup clobbers a sibling mid-load and the sibling sees no binding
 * ("Cannot find native binding"). Sequential runs never overlap, so the failure
 * is concurrency-only.
 *
 * The fix reads the embedded bytes (a plain content read, never a dlopen, so it
 * cannot race) and writes them ONCE to a content-keyed file under the
 * machine-global base dir, via a tmp-file + atomic rename, then hands the loader
 * that real path. Plain `require()` of a real on-disk `.node` is an ordinary
 * `dlopen` of a stable, read-only file — many processes can map it at once, as
 * with any shared library. The cache is keyed by content hash so a new binary's
 * addon lands in a fresh file and the prior one stays valid; it is never
 * deleted, so there is no cleanup to race on and no per-invocation extraction
 * cost (the hot path for per-event hooks is a single stat).
 *
 * IMPORTANT: this module must import only node builtins. It runs before the
 * store's Turso loader evaluates (it is what sets the env var that loader
 * reads), so importing anything that transitively pulls in
 * `@tursodatabase/database` — e.g. the `@claude-prove/store` barrel — would
 * evaluate that loader too early and defeat the fix. The base-dir resolution is
 * therefore inlined rather than imported from `registryBaseDir`.
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Machine-global base directory holding prove's cross-project state. */
const STABLE_ROOT_DIR = '.claude-prove';
/** Subdir of the base dir holding materialized native addons. */
const NATIVE_CACHE_SUBDIR = 'native';

/**
 * Resolve the machine-global base dir. Mirrors `registryBaseDir` from
 * `@claude-prove/store` (override → `CLAUDE_PROVE_HOME` → `~/.claude-prove`),
 * inlined to keep this pre-loader module free of the store import — see the
 * file header. `baseOverride` is the test seam.
 */
function resolveBaseDir(baseOverride?: string): string {
  if (baseOverride !== undefined && baseOverride.length > 0) return baseOverride;
  const envHome = process.env.CLAUDE_PROVE_HOME;
  if (envHome !== undefined && envHome.length > 0) return envHome;
  return join(homedir(), STABLE_ROOT_DIR);
}

/**
 * Copy the embedded addon at `bunfsPath` to a content-keyed cache file and
 * return that path. `name` namespaces the cache filename so two distinct addons
 * (`turso-<hash>.node` for database, `sync-<hash>.node` for sync) never collide.
 * Idempotent and concurrency-safe: a present file of the expected size is reused
 * as-is, and a fresh copy is published via tmp-write + atomic rename so a
 * concurrent reader never observes a partial file.
 */
export function materializeNativeAddon(
  bunfsPath: string,
  name = 'turso',
  baseOverride?: string,
): string {
  // Plain content read from the binary's virtual filesystem — not a dlopen, so
  // it cannot trigger bun's racy extract-to-shared-temp path.
  const bytes = readFileSync(bunfsPath);
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  const cacheDir = join(resolveBaseDir(baseOverride), NATIVE_CACHE_SUBDIR);
  const finalPath = join(cacheDir, `${name}-${hash}.node`);

  // Fast path: the filename is content-keyed, so a present file of the right
  // size is authoritative. Nearly every invocation stops here on a single stat.
  if (existsSync(finalPath) && statSync(finalPath).size === bytes.byteLength) {
    return finalPath;
  }

  mkdirSync(cacheDir, { recursive: true });
  // Unique tmp name per writer (no tmp collisions), then atomic rename onto the
  // final path. A reader doing `require(finalPath)` only ever sees the old
  // complete file or the new complete file; the rename is last-writer-wins over
  // byte-identical content.
  const tmpPath = `${finalPath}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  writeFileSync(tmpPath, bytes);
  chmodSync(tmpPath, 0o644);
  try {
    renameSync(tmpPath, finalPath);
  } catch (err) {
    // POSIX rename atomically replaces an existing target, so this only trips on
    // an unusual filesystem. Drop our tmp and accept a copy a racing writer may
    // have already published; re-raise only if the final file still isn't there.
    safeUnlink(tmpPath);
    if (!(existsSync(finalPath) && statSync(finalPath).size === bytes.byteLength)) throw err;
  }
  return finalPath;
}

function safeUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Best-effort: the tmp file may already be gone.
  }
}
