/**
 * Register the `orchestrator` topic on the cac instance.
 *
 * Subcommand surface:
 *
 *   claude-prove orchestrator task-prompt   --run-dir R --task-id T --project-root P [--worktree W]
 *   claude-prove orchestrator review-prompt --run-dir R --task-id T --worktree W --base-branch B
 *
 * Both subcommands emit their prompt markdown on stdout — the orchestrator
 * SKILL.md captures it into a shell variable and hands it to the Agent call.
 * Replaces `skills/orchestrator/scripts/generate-{task,review}-prompt.sh`;
 * no sentinel+awk indirection remains.
 *
 * Exit codes:
 *   0  success
 *   1  unknown action, missing required flag, missing JSON inputs, or task id
 *      not found
 */

import type { CAC } from 'cac';
import { runReviewPrompt } from './orchestrator/review-prompt';
import { runTaskPrompt } from './orchestrator/task-prompt';

type OrchestratorAction = 'task-prompt' | 'review-prompt';

const ORCHESTRATOR_ACTIONS: OrchestratorAction[] = ['task-prompt', 'review-prompt'];

interface OrchestratorFlags {
  runDir?: string;
  taskId?: string;
  projectRoot?: string;
  worktree?: string;
  baseBranch?: string;
}

export function register(cli: CAC): void {
  cli
    .command(
      'orchestrator <action>',
      'Render orchestrator agent prompts (action: task-prompt | review-prompt)',
    )
    .option('--run-dir <r>', 'Path to .prove/runs/<branch>/<slug>/ containing plan.json + prd.json')
    .option('--task-id <t>', 'Task id from plan.json (e.g., "3")')
    .option('--project-root <p>', 'Project root for .claude/.prove.json validator lookup')
    .option('--worktree <w>', 'Worktree path (task-prompt: optional; review-prompt: required)')
    .option('--base-branch <b>', 'Review base branch for git diff (review-prompt only)')
    .action((action: string, flags: OrchestratorFlags) => {
      if (!isOrchestratorAction(action)) {
        console.error(
          `error: unknown orchestrator action '${action}'. expected one of: ${ORCHESTRATOR_ACTIONS.join(', ')}`,
        );
        process.exit(1);
      }
      const code = dispatch(action, flags);
      process.exit(code);
    });
}

function isOrchestratorAction(value: string): value is OrchestratorAction {
  return (ORCHESTRATOR_ACTIONS as string[]).includes(value);
}

function dispatch(action: OrchestratorAction, flags: OrchestratorFlags): number {
  switch (action) {
    case 'task-prompt': {
      const missing = requireFlags(flags, ['runDir', 'taskId', 'projectRoot']);
      if (missing.length > 0) {
        console.error(
          `error: orchestrator task-prompt: missing required flag(s): ${missing.join(', ')}`,
        );
        return 1;
      }
      return runTaskPrompt({
        runDir: flags.runDir as string,
        taskId: flags.taskId as string,
        projectRoot: flags.projectRoot as string,
        worktreePath: flags.worktree,
      });
    }
    case 'review-prompt': {
      const missing = requireFlags(flags, ['runDir', 'taskId', 'worktree', 'baseBranch']);
      if (missing.length > 0) {
        console.error(
          `error: orchestrator review-prompt: missing required flag(s): ${missing.join(', ')}`,
        );
        return 1;
      }
      return runReviewPrompt({
        runDir: flags.runDir as string,
        taskId: flags.taskId as string,
        worktreePath: flags.worktree as string,
        baseBranch: flags.baseBranch as string,
      });
    }
  }
}

function requireFlags(flags: OrchestratorFlags, names: (keyof OrchestratorFlags)[]): string[] {
  return names.filter((n) => !flags[n]).map((n) => `--${kebab(n)}`);
}

function kebab(s: string): string {
  return s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}
