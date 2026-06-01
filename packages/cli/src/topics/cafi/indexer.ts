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

function hashAllFiles(projectRoot: string, files: string[]): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const fp of files) {
    hashes[fp] = computeHash(join(projectRoot, fp));
  }
  return hashes;
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

  const currentHashes = hashAllFiles(projectRoot, files);
  const cache = loadCache(cachePath(projectRoot));
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
  for (const fp of toDescribe) {
    cachedFiles[fp] = {
      hash: currentHashes[fp] as string,
      description: descriptions[fp] ?? '',
      last_indexed: new Date().toISOString(),
    };
  }

  for (const fp of unchanged) {
    const entry = cachedFiles[fp];
    if (entry) entry.hash = currentHashes[fp] as string;
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
 * cheap. `hashAllFiles` synchronously reads + SHA-256-hashes every walked
 * file on the main thread, so this is O(total repo bytes) blocking I/O —
 * effectively a full index walk minus describe. The only bound is the
 * per-file `max_file_size` cap; there is no file-count cap. Expect latency
 * proportional to repo size on large trees.
 */
export function getStatus(projectRoot: string): IndexStatus {
  const config = loadCafiConfig(projectRoot);
  const files = walkProject(projectRoot, {
    excludes: config.excludes,
    maxFileSize: config.max_file_size,
  });

  const currentHashes = hashAllFiles(projectRoot, files);
  const cp = cachePath(projectRoot);
  const cache = loadCache(cp);
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
