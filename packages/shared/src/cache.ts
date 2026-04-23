/**
 * File index cache I/O — shared by CAFI and PCD.
 *
 * Canonical JSON output: keys sorted alphabetically (recursively), 2-space
 * indent, trailing newline. Writes are atomic via tempfile + rename.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

/** Cache schema version. Bump when the on-disk layout changes incompatibly. */
export const CACHE_VERSION = 1;

export interface FileCacheEntry {
  hash: string;
  description: string;
  last_indexed: string;
}

export interface FileCache {
  version: number;
  files: Record<string, FileCacheEntry>;
  [key: string]: unknown;
}

function emptyCache(): FileCache {
  return { version: CACHE_VERSION, files: {} };
}

/**
 * Load the file index cache from disk.
 *
 * Returns an empty cache if the file is missing, malformed, or tagged with
 * a version other than `CACHE_VERSION`. Never throws for I/O errors — the
 * indexer treats an unreadable cache as a cache miss.
 */
export function loadCache(cachePath: string): FileCache {
  let raw: string;
  try {
    raw = readFileSync(cachePath, 'utf8');
  } catch {
    return emptyCache();
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return emptyCache();
  }

  if (
    data !== null &&
    typeof data === 'object' &&
    !Array.isArray(data) &&
    (data as { version?: unknown }).version === CACHE_VERSION
  ) {
    return data as FileCache;
  }
  return emptyCache();
}

/**
 * Write cache to disk atomically via tempfile + rename.
 *
 * Emits byte-identical output to Python's
 * `json.dump(cache, f, indent=2, sort_keys=True)` plus a trailing newline.
 * On any write error, the temp directory is cleaned up and the error is
 * re-thrown so callers can surface it.
 */
export function saveCache(cachePath: string, cache: FileCache): void {
  const cacheDir = dirname(cachePath);
  if (cacheDir && cacheDir !== '.') {
    mkdirSync(cacheDir, { recursive: true });
  }

  const tmpDir = mkdtempSync(join(cacheDir || '.', '.file-index-'));
  const tmpPath = join(tmpDir, 'cache.json');

  try {
    const serialised = `${JSON.stringify(sortKeysDeep(cache), null, 2)}\n`;
    writeFileSync(tmpPath, serialised, 'utf8');
    renameSync(tmpPath, cachePath);
  } catch (err) {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
    throw err;
  }

  // Success path: clean up the now-empty temp dir.
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
}

/**
 * Recursively rebuild an object with keys in sorted order so
 * `JSON.stringify` emits them deterministically. Arrays keep their order;
 * scalars pass through.
 */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}
