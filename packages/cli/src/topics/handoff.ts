/**
 * Register the `handoff` topic on the cac instance.
 *
 * Replaces the former `gather-context.sh` script: emit a deterministic
 * session-handoff context document (git state + prove artifacts + discovery +
 * task-plan steps) as markdown on stdout. No LLM calls.
 *
 *   claude-prove handoff gather --project-root <p> [--plugin-dir <d>]
 *
 * Exit codes:
 *   0  success
 *   1  unknown action or missing --project-root
 */

import type { CAC } from 'cac';
import { runGather } from './handoff/gather';

interface HandoffFlags {
  projectRoot?: string;
  pluginDir?: string;
}

export function register(cli: CAC): void {
  cli
    .command('handoff <action>', 'Session-handoff context (action: gather)')
    .option('--project-root <p>', 'Project root to gather context from')
    .option('--plugin-dir <d>', 'Plugin dir (enables the Discovery section)')
    .action((action: string, flags: HandoffFlags) => {
      if (action !== 'gather') {
        console.error(`error: unknown handoff action '${action}'. expected: gather`);
        process.exit(1);
      }
      if (!flags.projectRoot || flags.projectRoot.length === 0) {
        console.error('error: handoff gather: --project-root is required');
        process.exit(1);
      }
      process.exit(runGather({ projectRoot: flags.projectRoot, pluginDir: flags.pluginDir }));
    });
}
