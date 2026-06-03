/**
 * `run-state migrate [--runs-root DIR] [--dry-run] [--overwrite]`
 *
 * Delegates to `migrate.ts::migrateAll` and prints one line per run
 * directory plus a trailing summary.
 */

import { migrateAll } from '../migrate';
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
  const processed = results.length - failures.length;
  console.log(`\n${processed} processed, ${failures.length} failed`);
  return failures.length > 0 ? 1 : 0;
}
