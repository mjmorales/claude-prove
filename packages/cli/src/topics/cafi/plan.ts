/**
 * Describe-plan builder — the mechanical half of an index build.
 *
 * Walks the project, triages, hashes, and diffs against the cache, then
 * emits the batched delta the driver Claude session describes (the judgment
 * half lives in the `/prove:index` skill, never in this CLI). Read-only
 * except for one additive write: backfilling mtime/size stat fields on
 * unchanged entries so future hashing keeps its fast path.
 *
 * Invariant: a stale entry keeps its old description AND its old cached
 * hash until `cafi save` lands the replacement. Advancing the hash here
 * would make `cafi status` report `unchanged` while the description is
 * stale, breaking the skill's verify loop and the Glob/Grep gate.
 */

import {
  CACHE_VERSION,
  type FileCache,
  loadCache,
  saveCache,
  walkProject,
} from '@claude-prove/shared';
import { diffCache } from './hasher';
import { cachePath, hashAllFilesWithFastPath, loadCafiConfig } from './indexer';
import { triageFiles } from './triage';

export interface PlanFileEntry {
  path: string;
  /** SHA-256 of the content the description must be generated from. */
  hash: string;
  reason: 'new' | 'stale';
}

export interface PlanBatch {
  id: number;
  files: PlanFileEntry[];
}

export interface DescribePlan {
  total: number;
  new: number;
  stale: number;
  /** Cached paths missing from the walk. NOT pruned here — `cafi save` (the
   *  lock-holding writer) prunes, so a transiently-missing file survives an
   *  aborted describe phase with its description intact. */
  deleted: string[];
  unchanged: number;
  batches: PlanBatch[];
}

export interface BuildPlanOptions {
  /** Re-describe every walked file, not just the delta. */
  force?: boolean;
  /** Files per batch. Default: `tools.cafi.config.batch_size` (25). */
  batchSize?: number;
}

function chunkEntries(entries: PlanFileEntry[], batchSize: number): PlanBatch[] {
  const size = Math.max(1, batchSize);
  const batches: PlanBatch[] = [];
  for (let i = 0; i < entries.length; i += size) {
    batches.push({ id: batches.length + 1, files: entries.slice(i, i + size) });
  }
  return batches;
}

/**
 * Backfill mtime/size onto unchanged entries missing them, so the next
 * walk's hashing can stat-skip. Persists only when something changed —
 * repeated `plan` runs are idempotent and write-free.
 */
function backfillUnchangedStats(
  projectRoot: string,
  cache: FileCache,
  unchanged: string[],
  stats: Record<string, { mtime_ms: number; size: number }>,
): void {
  let mutated = false;
  for (const fp of unchanged) {
    const entry = cache.files?.[fp];
    const st = stats[fp];
    if (!entry || !st) continue;
    if (entry.mtime_ms !== st.mtime_ms || entry.size !== st.size) {
      entry.mtime_ms = st.mtime_ms;
      entry.size = st.size;
      mutated = true;
    }
  }
  if (mutated) {
    saveCache(cachePath(projectRoot), { ...cache, version: CACHE_VERSION });
  }
}

/**
 * Build the describe plan: the batched new/stale delta plus deletion and
 * unchanged bookkeeping. `--force` puts every walked file in a batch while
 * still reporting `new` vs `stale` honestly from cache presence.
 */
export function buildPlan(projectRoot: string, options: BuildPlanOptions = {}): DescribePlan {
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
  const { hashes, stats } = hashAllFilesWithFastPath(projectRoot, files, cache.files ?? {});
  const diff = diffCache(hashes, cache);

  let toDescribe: PlanFileEntry[];
  let staleCount: number;
  let unchangedCount: number;

  if (force) {
    const newSet = new Set(diff.new);
    toDescribe = Object.keys(hashes)
      .sort()
      .map((fp) => ({
        path: fp,
        hash: hashes[fp] as string,
        reason: newSet.has(fp) ? ('new' as const) : ('stale' as const),
      }));
    staleCount = toDescribe.length - diff.new.length;
    unchangedCount = 0;
  } else {
    toDescribe = [
      ...diff.new.map((fp) => ({ path: fp, hash: hashes[fp] as string, reason: 'new' as const })),
      ...diff.stale.map((fp) => ({
        path: fp,
        hash: hashes[fp] as string,
        reason: 'stale' as const,
      })),
    ];
    staleCount = diff.stale.length;
    unchangedCount = diff.unchanged.length;
  }

  backfillUnchangedStats(projectRoot, cache, diff.unchanged, stats);

  const batchSize =
    options.batchSize ?? (typeof config.batch_size === 'number' ? config.batch_size : 25);

  return {
    total: Object.keys(hashes).length,
    new: diff.new.length,
    stale: staleCount,
    deleted: diff.deleted,
    unchanged: unchangedCount,
    batches: chunkEntries(toDescribe, batchSize),
  };
}
