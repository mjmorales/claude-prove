/**
 * `run-state migrate-runs [--runs-root DIR] [--branch B] [--slug S]`
 *
 * The MECHANICAL half of on-demand run-content migration. Detects which run
 * artifacts sit behind the current schema and emits a content-migration plan —
 * the target artifacts plus the instruction file for each content-reshaping
 * hop. It NEVER calls a model and NEVER rewrites content; that is the
 * `run-migrate` skill's job, run by the operator's session on explicit
 * invocation. There is no background or resident migration loop.
 *
 * This composes with — does not replace — the deterministic `schema migrate`
 * chain. That chain handles structural column moves (version bumps, a string
 * promoted to `{ text }`); this surface covers only the content reshaping a
 * model must do beyond those moves (rewriting stored prose or findings to fit a
 * new shape). Run `schema migrate` for the structural part; run this to learn
 * what content the operator must drive a model through.
 *
 * The command is always read-only — it lists/plans, never mutates. Selection:
 *   - default            scan every run under the resolved runs-root
 *   - --branch / --slug  narrow to a single run directory
 *
 * Stdout/stderr contract:
 *   - stdout: machine-readable JSON migration plan (consumed by the skill)
 *   - stderr: one-line human summary
 *
 * Exit codes:
 *   0  success (plan emitted, whether or not anything is behind)
 *   1  usage / I/O error (bad runs-root, unreadable directory)
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type MigrationPlan, planContentMigration } from '../content-migrate';
import { defaultRunsRoot } from './resolve';

export interface MigrateRunsFlags {
  runsRoot?: string;
  branch?: string;
  slug?: string;
}

/** The JSON-first run artifacts that mark a directory as a run dir. */
const RUN_MARKERS = ['plan.json', 'prd.json', 'state.json', 'log'] as const;

export function runMigrateRuns(flags: MigrateRunsFlags): number {
  const runsRoot = resolve(flags.runsRoot ?? defaultRunsRoot());

  let runDirs: string[];
  try {
    runDirs = discoverRunDirs(runsRoot, flags.branch, flags.slug);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: cannot scan runs root ${runsRoot}: ${msg}\n`);
    return 1;
  }

  const plan: MigrationPlan = planContentMigration(runDirs);

  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  process.stderr.write(summarize(plan));
  return 0;
}

/**
 * Discover JSON-first run directories under `runsRoot`. A run dir is
 * `<runsRoot>/<branch>/<slug>/` containing any run marker. When `branch`/`slug`
 * are given, narrows to that single directory; otherwise sweeps every branch.
 */
function discoverRunDirs(runsRoot: string, branch?: string, slug?: string): string[] {
  if (!existsSync(runsRoot)) return [];

  if (branch && slug) {
    const dir = join(runsRoot, branch, slug);
    return isRunDir(dir) ? [dir] : [];
  }

  const out: string[] = [];
  const branches = branch ? [branch] : listDirs(runsRoot);
  for (const b of branches) {
    const branchDir = join(runsRoot, b);
    for (const s of listDirs(branchDir)) {
      const dir = join(branchDir, s);
      if (isRunDir(dir)) out.push(dir);
    }
  }
  return out;
}

/** Immediate subdirectory names of `dir`, sorted; empty when `dir` is absent. */
function listDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => {
      try {
        return statSync(join(dir, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

/** True when `dir` holds any JSON-first run marker. */
function isRunDir(dir: string): boolean {
  return RUN_MARKERS.some((marker) => existsSync(join(dir, marker)));
}

/** One-line stderr summary of the emitted plan. */
function summarize(plan: MigrationPlan): string {
  if (plan.artifactsBehind === 0) {
    return `All run artifacts current (schema v${plan.currentVersion}); nothing to migrate.\n`;
  }
  return (
    `${plan.runs.length} run(s) behind v${plan.currentVersion}: ${plan.artifactsBehind} artifact(s) behind, ` +
    `${plan.artifactsNeedingContent} need model-driven content reshaping (the rest are structural — run \`schema migrate\`).\n`
  );
}
