/**
 * PCD Round 2 batch formation.
 *
 * Ported 1:1 from `tools/pcd/batch_former.py`. Groups preserved triage cards
 * into review batches by structural-map cluster, splits oversized clusters by
 * sub-directory, and routes cross-file questions to the batch containing the
 * question's target file.
 *
 * Parity contract with the Python reference:
 *   - Cluster grouping is keyed on `cluster_id` looked up via the structural
 *     map's module list. Files missing from the map fall back to cluster 0.
 *   - Cluster groups are emitted in ascending `cluster_id` order (Python
 *     `sorted(cluster_groups.items())`).
 *   - Oversized clusters split alphabetically by `dirname(file)`; each subdir
 *     chunk is then sliced into `max_files_per_batch` runs.
 *   - `batch_id` is a 1-based integer counter assigned in emission order.
 *   - `estimated_tokens` uses on-disk file size / 4, with a 16000-char
 *     fallback per missing file. Empty input -> 0.
 *   - Questions route to the first batch whose `files` share ANY entry with
 *     the question's `target_files`. Fallback: batch with the most files in
 *     the same directory as `from_file` (first batch wins on tie).
 */

import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { CollapsedManifest, TriageCard } from './collapse';
import type { StructuralMap, StructuralMapCluster } from './structural-map';

// ---------------------------------------------------------------------------
// Path helpers (Python-parity)
// ---------------------------------------------------------------------------

/**
 * Python-parity `os.path.dirname` for POSIX paths.
 *
 * Differs from Node's `path.dirname` in two cases that matter here:
 *   - `""` -> `""` (Node: `"."`).
 *   - `"foo.py"` -> `""` (Node: `"."`).
 *
 * Triage card file paths are always project-relative with `/` separators,
 * so a stdlib-style split on the last `/` matches Python byte-for-byte.
 */
