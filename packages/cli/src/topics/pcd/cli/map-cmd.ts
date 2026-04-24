/**
 * `claude-prove pcd map [--scope FILE,...] [--project-root PATH]`
 *
 * Ports `tools/pcd/__main__.py::cmd_map` byte-for-byte on stdout/stderr:
 *   - stdout: `json.dumps(structural_map, indent=2)` (consumed by LLM agents)
 *   - stderr: `Structural map: <N> files, <lang counts>, <clusters> clusters, <edges> edges`
 *             followed by `Written to <abspath>`.
 *
 * `generateStructuralMap` handles the artifact write itself (see
 * structural-map.ts); this handler only emits the dual-stream summary.
 */

import { join } from 'node:path';
import { generateStructuralMap } from '../structural-map';
import { ensurePcdDir, resolveProjectRoot } from './paths';

export interface MapFlags {
  projectRoot?: string;
  scope?: string;
}

/**
 * Python: `scope = [s.strip() for s in raw_scope.split(',') if s.strip()]`.
 * Returns `undefined` for missing/empty input so the walker falls back to
 * its default project scan. An all-whitespace `--scope` value collapses to
 * an empty list which Python happily accepts and returns zero files — we
 * preserve that edge case by returning `[]` here, not `undefined`.
 */
export function parseScope(raw: string | undefined): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function runMap(flags: MapFlags): number {
  const projectRoot = resolveProjectRoot(flags.projectRoot);
  ensurePcdDir(projectRoot);

  const scope = parseScope(flags.scope);
  const structuralMap = generateStructuralMap(projectRoot, scope);

  // Machine-readable JSON to stdout (consumed by LLM agents).
  console.log(JSON.stringify(structuralMap, null, 2));

  // Human-readable summary to stderr.
  const summary = structuralMap.summary;
  const clusters = structuralMap.clusters;
  const edges = structuralMap.dependency_edges;
  const languages = summary.languages;
  const langParts = Object.keys(languages)
    .sort()
    .map((lang) => `${lang}: ${languages[lang]}`);
  const langLine = langParts.length > 0 ? langParts.join(', ') : 'no languages detected';
  console.error(
    `Structural map: ${summary.total_files} files, ${langLine}, ${clusters.length} clusters, ${edges.length} edges`,
  );

  const outPath = join(projectRoot, '.prove', 'steward', 'pcd', 'structural-map.json');
  console.error(`Written to ${outPath}`);
  return 0;
}
