/**
 * Description persister — the validate-then-persist half of an index build.
 *
 * Accepts driver-generated routing-hint descriptions and merges them into
 * `.prove/file-index.json` behind a mechanical validation floor: every
 * description must be non-empty, length-capped, and generated from the
 * bytes currently on disk (recomputed hash must equal the payload hash).
 * Rejections are returned, never silently dropped, so the driver can
 * re-plan drifted files.
 *
 * This is the single destructive cache writer: deletion pruning happens
 * here (not in `plan`), and the whole load→merge→write sequence runs under
 * the shared advisory file lock so parallel batch agents saving
 * concurrently cannot lose updates.
 */

import { statSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import { CACHE_VERSION, loadCache, saveCache, withFileLock } from '@claude-prove/shared';
import { computeHash } from './hasher';
import { cachePath } from './indexer';

/** Routing hints are 1-3 sentences; anything longer is a summary, not a hint. */
export const MAX_DESCRIPTION_LENGTH = 600;

export interface SavePayloadFile {
  hash: string;
  description: string;
}

export interface SavePayload {
  files: Record<string, SavePayloadFile>;
  /** Paths `cafi plan` reported deleted; pruned here after re-verifying
   *  they are still absent from disk (a reappeared file keeps its entry). */
  deleted: string[];
}

export type SaveRejectionReason = 'hash-drift' | 'deleted' | 'invalid-description' | 'invalid-path';

export interface SaveRejection {
  path: string;
  reason: SaveRejectionReason;
}

export interface SaveResult {
  saved: number;
  pruned: number;
  rejected: SaveRejection[];
}

/** Malformed payload shape — distinct from per-file rejections (exit-1 path). */
export class SavePayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SavePayloadError';
  }
}

/** Parse and shape-check a raw save payload. Throws `SavePayloadError`. */
export function parseSavePayload(raw: string): SavePayload {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new SavePayloadError('payload is not valid JSON');
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new SavePayloadError('payload must be a JSON object');
  }

  const obj = data as Record<string, unknown>;
  const filesRaw = obj.files ?? {};
  if (filesRaw === null || typeof filesRaw !== 'object' || Array.isArray(filesRaw)) {
    throw new SavePayloadError('"files" must be an object mapping path -> { hash, description }');
  }

  const files: Record<string, SavePayloadFile> = {};
  for (const [path, entry] of Object.entries(filesRaw as Record<string, unknown>)) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new SavePayloadError(`"files['${path}']" must be an object with hash and description`);
    }
    const { hash, description } = entry as Record<string, unknown>;
    if (typeof hash !== 'string' || typeof description !== 'string') {
      throw new SavePayloadError(`"files['${path}']" needs string "hash" and "description" fields`);
    }
    files[path] = { hash, description };
  }

  const deletedRaw = obj.deleted ?? [];
  if (!Array.isArray(deletedRaw) || deletedRaw.some((d) => typeof d !== 'string')) {
    throw new SavePayloadError('"deleted" must be an array of path strings');
  }

  return { files, deleted: deletedRaw as string[] };
}

/** A cache key must stay inside the project root — relative, no `..` escape. */
function isUnsafePath(path: string): boolean {
  if (path === '' || isAbsolute(path)) return true;
  const normalized = normalize(path);
  return normalized === '..' || normalized.startsWith('../');
}

function fileMissing(absPath: string): boolean {
  try {
    return !statSync(absPath).isFile();
  } catch {
    return true;
  }
}

interface AcceptedFile {
  path: string;
  hash: string;
  description: string;
  mtime_ms: number;
  size: number;
}

/**
 * Validate the payload per-file and merge accepted descriptions into the
 * cache under the advisory lock. Hashing runs before the lock — the lock
 * protects only the cache read-modify-write, while the hash check protects
 * describe-time content against save-time drift.
 */
export async function saveDescriptions(
  projectRoot: string,
  payload: SavePayload,
): Promise<SaveResult> {
  const accepted: AcceptedFile[] = [];
  const rejected: SaveRejection[] = [];

  for (const [path, entry] of Object.entries(payload.files)) {
    if (isUnsafePath(path)) {
      rejected.push({ path, reason: 'invalid-path' });
      continue;
    }
    const description = entry.description.trim();
    if (description === '' || description.length > MAX_DESCRIPTION_LENGTH) {
      rejected.push({ path, reason: 'invalid-description' });
      continue;
    }
    const absPath = join(projectRoot, path);
    if (fileMissing(absPath)) {
      rejected.push({ path, reason: 'deleted' });
      continue;
    }
    const st = statSync(absPath);
    if (computeHash(absPath) !== entry.hash) {
      rejected.push({ path, reason: 'hash-drift' });
      continue;
    }
    accepted.push({ path, hash: entry.hash, description, mtime_ms: st.mtimeMs, size: st.size });
  }

  let pruned = 0;
  const cp = cachePath(projectRoot);

  if (accepted.length > 0 || payload.deleted.length > 0) {
    await withFileLock(`${cp}.lock`, () => {
      const cache = loadCache(cp);
      const files = { ...(cache.files ?? {}) };

      for (const file of accepted) {
        files[file.path] = {
          hash: file.hash,
          description: file.description,
          last_indexed: new Date().toISOString(),
          mtime_ms: file.mtime_ms,
          size: file.size,
        };
      }

      for (const path of payload.deleted) {
        if (isUnsafePath(path)) continue;
        // Re-verify absence: a file that reappeared since `plan` keeps its
        // entry (the next plan re-diffs it as unchanged or stale).
        if (path in files && fileMissing(join(projectRoot, path))) {
          delete files[path];
          pruned++;
        }
      }

      saveCache(cp, { ...cache, version: CACHE_VERSION, files });
    });
  }

  return { saved: accepted.length, pruned, rejected };
}
