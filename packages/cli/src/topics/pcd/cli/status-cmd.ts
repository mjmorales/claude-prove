/**
 * `claude-prove pcd status [--project-root PATH]`
 *
 * Ports `tools/pcd/__main__.py::cmd_status`:
 *   - If `<pcd>/pipeline-status.json` exists, stdout = its JSON, stderr =
 *     `Pipeline status:` header + sorted `  <round>: <state>` lines.
 *   - Otherwise: stdout = `{"found": {...}, "missing": {...}}` (indent=2),
 *     stderr = `No pipeline-status.json found. Artifact check:` + per-
 *     artifact `  [OK|MISSING] <label> (<filename>)` lines in insertion
 *     order to match Python's literal dict order.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pcdPath, resolveProjectRoot } from './paths';

export interface StatusFlags {
  projectRoot?: string;
}

/**
 * Artifact discovery table — keep insertion order identical to Python so
 * stderr lines emit in the same sequence (`Round 0a`, `Round 1`, `Round 1b`,
 * `Round 2`).
 */
const ARTIFACTS: Array<{ filename: string; label: string }> = [
  { filename: 'structural-map.json', label: 'Round 0a (structural map)' },
  { filename: 'triage-manifest.json', label: 'Round 1 (triage)' },
  { filename: 'collapsed-manifest.json', label: 'Round 1b (collapse)' },
  { filename: 'batch-definitions.json', label: 'Round 2 (batch formation)' },
];

export function runStatus(flags: StatusFlags): number {
  const projectRoot = resolveProjectRoot(flags.projectRoot);
  const pcdDir = pcdPath(projectRoot);

  const statusPath = join(pcdDir, 'pipeline-status.json');
  if (existsSync(statusPath)) {
    return emitExistingStatus(statusPath);
  }

  return emitArtifactReport(pcdDir);
}

function emitExistingStatus(statusPath: string): number {
  const status = JSON.parse(readFileSync(statusPath, 'utf8')) as {
    rounds?: Record<string, unknown>;
  };
  console.log(JSON.stringify(status, null, 2));

  console.error('Pipeline status:');
  const rounds = status.rounds ?? {};
  for (const roundName of Object.keys(rounds).sort()) {
    const roundData = rounds[roundName];
    if (roundData !== null && typeof roundData === 'object' && !Array.isArray(roundData)) {
      const state =
        (roundData as Record<string, unknown>).status !== undefined
          ? String((roundData as Record<string, unknown>).status)
          : 'unknown';
      console.error(`  ${roundName}: ${state}`);
    } else {
      console.error(`  ${roundName}: ${String(roundData)}`);
    }
  }
  return 0;
}

function emitArtifactReport(pcdDir: string): number {
  const found: Record<string, string> = {};
  const missing: Record<string, string> = {};
  for (const { filename, label } of ARTIFACTS) {
    const artifactPath = join(pcdDir, filename);
    if (existsSync(artifactPath)) {
      found[filename] = label;
    } else {
      missing[filename] = label;
    }
  }

  const report = { found, missing };
  console.log(JSON.stringify(report, null, 2));

  console.error('No pipeline-status.json found. Artifact check:');
  for (const { filename, label } of ARTIFACTS) {
    const marker = filename in found ? 'OK' : 'MISSING';
    console.error(`  [${marker}] ${label} (${filename})`);
  }
  return 0;
}
