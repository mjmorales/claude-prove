/**
 * Register the `worktree` topic on the cac instance.
 *
 * Replaces the former `manage-worktree.sh` script: namespaced
 * sub-task git worktrees that prevent branch/path collisions between concurrent
 * orchestrator (and `/prove:workflow`) runs.
 *
 * Subcommand surface:
 *
 *   claude-prove worktree create     <slug> <task-id> [--base <branch>]
 *   claude-prove worktree remove     <slug> <task-id>
 *   claude-prove worktree remove-all <slug>
 *   claude-prove worktree list       <slug>
 *   claude-prove worktree path       <slug> <task-id>
 *   claude-prove worktree branch     <slug> <task-id>
 *   claude-prove worktree reset      <slug> <task-id> [--base <branch>]
 *
 * Deterministic naming (identical to the retired script):
 *   path:   <root>/.claude/worktrees/<slug>-task-<task-id>
 *   branch: task/<slug>/<task-id>     (base: orchestrator/<slug>, override --base)
 *
 * Output contract (LLM-optimized):
 *   - create / path / branch / reset → the absolute worktree path on stdout
 *     (one value, no parsing — preserves `WT=$(claude-prove worktree create …)`).
 *   - list                          → JSON array of `{ task_id, path, branch }`.
 *   - remove / remove-all           → nothing on stdout.
 *   - every action                  → a one-line human summary on stderr.
 *
 * Exit codes:
 *   0  success
 *   1  usage error (unknown action, missing/invalid slug or task-id, missing base branch)
 *   2  git failure (worktree add/remove/reset returned non-zero)
 */

import type { CAC } from 'cac';
import { WORKTREE_ACTIONS, type WorktreeAction, runWorktree } from './worktree/manage';

interface WorktreeFlags {
  base?: string;
  workspaceRoot?: string;
}

export function register(cli: CAC): void {
  cli
    .command('worktree <action> [slug] [taskId]', 'Manage namespaced sub-task git worktrees')
    .option('--base <branch>', 'Base branch for create/reset (default: orchestrator/<slug>)')
    .option('--workspace-root <w>', 'Main worktree root (default: git common-dir)')
    .action(
      (
        action: string,
        slug: string | undefined,
        taskId: string | undefined,
        flags: WorktreeFlags,
      ) => {
        if (!isWorktreeAction(action)) {
          console.error(
            `error: unknown worktree action '${action}'. expected one of: ${WORKTREE_ACTIONS.join(', ')}`,
          );
          process.exit(1);
        }
        process.exit(
          runWorktree({
            action,
            slug,
            taskId,
            base: flags.base,
            workspaceRoot: flags.workspaceRoot,
          }),
        );
      },
    );
}

function isWorktreeAction(value: string): value is WorktreeAction {
  return (WORKTREE_ACTIONS as readonly string[]).includes(value);
}
