/**
 * `prove acb assemble [--branch B] [--base main]`
 *
 * Collapse every stored manifest on `branch` into a cumulative ACB document
 * (`assemble()`), upsert it on the branch, then drop the source manifests
 * via `clearManifests`. Mirrors `tools/acb/__main__.py::cmd_assemble` 1:1.
 *
 * Resolution order:
 *   - branch:   --branch -> currentBranch(cwd) -> 'unknown'
 *   - base:     --base   -> 'main'
 *   - baseSha:  git rev-parse <base>; exit 1 on failure
 *   - headSha:  headSha() -> exit 1 when null
 *   - root:     --workspace-root -> mainWorktreeRoot(cwd) -> process.cwd()
 *
 * Stdout/stderr contract (byte-equal to Python reference):
 *   - stdout: one-line JSON `{branch, groups, uncovered}` + '\n'
 *   - stderr: `Assembled N manifests → G intent groups`
 *             + (uncovered > 0) `  U files not covered by any manifest`
 *             + (cleared > 0)   `  Cleared C manifests from store`
 *
 * Exit codes:
 *   0  ACB document persisted (manifest count may be 0)
 *   1  base ref unresolvable, or HEAD unresolvable
 */

import { join } from 'node:path';
import { currentBranch, headSha, mainWorktreeRoot } from '@claude-prove/shared';
import { assemble } from '../assembler';
import { ensureLegacyImported } from '../importer';
import { openAcbStore } from '../store';

export interface AssembleOpts {
  branch?: string;
  base?: string;
  workspaceRoot?: string;
}

export function runAssemble(opts: AssembleOpts): number {
  const branch = opts.branch ?? currentBranch() ?? 'unknown';
  const base = opts.base ?? 'main';

  const baseSha = resolveBaseRef(base);
  if (baseSha === null) {
    process.stderr.write(`Error: cannot resolve base ref '${base}'\n`);
    return 1;
  }

  const head = headSha();
  if (head === null || head.length === 0) {
    process.stderr.write('Error: cannot resolve HEAD\n');
    return 1;
  }

  const workspaceRoot =
    opts.workspaceRoot && opts.workspaceRoot.length > 0
      ? opts.workspaceRoot
      : (mainWorktreeRoot() ?? process.cwd());

  ensureLegacyImported(workspaceRoot);

  const store = openAcbStore({ override: join(workspaceRoot, '.prove', 'prove.db') });
  let groups: number;
  let uncovered: number;
  let cleared: number;
  let manifestCount: number;
  try {
    const acb = assemble({ store, branch, baseRef: baseSha, headRef: head });
    store.saveAcb(branch, acb);
    cleared = store.clearManifests(branch);
    manifestCount = acb.manifest_count;
    groups = acb.intent_groups.length;
    uncovered = acb.uncovered_files.length;
  } finally {
    store.close();
  }

  process.stderr.write(`Assembled ${manifestCount} manifests → ${groups} intent groups\n`);
  if (uncovered > 0) {
    process.stderr.write(`  ${uncovered} files not covered by any manifest\n`);
  }
  if (cleared > 0) {
    process.stderr.write(`  Cleared ${cleared} manifests from store\n`);
  }

  process.stdout.write(`${JSON.stringify({ branch, groups, uncovered })}\n`);
  return 0;
}

/** Resolve `base` to a full SHA via `git rev-parse`; null on failure. */
function resolveBaseRef(base: string): string | null {
  const proc = Bun.spawnSync({
    cmd: ['git', 'rev-parse', base],
    stdout: 'pipe',
    stderr: 'ignore',
  });
  if (proc.exitCode !== 0) return null;
  const out = proc.stdout?.toString().trim() ?? '';
  return out.length > 0 ? out : null;
}
