/**
 * `prove pcd collapse [--token-budget N] [--project-root PATH]`
 *
 * Ports `tools/pcd/__main__.py::cmd_collapse`:
 *   - Reads `<pcd>/triage-manifest.json`; exits 1 with Python-verbatim
 *     `Error: triage manifest not found: <path>` if missing.
 *   - Writes `<pcd>/collapsed-manifest.json` via `serializeCollapsedManifest`
 *     so `compression_ratio` renders Python-style (`0.0` vs `0`).
 *   - stdout: the same serialized JSON.
 *   - stderr: one-line stats + `Written to <abspath>`.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { type TriageManifest, collapseManifest, serializeCollapsedManifest } from '../collapse';
import { ensurePcdDir, resolveProjectRoot } from './paths';

export interface CollapseFlags {
  projectRoot?: string;
  tokenBudget?: number;
}

export function runCollapse(flags: CollapseFlags): number {
  const projectRoot = resolveProjectRoot(flags.projectRoot);
  const pcdDir = ensurePcdDir(projectRoot);

  const manifestPath = join(pcdDir, 'triage-manifest.json');
  if (!existsSync(manifestPath)) {
    console.error(`Error: triage manifest not found: ${manifestPath}`);
    return 1;
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as TriageManifest;
  const tokenBudget = flags.tokenBudget ?? 8000;
  const collapsed = collapseManifest(manifest, tokenBudget);

  const serialized = serializeCollapsedManifest(collapsed, 2);
  const outPath = join(pcdDir, 'collapsed-manifest.json');
  writeFileSync(outPath, serialized, 'utf8');

  // Machine-readable JSON to stdout.
  console.log(serialized);

  // Human-readable summary to stderr — format compression_ratio with two
  // decimals to match Python's `f"{x:.2f}"`.
  const stats = collapsed.stats;
  const ratio = stats.compression_ratio.toFixed(2);
  console.error(
    `Collapse: ${stats.total_cards} total cards, ${stats.preserved} preserved, ${stats.collapsed} collapsed, compression ratio ${ratio}`,
  );
  console.error(`Written to ${outPath}`);
  return 0;
}
