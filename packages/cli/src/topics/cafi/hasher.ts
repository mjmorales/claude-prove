/**
 * File hasher and cache diff for CAFI.
 *
 * Ported from `tools/cafi/hasher.py`. Computes SHA-256 hashes and diffs
 * against a cached file index to identify new, stale, deleted, and
 * unchanged files. File walking, cache I/O, and binary detection live
 * in `@claude-prove/shared` and should be imported directly by callers.
 */

import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync } from 'node:fs';
import type { FileCache } from '@claude-prove/shared';

/** Streaming chunk size for hashing — mirrors Python's 8 KiB reads. */
const HASH_CHUNK_BYTES = 8192;

/**
 * Compute the SHA-256 hex digest of a file, streamed in 8 KiB chunks.
 *
 * Uses synchronous `node:fs` reads plus `node:crypto.createHash` so the
 * output is byte-identical to Python's `hashlib.sha256` for the same
 * bytes on disk.
 */
export function computeHash(filePath: string): string {
  const hash = createHash('sha256');
  const buf = Buffer.alloc(HASH_CHUNK_BYTES);
  const fd = openSync(filePath, 'r');
  try {
    let offset = 0;
    while (true) {
      const bytesRead = readSync(fd, buf, 0, HASH_CHUNK_BYTES, offset);
      if (bytesRead === 0) break;
      hash.update(buf.subarray(0, bytesRead));
      offset += bytesRead;
    }
  } finally {
    try {
      closeSync(fd);
    } catch {
      // best-effort cleanup — fd may already be closed
    }
  }
  return hash.digest('hex');
}

export interface DiffCacheResult {
  new: string[];
  stale: string[];
  deleted: string[];
  unchanged: string[];
}

/**
 * Compare current file hashes against the cached index.
 *
 * @param currentFiles mapping of relative path -> sha256 hex digest
 * @param cache the full cache object (with `version` and `files` keys)
 * @returns sorted arrays for each category (matches Python's `sorted(set(...))`)
 */
export function diffCache(currentFiles: Record<string, string>, cache: FileCache): DiffCacheResult {
  const cachedFiles = cache.files ?? {};

  const currentPaths = Object.keys(currentFiles);
  const cachedPaths = Object.keys(cachedFiles);
  const currentSet = new Set(currentPaths);
  const cachedSet = new Set(cachedPaths);

  const newFiles = currentPaths.filter((p) => !cachedSet.has(p)).sort();
  const deleted = cachedPaths.filter((p) => !currentSet.has(p)).sort();

  const stale: string[] = [];
  const unchanged: string[] = [];
  const intersected = currentPaths.filter((p) => cachedSet.has(p)).sort();
  for (const path of intersected) {
    const cachedEntry = cachedFiles[path];
    const cachedHash = cachedEntry?.hash;
    if (currentFiles[path] !== cachedHash) {
      stale.push(path);
    } else {
      unchanged.push(path);
    }
  }

  return { new: newFiles, stale, deleted, unchanged };
}
