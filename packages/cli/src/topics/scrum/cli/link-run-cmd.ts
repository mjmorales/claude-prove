/**
 * `prove scrum link-run <task-id> <run-path> [--branch B] [--slug G]
 *                        [--workspace-root W]`
 *
 * Retroactively link an orchestrator run to a scrum task. Used for
 * orphaned runs that predate Task 4's hook-driven auto-linkage.
 *
 * Stdout: JSON `{ linked: true, task_id, run_path, branch, slug }`
 * Stderr: one-line human summary
 *
 * Exit codes:
 *   0  success
 *   1  missing positional args, unknown task, or invariant violation
 */

import { join } from 'node:path';
import { mainWorktreeRoot } from '@claude-prove/shared';
import { openScrumStore } from '../store';

export interface LinkRunCmdFlags {
  branch?: string;
  slug?: string;
  workspaceRoot?: string;
}

export function runLinkRunCmd(
  taskId: string | undefined,
  runPath: string | undefined,
  flags: LinkRunCmdFlags,
): number {
  if (taskId === undefined || taskId.length === 0) {
    process.stderr.write('scrum link-run: <task-id> positional argument required\n');
    return 1;
  }
  if (runPath === undefined || runPath.length === 0) {
    process.stderr.write('scrum link-run: <run-path> positional argument required\n');
    return 1;
  }

  const workspaceRoot =
    flags.workspaceRoot && flags.workspaceRoot.length > 0
      ? flags.workspaceRoot
      : (mainWorktreeRoot() ?? process.cwd());
  const store = openScrumStore({ override: join(workspaceRoot, '.prove', 'prove.db') });
  try {
    store.linkRun({
      taskId,
      runPath,
      branch: flags.branch ?? null,
      slug: flags.slug ?? null,
    });
    const payload = {
      linked: true,
      task_id: taskId,
      run_path: runPath,
      branch: flags.branch ?? null,
      slug: flags.slug ?? null,
    };
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    process.stderr.write(`scrum link-run: ${taskId} -> ${runPath}\n`);
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`scrum link-run: ${msg}\n`);
    return 1;
  } finally {
    store.close();
  }
}
