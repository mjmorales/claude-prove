/**
 * Index read/query module — config, hashing fast path, and every read-side
 * accessor over `.prove/file-index.json` (status, get, lookup, context,
 * clear). Cache mutation lives in `plan.ts` (additive stat backfill) and
 * `save.ts` (description merge + deletion prune); description generation
 * lives in the driver Claude session, never in this CLI.
 */

import { existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { FileCacheEntry } from '@claude-prove/shared';
import { DEFAULT_CONFIG, loadCache, loadToolConfig, walkProject } from '@claude-prove/shared';
import { computeHash, diffCache } from './hasher';

export const CACHE_FILENAME = 'file-index.json';

export function cachePath(projectRoot: string): string {
  return join(projectRoot, '.prove', CACHE_FILENAME);
}

export interface IndexStatus {
  new: number;
  stale: number;
  deleted: number;
  unchanged: number;
  cache_exists: boolean;
}

export interface CafiConfig {
  excludes: string[];
  max_file_size: number;
  batch_size: number;
  triage: boolean;
  [key: string]: unknown;
}

export function loadCafiConfig(projectRoot: string): CafiConfig {
  const raw = loadToolConfig(projectRoot, 'cafi', DEFAULT_CONFIG);
  return {
    excludes: Array.isArray(raw.excludes) ? (raw.excludes as string[]) : [],
    max_file_size: typeof raw.max_file_size === 'number' ? raw.max_file_size : 102400,
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
export function hashAllFilesWithFastPath(
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

/**
 * Quick status check without describing files. Mirrors `buildPlan`'s
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
