/**
 * Register the `scrum` topic on the cac instance.
 *
 * Subcommand surface (agents and operators hit the same CLI):
 *
 *   claude-prove scrum init
 *   claude-prove scrum status                    [--human]
 *   claude-prove scrum next-ready                [--limit N] [--milestone M] [--human]
 *   claude-prove scrum task create               --title X [--description Y] [--milestone M] [--id I]
 *   claude-prove scrum task show <id>
 *   claude-prove scrum task list                 [--status S] [--milestone M] [--tag T]
 *   claude-prove scrum task tag <id> <tag>
 *   claude-prove scrum task link-decision <id> <decision-path>
 *   claude-prove scrum task status <id> <new-status>
 *   claude-prove scrum task delete <id>
 *   claude-prove scrum alerts                    [--human] [--stalled-after-days N]
 *   claude-prove scrum milestone create          --title X [--description Y] [--target-state S] [--id I]
 *   claude-prove scrum milestone list            [--status S]
 *   claude-prove scrum milestone show <id>
 *   claude-prove scrum milestone activate <id>
 *   claude-prove scrum milestone reopen <id>
 *   claude-prove scrum milestone close <id>
 *   claude-prove scrum tag add <task-id> <tag>
 *   claude-prove scrum tag remove <task-id> <tag>
 *   claude-prove scrum tag list                  [--task <id>] [--tag <tag>]
 *   claude-prove scrum decision record <path>
 *   claude-prove scrum decision get <id>
 *   claude-prove scrum decision list             [--topic T] [--status S] [--human]
 *   claude-prove scrum decision recover          --from-git
 *   claude-prove scrum link-run <task-id> <run-path> [--branch B] [--slug G]
 *   claude-prove scrum hook <event>              (event: session-start | subagent-stop | stop)
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
import { runAlertsCmd } from './scrum/cli/alerts-cmd';
import { runDecisionCmd } from './scrum/cli/decision-cmd';
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
  | 'alerts'
  | 'task'
  | 'milestone'
  | 'tag'
  | 'decision'
  | 'link-run'
  | 'hook';

const SCRUM_ACTIONS: ScrumAction[] = [
  'init',
  'status',
  'next-ready',
  'alerts',
  'task',
  'milestone',
  'tag',
  'decision',
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
  topic?: string;
  targetState?: string;
  branch?: string;
  slug?: string;
  unassign?: boolean;
  stalledAfterDays?: number | string;
  fromGit?: boolean;
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
    .option('--topic <t>', 'Topic filter for `decision list`')
    .option('--target-state <s>', 'Milestone target state (milestone create)')
    .option('--branch <b>', 'Branch name for link-run')
    .option('--slug <g>', 'Run slug for link-run')
    .option('--unassign', 'Clear milestone_id (scrum task move)')
    .option('--stalled-after-days <n>', 'Alerts: stalled WIP threshold in days (default: 7)')
    .option('--from-git', 'decision recover: scan git history for .prove/decisions/*.md blobs')
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

    case 'alerts':
      return runAlertsCmd({
        human: flags.human,
        stalledAfterDays: flags.stalledAfterDays,
        workspaceRoot: flags.workspaceRoot,
      });

    case 'task':
      if (arg1 === undefined) {
        console.error(
          'error: scrum task: sub-action required (one of: create | show | list | tag | link-decision | status | move | delete)',
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
        unassign: flags.unassign,
        workspaceRoot: flags.workspaceRoot,
      });

    case 'milestone':
      if (arg1 === undefined) {
        console.error(
          'error: scrum milestone: sub-action required (one of: create | list | show | close | activate | reopen)',
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

    case 'decision':
      if (arg1 === undefined) {
        console.error(
          'error: scrum decision: sub-action required (one of: record | get | list | recover)',
        );
        return 1;
      }
      return runDecisionCmd(arg1, [arg2, arg3], {
        topic: flags.topic,
        status: flags.status,
        human: flags.human,
        fromGit: flags.fromGit,
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
