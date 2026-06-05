/**
 * `claude-prove scrum link-run <task-id> <run-path> [--branch B] [--slug G]
 *                        [--workspace-root W]`
 *
 * Retroactively link an orchestrator run to a scrum task. Used for
 * orphaned runs that predate the hook-driven auto-linkage.
 *
 * Writes the link in BOTH layers so they cannot diverge: the store run-link
 * row AND top-level `plan.task_id` in the run's plan.json (through the blessed
 * run-state writer). The reconciler reads either layer, so a single write
 * keeps both consistent. Without the plan.json half, a store-linked run would
 * re-emit unlinked_run_detected on every reconciler sweep — the orphan
 * split-brain.
 *
 * The plan write is best-effort: a missing or malformed plan.json (e.g. the
 * run-dir is gone, or the link targets a non-run path) warns but does not fail
 * the store link, because the reconciler treats the store row as authoritative.
 *
 * Stdout: JSON `{ linked: true, task_id, run_path, branch, slug, plan_updated }`
 * Stderr: one-line human summary
 *
 * Exit codes:
 *   0  success
 *   1  missing positional args, unknown task, or invariant violation
 */

import { isAbsolute, join } from 'node:path';
import { mainWorktreeRoot } from '@claude-prove/shared';
import { usageError } from '../../../core/cli/usage';
import { setPlanTaskId } from '../../run-state/state';
import { openCliStore } from './cli-store';

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
  // Both positionals are reported together via the full usage line, so the
  // operator sees <task-id> and <run-path> at once rather than discovering the
  // second only after supplying the first.
  if (
    taskId === undefined ||
    taskId.length === 0 ||
    runPath === undefined ||
    runPath.length === 0
  ) {
    return usageError(
      'scrum',
      'link-run',
      'the following arguments are required: task-id, run-path',
    );
  }

  const workspaceRoot =
    flags.workspaceRoot && flags.workspaceRoot.length > 0
      ? flags.workspaceRoot
      : (mainWorktreeRoot() ?? process.cwd());
  const store = openCliStore(workspaceRoot);
  try {
    store.linkRun({
      taskId,
      runPath,
      branch: flags.branch ?? null,
      slug: flags.slug ?? null,
    });

    // Dual-write the plan side so the reconciler reads a consistent link from
    // either layer. Best-effort: the store row is authoritative, so a plan.json
    // that cannot be written (missing run-dir, non-run path) warns and proceeds.
    const planPath = isAbsolute(runPath)
      ? join(runPath, 'plan.json')
      : join(workspaceRoot, runPath, 'plan.json');
    let planUpdated = false;
    try {
      setPlanTaskId(planPath, taskId);
      planUpdated = true;
    } catch (planErr) {
      const planMsg = planErr instanceof Error ? planErr.message : String(planErr);
      process.stderr.write(`scrum link-run: warning — plan.task_id not written: ${planMsg}\n`);
    }

    const payload = {
      linked: true,
      task_id: taskId,
      run_path: runPath,
      branch: flags.branch ?? null,
      slug: flags.slug ?? null,
      plan_updated: planUpdated,
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
