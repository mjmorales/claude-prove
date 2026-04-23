/**
 * Register the `scrum` topic on the cac instance.
 *
 * Subcommand surface (agents and operators hit the same CLI):
 *
 *   prove scrum init
 *   prove scrum status                    [--human]
 *   prove scrum next-ready                [--limit N] [--milestone M] [--human]
 *   prove scrum task create               --title X [--description Y] [--milestone M] [--id I]
 *   prove scrum task show <id>
 *   prove scrum task list                 [--status S] [--milestone M] [--tag T]
 *   prove scrum task tag <id> <tag>
 *   prove scrum task link-decision <id> <decision-path>
 *   prove scrum milestone create          --title X [--description Y] [--target-state S] [--id I]
 *   prove scrum milestone list            [--status S]
 *   prove scrum milestone show <id>
 *   prove scrum milestone close <id>
 *   prove scrum tag add <task-id> <tag>
 *   prove scrum tag remove <task-id> <tag>
 *   prove scrum tag list                  [--task <id>] [--tag <tag>]
 *   prove scrum link-run <task-id> <run-path> [--branch B] [--slug G]
 *   prove scrum hook <event>              (event: session-start | subagent-stop | stop)
 *
 * All subcommands accept `--workspace-root W` (default: git common-dir via
 * mainWorktreeRoot(), falling back to process.cwd()).
 *
 * Stdout/stderr split (byte-equal across every handler):
 *   - stdout: JSON (machine-readable), or a human table when `--human` is set
 *   - stderr: one-line human summary
 *
 * Exit codes:
 *   0  success
 *   1  usage error, unknown action/event, parse error, or invariant violation
 */

import type { CAC } from 'cac';
import { runHookCmd } from './scrum/cli/hook-cmd';
import { runInitCmd } from './scrum/cli/init-cmd';
import { runLinkRunCmd } from './scrum/cli/link-run-cmd';
import { runMilestoneCmd } from './scrum/cli/milestone-cmd';
import { runNextReadyCmd } from './scrum/cli/next-ready-cmd';
import { runStatusCmd } from './scrum/cli/status-cmd';
import { runTagCmd } from './scrum/cli/tag-cmd';
import { runTaskCmd } from './scrum/cli/task-cmd';

type ScrumAction =
  | 'init'
  | 'status'
  | 'next-ready'
  | 'task'
  | 'milestone'
  | 'tag'
  | 'link-run'
  | 'hook';

const SCRUM_ACTIONS: ScrumAction[] = [
  'init',
  'status',
  'next-ready',
  'task',
  'milestone',
  'tag',
  'link-run',
  'hook',
];

interface ScrumFlags {
  human?: boolean;
  limit?: number | string;
  milestone?: string;
  title?: string;
  description?: string;
  id?: string;
  status?: string;
  tag?: string;
  task?: string;
  targetState?: string;
  branch?: string;
  slug?: string;
  workspaceRoot?: string;
}

export function register(cli: CAC): void {
  cli
    .command('scrum <action> [arg1] [arg2] [arg3]', 'Agentic task management')
    .option('--human', 'Emit a human-readable table instead of JSON')
    .option('--limit <n>', 'Max rows for next-ready (default: 10)')
    .option('--milestone <id>', 'Milestone filter or foreign key')
    .option('--title <t>', 'Task or milestone title (create actions)')
    .option('--description <d>', 'Task or milestone description')
    .option('--id <id>', 'Explicit id (create actions; default: generated from title)')
    .option('--status <s>', 'Status filter (list / close / create)')
    .option('--tag <t>', 'Tag filter')
    .option('--task <id>', 'Task filter for `tag list`')
    .option('--target-state <s>', 'Milestone target state (milestone create)')
    .option('--branch <b>', 'Branch name for link-run')
    .option('--slug <g>', 'Run slug for link-run')
    .option(
      '--workspace-root <w>',
      'Main worktree root; pins store to <root>/.prove/prove.db (default: git common-dir)',
    )
    .action(
      (
        action: string,
        arg1: string | undefined,
        arg2: string | undefined,
        arg3: string | undefined,
        flags: ScrumFlags,
      ) => {
        if (!isScrumAction(action)) {
          console.error(
            `error: unknown scrum action '${action}'. expected one of: ${SCRUM_ACTIONS.join(', ')}`,
          );
          process.exit(1);
        }
        const code = dispatch(action, arg1, arg2, arg3, flags);
        process.exit(code);
      },
    );
}

function isScrumAction(value: string): value is ScrumAction {
  return (SCRUM_ACTIONS as string[]).includes(value);
}

function dispatch(
  action: ScrumAction,
  arg1: string | undefined,
  arg2: string | undefined,
  arg3: string | undefined,
  flags: ScrumFlags,
): number {
  switch (action) {
    case 'init':
      return runInitCmd({ workspaceRoot: flags.workspaceRoot });

    case 'status':
      return runStatusCmd({ human: flags.human, workspaceRoot: flags.workspaceRoot });

    case 'next-ready':
      return runNextReadyCmd({
        limit: flags.limit,
        milestone: flags.milestone,
        human: flags.human,
        workspaceRoot: flags.workspaceRoot,
      });

    case 'task':
      if (arg1 === undefined) {
        console.error(
          'error: scrum task: sub-action required (one of: create | show | list | tag | link-decision)',
        );
        return 1;
      }
      return runTaskCmd(arg1, [arg2, arg3], {
        title: flags.title,
        description: flags.description,
        milestone: flags.milestone,
        id: flags.id,
        status: flags.status,
        tag: flags.tag,
        workspaceRoot: flags.workspaceRoot,
      });

    case 'milestone':
      if (arg1 === undefined) {
        console.error(
          'error: scrum milestone: sub-action required (one of: create | list | show | close)',
        );
        return 1;
      }
      return runMilestoneCmd(arg1, [arg2, arg3], {
        title: flags.title,
        description: flags.description,
        targetState: flags.targetState,
        id: flags.id,
        status: flags.status,
        workspaceRoot: flags.workspaceRoot,
      });

    case 'tag':
      if (arg1 === undefined) {
        console.error('error: scrum tag: sub-action required (one of: add | remove | list)');
        return 1;
      }
      return runTagCmd(arg1, [arg2, arg3], {
        task: flags.task,
        tag: flags.tag,
        workspaceRoot: flags.workspaceRoot,
      });

    case 'link-run':
      return runLinkRunCmd(arg1, arg2, {
        branch: flags.branch,
        slug: flags.slug,
        workspaceRoot: flags.workspaceRoot,
      });

    case 'hook':
      if (arg1 === undefined) {
        console.error(
          'error: scrum hook: event required (one of: session-start | subagent-stop | stop)',
        );
        return 1;
      }
      return runHookCmd(arg1, { workspaceRoot: flags.workspaceRoot });
  }
}
