/**
 * Index manager — ties hasher and describer together.
 *
 * Reads per-tool config from the v4 schema path `tools.cafi.config`, walks
 * the project, hashes every file, diffs against the cache, describes the
 * delta via the Claude CLI, and persists the merged result. All public
 * return shapes use snake_case keys so JSON output stays stable.
 */

import { existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { FileCache, FileCacheEntry } from '@claude-prove/shared';
import {
  CACHE_VERSION,
  DEFAULT_CONFIG,
  loadCache,
  loadToolConfig,
  saveCache,
  walkProject,
} from '@claude-prove/shared';
import { describeFiles, triageFiles } from './describer';
import { computeHash, diffCache } from './hasher';

export const CACHE_FILENAME = 'file-index.json';

export function cachePath(projectRoot: string): string {
  return join(projectRoot, '.prove', CACHE_FILENAME);
}

export interface BuildIndexOptions {
  force?: boolean;
}

export interface BuildIndexSummary {
  new: number;
  stale: number;
  deleted: number;
  unchanged: number;
  total: number;
  errors: number;
}

export interface IndexStatus {
  new: number;
  stale: number;
  deleted: number;
  unchanged: number;
  cache_exists: boolean;
}

interface CafiConfig {
  excludes: string[];
  max_file_size: number;
  concurrency: number;
  batch_size: number;
  triage: boolean;
  [key: string]: unknown;
}

function loadCafiConfig(projectRoot: string): CafiConfig {
  const raw = loadToolConfig(projectRoot, 'cafi', DEFAULT_CONFIG);
  return {
    excludes: Array.isArray(raw.excludes) ? (raw.excludes as string[]) : [],
    max_file_size: typeof raw.max_file_size === 'number' ? raw.max_file_size : 102400,
    concurrency: typeof raw.concurrency === 'number' ? raw.concurrency : 3,
    batch_size: typeof raw.batch_size === 'number' ? raw.batch_size : 25,
    triage: raw.triage !== false,
  };
}

/**
 * Hash every file, but skip rehashing when the cached mtime+size match the
 * file on disk. When the fast path fires, the cached hash is reused — this is
 * safe because a matching mtime+size means the inode content has not changed
 * since the last index build. On a miss (new file, or mtime/size changed, or
 * no cached stat), the file is hashed and the new stat is recorded.
 *
 * Residual risk: on filesystems with coarse mtime granularity (HFS+ ticks in
 * whole seconds), a same-size edit within one tick can falsely hit the fast
 * path and reuse a stale hash. Accepted: the cache only feeds description
 * freshness (routing hints), so the worst case is one delayed re-description,
 * and APFS — the common case on darwin — has nanosecond timestamps.
 *
 * Returns both the hash map and the per-file stat used so callers can
 * backfill the stat fields into the cache entry without a second syscall.
 */
function hashAllFilesWithFastPath(
  projectRoot: string,
  files: string[],
  cachedFiles: Record<string, FileCacheEntry>,
): { hashes: Record<string, string>; stats: Record<string, { mtime_ms: number; size: number }> } {
  const hashes: Record<string, string> = {};
  const stats: Record<string, { mtime_ms: number; size: number }> = {};
  for (const fp of files) {
    const absPath = join(projectRoot, fp);
    const st = statSync(absPath);
    const mtime_ms = st.mtimeMs;
    const size = st.size;
    stats[fp] = { mtime_ms, size };
    const cached = cachedFiles[fp];
    if (
      cached?.mtime_ms !== undefined &&
      cached.size !== undefined &&
      cached.mtime_ms === mtime_ms &&
      cached.size === size
    ) {
      // Fast path: stat fields match — reuse the stored hash without reading file bytes.
      hashes[fp] = cached.hash;
    } else {
      hashes[fp] = computeHash(absPath);
    }
  }
  return { hashes, stats };
}

function defaultProgress(done: number, total: number, path: string): void {
  process.stderr.write(`\r  [${done}/${total}] ${path}`);
  if (done === total) process.stderr.write('\n');
}

/**
 * Run a full or incremental index build.
 *
 * Pipeline: load config -> walk project -> optional triage -> hash each
 * file -> diff against cache -> describe new/stale -> merge and persist.
 * On `force`, every file is re-described and unchanged collapses to [].
 */
export async function buildIndex(
  projectRoot: string,
  options: BuildIndexOptions = {},
): Promise<BuildIndexSummary> {
  const force = options.force ?? false;
  const config = loadCafiConfig(projectRoot);

  let files = walkProject(projectRoot, {
    excludes: config.excludes,
    maxFileSize: config.max_file_size,
  });

  if (config.triage) {
    files = triageFiles(files);
  }

  const cache = loadCache(cachePath(projectRoot));
  const { hashes: currentHashes, stats: currentStats } = hashAllFilesWithFastPath(
    projectRoot,
    files,
    cache.files ?? {},
  );
  const diff = diffCache(currentHashes, cache);

  let toDescribe: string[];
  let stale: string[];
  let unchanged: string[];
  const newFiles = diff.new;
  const deleted = diff.deleted;

  if (force) {
    toDescribe = Object.keys(currentHashes);
    const newSet = new Set(newFiles);
    stale = Object.keys(currentHashes).filter((fp) => !newSet.has(fp));
    unchanged = [];
  } else {
    toDescribe = [...newFiles, ...diff.stale];
    stale = diff.stale;
    unchanged = diff.unchanged;
  }

  let descriptions: Record<string, string> = {};
  if (toDescribe.length > 0) {
    descriptions = await describeFiles(toDescribe, projectRoot, {
      concurrency: config.concurrency,
      batchSize: config.batch_size,
      onProgress: defaultProgress,
    });
  }

  const errorCount = toDescribe.filter((fp) => !descriptions[fp]).length;

  const cachedFiles: Record<string, FileCacheEntry> = { ...(cache.files ?? {}) };

  for (const fp of deleted) {
    delete cachedFiles[fp];
  }

  // `toDescribe` holds new + stale/forced files — every entry here was just
  // re-hashed and re-described, so `last_indexed` records THIS describe time,
  // not the original first-index time (which would be stale for the exact
  // files that changed). The unchanged loop below preserves prior timestamps.
  // mtime_ms + size are persisted so future getStatus/buildIndex calls can
  // skip rehashing files whose stat fields have not changed.
  for (const fp of toDescribe) {
    const st = currentStats[fp];
    cachedFiles[fp] = {
      hash: currentHashes[fp] as string,
      description: descriptions[fp] ?? '',
      last_indexed: new Date().toISOString(),
      mtime_ms: st?.mtime_ms,
      size: st?.size,
    };
  }

  for (const fp of unchanged) {
    const entry = cachedFiles[fp];
    if (entry) {
      entry.hash = currentHashes[fp] as string;
      // Backfill stat fields on unchanged entries so the fast path is
      // available on the next invocation even for files not re-described.
      const st = currentStats[fp];
      if (st) {
        entry.mtime_ms = st.mtime_ms;
        entry.size = st.size;
      }
    }
  }

  const nextCache: FileCache = {
    ...cache,
    version: CACHE_VERSION,
    files: cachedFiles,
  };
  saveCache(cachePath(projectRoot), nextCache);

  return {
    new: newFiles.length,
    stale: stale.length,
    deleted: deleted.length,
    unchanged: unchanged.length,
    total: Object.keys(currentHashes).length,
    errors: errorCount,
  };
}

/**
 * Quick status check without describing files. Mirrors `build_index`'s
 * walk + hash + diff phases so the caller sees exactly what a run would do.
 *
 * Cost: "quick" means it skips the (expensive) describe pass, NOT that it is
 * free. Files whose cached mtime+size match on disk reuse their stored hash
 * (stat-only); every other file is synchronously read + SHA-256-hashed on the
 * main thread. Worst case (cold or stale cache) is O(total repo bytes)
 * blocking I/O — effectively a full index walk minus describe. The only bound
 * is the per-file `max_file_size` cap; there is no file-count cap.
 */
export function getStatus(projectRoot: string): IndexStatus {
  const config = loadCafiConfig(projectRoot);
  const files = walkProject(projectRoot, {
    excludes: config.excludes,
    maxFileSize: config.max_file_size,
  });

  const cp = cachePath(projectRoot);
  const cache = loadCache(cp);
  // Use the mtime+size fast path so unchanged files are not re-hashed.
  const { hashes: currentHashes } = hashAllFilesWithFastPath(projectRoot, files, cache.files ?? {});
  const diff = diffCache(currentHashes, cache);

  return {
    new: diff.new.length,
    stale: diff.stale.length,
    deleted: diff.deleted.length,
    unchanged: diff.unchanged.length,
    cache_exists: fileExists(cp),
  };
}

/** Look up the cached description for a single file, or null if absent. */
export function getDescription(projectRoot: string, filePath: string): string | null {
  const cache = loadCache(cachePath(projectRoot));
  const entry = cache.files?.[filePath];
  if (!entry) return null;
  return entry.description;
}

/** Delete the cache file. Returns true if a file was deleted, false if absent. */
export function clearCache(projectRoot: string): boolean {
  const cp = cachePath(projectRoot);
  if (fileExists(cp)) {
    rmSync(cp);
    return true;
  }
  return false;
}

export interface LookupHit {
  path: string;
  description: string;
}

/**
 * Case-insensitive search across cached paths and descriptions. Returns
 * hits sorted by path.
 */
export function lookup(projectRoot: string, keyword: string): LookupHit[] {
  const cache = loadCache(cachePath(projectRoot));
  const files = cache.files ?? {};
  const paths = Object.keys(files);
  if (paths.length === 0) return [];

  const needle = keyword.toLowerCase();
  const hits: LookupHit[] = [];
  for (const path of paths.sort()) {
    const entry = files[path];
    const description = entry?.description ?? '';
    if (path.toLowerCase().includes(needle) || description.toLowerCase().includes(needle)) {
      hits.push({ path, description });
    }
  }
  return hits;
}

/**
 * Render the cache as a compact Markdown block for session-context
 * injection. Returns the empty string when no cache exists.
 */
export function formatIndexForContext(projectRoot: string): string {
  const cache = loadCache(cachePath(projectRoot));
  const files = cache.files ?? {};
  const paths = Object.keys(files);
  if (paths.length === 0) return '';

  const lines: string[] = ['# Project File Index', ''];
  for (const path of paths.sort()) {
    const description = files[path]?.description ?? '';
    if (description) {
      lines.push(`- \`${path}\`: ${description}`);
    } else {
      lines.push(`- \`${path}\`: (no description)`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function fileExists(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
