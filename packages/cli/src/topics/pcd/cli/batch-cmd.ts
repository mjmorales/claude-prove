/**
 * `claude-prove pcd batch [--max-files N] [--project-root PATH]`
 *
 * Ports `tools/pcd/__main__.py::cmd_batch`:
 *   - Reads `<pcd>/collapsed-manifest.json` and `<pcd>/structural-map.json`.
 *     Missing either exits 1 with Python-verbatim error message to stderr.
 *   - Writes `<pcd>/batch-definitions.json` (the array of batches, indent=2).
 *   - stdout: the same JSON array.
 *   - stderr: `Batches: <n> batches, files per batch: [<a>, <b>], total estimated tokens: <t>`
 *             followed by `Written to <abspath>`.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formBatches } from '../batch-former';
import type { CollapsedManifest } from '../collapse';
import type { StructuralMap } from '../structural-map';
import { ensurePcdDir, resolveProjectRoot } from './paths';

export interface BatchFlags {
  projectRoot?: string;
  maxFiles?: number;
}

export function runBatch(flags: BatchFlags): number {
  const projectRoot = resolveProjectRoot(flags.projectRoot);
  const pcdDir = ensurePcdDir(projectRoot);

  const collapsedPath = join(pcdDir, 'collapsed-manifest.json');
  const structMapPath = join(pcdDir, 'structural-map.json');

  if (!existsSync(collapsedPath)) {
    console.error(`Error: collapsed manifest not found: ${collapsedPath}`);
    return 1;
  }
  if (!existsSync(structMapPath)) {
    console.error(`Error: structural map not found: ${structMapPath}`);
    return 1;
  }

  const collapsed = JSON.parse(readFileSync(collapsedPath, 'utf8')) as CollapsedManifest;
  const structuralMap = JSON.parse(readFileSync(structMapPath, 'utf8')) as StructuralMap;

  const maxFiles = flags.maxFiles ?? 15;
  const batches = formBatches(collapsed, structuralMap, maxFiles, projectRoot);

  const serialized = JSON.stringify(batches, null, 2);
  const outPath = join(pcdDir, 'batch-definitions.json');
  writeFileSync(outPath, serialized, 'utf8');

  // Machine-readable JSON to stdout.
  console.log(serialized);

  // Human-readable summary to stderr — match Python list repr: `[1, 2, 3]`.
  const filesPerBatch = batches.map((b) => b.files.length);
  const totalTokens = batches.reduce((acc, b) => acc + b.estimated_tokens, 0);
  const filesPerBatchRepr = `[${filesPerBatch.join(', ')}]`;
  console.error(
    `Batches: ${batches.length} batches, files per batch: ${filesPerBatchRepr}, total estimated tokens: ${totalTokens}`,
  );
  console.error(`Written to ${outPath}`);
  return 0;
}
