/**
 * `run-state migrate [--runs-root DIR] [--dry-run] [--overwrite]`
 *
 * Mirrors Python `cmd_migrate`. Delegates to `migrate.ts::migrateAll` and
 * prints one line per run directory plus a trailing summary.
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
  const results = migrateAll(runsRoot, {
    dryRun: flags.dryRun,
    overwrite: flags.overwrite,
  });
  const tag = flags.dryRun ? '[dry]' : '';
  for (const r of results) {
    console.log(
      `${tag} ${r.runDir} — prd=${r.prdWritten} plan=${r.planWritten} ` +
        `state=${r.stateWritten} tasks=${r.tasksFound} steps=${r.stepsFound}`,
    );
  }
  console.log(`\n${results.length} runs processed`);
  return 0;
}