function pyDirname(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx >= 0 ? path.slice(0, idx) : '';
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RoutedQuestion {
  id: string;
  from_file: string;
  question: string;
}

export interface BatchDefinition {
  batch_id: number;
  files: string[];
  triage_cards: TriageCard[];
  cluster_context: StructuralMapCluster[];
  routed_questions: RoutedQuestion[];
  estimated_tokens: number;
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/**
 * Rough token estimate for batch input: sum of file sizes / 4. When a file
 * cannot be stat'd (missing, permission error), falls back to 16000 chars
 * (~200 lines * 80 chars). Returns 0 iff the total char count is 0.
 */
export function _estimateTokens(files: string[], projectRoot: string): number {
  let totalChars = 0;
  for (const filePath of files) {
    const fullPath = join(projectRoot, filePath);
    try {
      totalChars += statSync(fullPath).size;
    } catch {
      totalChars += 16000;
    }
  }
  if (totalChars === 0) return 0;
  return Math.max(Math.floor(totalChars / 4), 1);
}

// ---------------------------------------------------------------------------
// Question routing
// ---------------------------------------------------------------------------

/**
 * Route questions from the collapsed manifest to the best-match batch in-place.
 *
 * For each question: first pass attempts a direct hit (any overlap between
 * `target_files` and a batch's `files`). On miss, falls back to the batch
 * with the most files sharing `from_file`'s directory. First batch wins on
 * tie (Python `overlap > best_overlap` — strict greater-than).
 */
function routeQuestions(
  questionIndex: Array<Record<string, unknown>>,
  batches: BatchDefinition[],
): void {
  if (batches.length === 0) return;

  for (const q of questionIndex) {
    const targetFiles = Array.isArray(q.target_files) ? (q.target_files as string[]) : [];
    const fromFile = typeof q.from_file === 'string' ? q.from_file : '';
    const qTextRaw = typeof q.text === 'string' ? q.text : q.question;
    const qText = typeof qTextRaw === 'string' ? qTextRaw : '';
    const qId = typeof q.id === 'string' ? q.id : '';

    const routedQuestion: RoutedQuestion = {
      id: qId,
      from_file: fromFile,
      question: qText,
    };

    // Direct match: any shared file between batch and question targets.
    const targetSet = new Set(targetFiles);
    let routed = false;
    for (const batch of batches) {
      const batchFiles = batch.files;
      let hit = false;
      for (const f of batchFiles) {
        if (targetSet.has(f)) {
          hit = true;
          break;
        }
      }
      if (hit) {
        batch.routed_questions.push(routedQuestion);
        routed = true;
        break;
      }
    }

    if (routed) continue;

    // Fallback: batch with most files in the same directory as from_file.
    const fromDir = pyDirname(fromFile);

    let bestBatch = batches[0] as BatchDefinition;
    let bestOverlap = -1;
    for (const batch of batches) {
      let overlap = 0;
      for (const f of batch.files) {
        if (pyDirname(f) === fromDir) overlap++;
      }
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestBatch = batch;
      }
    }
    bestBatch.routed_questions.push(routedQuestion);
  }
}

// ---------------------------------------------------------------------------
// Cluster helpers
// ---------------------------------------------------------------------------

/** Build a file-path -> cluster_id map from the structural map modules. */
function buildFileToCluster(structuralMap: StructuralMap): Map<string, number> {
  const mapping = new Map<string, number>();
  for (const module of structuralMap.modules ?? []) {
    mapping.set(module.path ?? '', module.cluster_id ?? 0);
  }
  return mapping;
}

/** Find a cluster by id; null when not present. */
function getClusterById(
  structuralMap: StructuralMap,
  clusterId: number,
): StructuralMapCluster | null {
  for (const cluster of structuralMap.clusters ?? []) {
    if (cluster.id === clusterId) return cluster;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Form Round 2 review batches from a collapsed manifest and structural map.
 *
 * Strategy:
 *   1. Group preserved cards by `cluster_id` from the structural map (files
 *      missing from the map fall back to cluster 0).
 *   2. Emit cluster groups in ascending cluster_id order. If a group exceeds
 *      `maxFilesPerBatch`, split alphabetically by top-level subdir, then
 *      slice each subdir group into `maxFilesPerBatch` chunks.
 *   3. Route `question_index` entries into batches (see {@link routeQuestions}).
 *   4. Attach cluster context (one entry per batch when the cluster exists).
 *
 * @returns Array of batch definitions conforming to BATCH_DEFINITION_SCHEMA.
 */
export function formBatches(
  collapsedManifest: CollapsedManifest,
  structuralMap: StructuralMap,
  maxFilesPerBatch = 15,
  projectRoot = '.',
): BatchDefinition[] {
  const preservedCards = Array.isArray(collapsedManifest.preserved_cards)
    ? collapsedManifest.preserved_cards
    : [];
  const questionIndex = Array.isArray(collapsedManifest.question_index)
    ? collapsedManifest.question_index
    : [];

  if (preservedCards.length === 0) return [];

  const fileToCluster = buildFileToCluster(structuralMap);

  // Group cards by cluster_id. Map insertion order matches first-seen; we
  // sort numerically before emission to mirror Python's sorted().
  const clusterGroups = new Map<number, TriageCard[]>();
  for (const card of preservedCards) {
    const filePath = typeof card.file === 'string' ? card.file : '';
    const clusterId = fileToCluster.get(filePath) ?? 0;
    const bucket = clusterGroups.get(clusterId);
    if (bucket) bucket.push(card);
    else clusterGroups.set(clusterId, [card]);
  }

  const rawBatches: BatchDefinition[] = [];
  let batchIdCounter = 1;

  const sortedClusterIds = [...clusterGroups.keys()].sort((a, b) => a - b);
  for (const clusterId of sortedClusterIds) {
    const cards = clusterGroups.get(clusterId) ?? [];
    const clusterCtx = getClusterById(structuralMap, clusterId);

    if (cards.length <= maxFilesPerBatch) {
      const files = cards.map((c) => (typeof c.file === 'string' ? c.file : ''));
      rawBatches.push({
        batch_id: batchIdCounter,
        files,
        triage_cards: cards,
        cluster_context: clusterCtx ? [clusterCtx] : [],
        routed_questions: [],
        estimated_tokens: _estimateTokens(files, projectRoot),
      });
      batchIdCounter++;
      continue;
    }

    // Split by top-level subdirectory alphabetically, then chunk.
    const subdirGroups = new Map<string, TriageCard[]>();
    for (const card of cards) {
      const filePath = typeof card.file === 'string' ? card.file : '';
      const subdir = pyDirname(filePath);
      const bucket = subdirGroups.get(subdir);
      if (bucket) bucket.push(card);
      else subdirGroups.set(subdir, [card]);
    }

    const sortedSubdirs = [...subdirGroups.keys()].sort();
    for (const subdir of sortedSubdirs) {
      const subCards = subdirGroups.get(subdir) ?? [];
      for (let i = 0; i < subCards.length; i += maxFilesPerBatch) {
        const chunk = subCards.slice(i, i + maxFilesPerBatch);
        const files = chunk.map((c) => (typeof c.file === 'string' ? c.file : ''));
        rawBatches.push({
          batch_id: batchIdCounter,
          files,
          triage_cards: chunk,
          cluster_context: clusterCtx ? [clusterCtx] : [],
          routed_questions: [],
          estimated_tokens: _estimateTokens(files, projectRoot),
        });
        batchIdCounter++;
      }
    }
  }

  routeQuestions(questionIndex, rawBatches);

  return rawBatches;
}
