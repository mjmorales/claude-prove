/**
 * `run-state migrate [--runs-root DIR] [--dry-run] [--overwrite]`
 *
 * Two deterministic passes over the runs root:
 *   1. Legacy markdown -> JSON conversion (`migrate.ts::migrateAll`): turns a
 *      PRD.md/TASK_PLAN.md layout into prd.json/plan.json/state.json.
 *   2. Structural `schema_version` chain (`schema-migrate.ts::migrateAllArtifacts`):
 *      version-bumps every JSON-first artifact behind `CURRENT_SCHEMA_VERSION`
 *      (e.g. a v3 plan.json -> v4). This is the structural half the `migrate-runs`
 *      content planner defers to, so the two surfaces agree on what is behind.
 *
 * Prints one line per converted/bumped run directory plus a trailing summary.
 */

import { migrateAll } from '../migrate';
import { migrateAllArtifacts } from '../schema-migrate';
import { defaultRunsRoot } from './resolve';

export interface MigrateFlags {
  runsRoot?: string;
  dryRun?: boolean;
  overwrite?: boolean;
}

export function runMigrate(flags: MigrateFlags): number {
  const runsRoot = flags.runsRoot ?? defaultRunsRoot();
  // Backstop the sweep: a single corrupt run dir (bad JSON, raw fs error,
  // MigrationError) currently throws out of migrateAll and aborts every
  // remaining run with no partial summary. Catch here so the CLI exits
  // cleanly (code 1, the documented I/O code) instead of crashing with a
  // raw stack trace. NOTE: full per-run skip-and-continue isolation lives
  // inside migrateAll (out of this file's scope); this guard converts the
  // crash into a clean error but does not yet salvage the runs already
  // processed before the throw.
  let results: ReturnType<typeof migrateAll>;
  try {
    results = migrateAll(runsRoot, {
      dryRun: flags.dryRun,
      overwrite: flags.overwrite,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`error: migration sweep failed: ${msg}`);
    return 1;
  }
  const tag = flags.dryRun ? '[dry]' : '';
  const failures: typeof results = [];
  for (const r of results) {
    if (r.error !== undefined) {
      console.error(`FAILED ${r.runDir}: ${r.error}`);
      failures.push(r);
    } else {
      console.log(
        `${tag} ${r.runDir} — prd=${r.prdWritten} plan=${r.planWritten} ` +
          `state=${r.stateWritten} tasks=${r.tasksFound} steps=${r.stepsFound}`,
      );
    }
  }

  // Pass 2: structural version-chain bump over JSON-first artifacts. Runs after
  // conversion so a freshly-converted plan.json is also brought current. A bad
  // artifact records its own per-run error without aborting the sweep.
  const versionResults = migrateAllArtifacts(runsRoot, { dryRun: flags.dryRun });
  const versionFailures: typeof versionResults = [];
  let bumpedRuns = 0;
  for (const r of versionResults) {
    if (r.error !== undefined) {
      console.error(`FAILED ${r.runDir}: ${r.error}`);
      versionFailures.push(r);
    } else if (r.bumped.length > 0) {
      bumpedRuns += 1;
      console.log(`${tag} ${r.runDir} — schema_version bumped: ${r.bumped.join(', ')}`);
    }
  }

  const processed = results.length - failures.length;
  const totalFailures = failures.length + versionFailures.length;
  console.log(`\n${processed} converted, ${bumpedRuns} version-bumped, ${totalFailures} failed`);
  return totalFailures > 0 ? 1 : 0;
}
