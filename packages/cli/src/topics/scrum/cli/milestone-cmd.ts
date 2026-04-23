/**
 * `prove scrum milestone <action> [args] [flags]`
 *
 * Action dispatch:
 *   create --title X [--description Y] [--target-state S] [--id I]
 *   list   [--status planned|active|closed]
 *   show <id>
 *   close <id>
 *
 * Exit codes:
 *   0  success
 *   1  usage error, unknown action, or missing milestone
 */

import { join } from 'node:path';
import { mainWorktreeRoot } from '@claude-prove/shared';
import { type ScrumStore, openScrumStore } from '../store';
import type { MilestoneStatus } from '../types';

export interface MilestoneCmdFlags {
  title?: string;
  description?: string;
  targetState?: string;
  id?: string;
  status?: string;
  workspaceRoot?: string;
}

export type MilestoneAction = 'create' | 'list' | 'show' | 'close';

const MILESTONE_ACTIONS: MilestoneAction[] = ['create', 'list', 'show', 'close'];
const VALID_STATUSES: MilestoneStatus[] = ['planned', 'active', 'closed'];

export function runMilestoneCmd(
  action: string,
  positional: (string | undefined)[],
  flags: MilestoneCmdFlags,
): number {
  if (!isMilestoneAction(action)) {
    process.stderr.write(
      `error: unknown milestone action '${action}'. expected one of: ${MILESTONE_ACTIONS.join(', ')}\n`,
    );
    return 1;
  }

  const workspaceRoot =
    flags.workspaceRoot && flags.workspaceRoot.length > 0
      ? flags.workspaceRoot
      : (mainWorktreeRoot() ?? process.cwd());
  const store = openScrumStore({ override: join(workspaceRoot, '.prove', 'prove.db') });
  try {
    switch (action) {
      case 'create':
        return doCreate(store, flags);
      case 'list':
        return doList(store, flags);
      case 'show':
        return doShow(store, positional[0]);
      case 'close':
        return doClose(store, positional[0]);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`scrum milestone ${action}: ${msg}\n`);
    return 1;
  } finally {
    store.close();
  }
}

function isMilestoneAction(value: string): value is MilestoneAction {
  return (MILESTONE_ACTIONS as string[]).includes(value);
}

function doCreate(store: ScrumStore, flags: MilestoneCmdFlags): number {
  if (flags.title === undefined || flags.title.length === 0) {
    process.stderr.write('scrum milestone create: --title is required\n');
    return 1;
  }
  const id = flags.id !== undefined && flags.id.length > 0 ? flags.id : generateId(flags.title);
  const milestone = store.createMilestone({
    id,
    title: flags.title,
    description: flags.description ?? null,
    targetState: flags.targetState ?? null,
  });
  process.stdout.write(`${JSON.stringify(milestone)}\n`);
  process.stderr.write(`scrum milestone create: ${milestone.id}\n`);
  return 0;
}

function doList(store: ScrumStore, flags: MilestoneCmdFlags): number {
  let status: MilestoneStatus | undefined;
  if (flags.status !== undefined && flags.status.length > 0) {
    if (!VALID_STATUSES.includes(flags.status as MilestoneStatus)) {
      process.stderr.write(
        `scrum milestone list: unknown --status '${flags.status}'. expected one of: ${VALID_STATUSES.join(', ')}\n`,
      );
      return 1;
    }
    status = flags.status as MilestoneStatus;
  }
  const rows = store.listMilestones(status);
  process.stdout.write(`${JSON.stringify(rows)}\n`);
  process.stderr.write(`scrum milestone list: ${rows.length} milestones\n`);
  return 0;
}

function doShow(store: ScrumStore, id: string | undefined): number {
  if (id === undefined || id.length === 0) {
    process.stderr.write('scrum milestone show: <id> positional argument required\n');
    return 1;
  }
  const milestone = store.getMilestone(id);
  if (milestone === null) {
    process.stderr.write(`scrum milestone show: milestone '${id}' not found\n`);
    return 1;
  }
  const tasks = store.listTasks({ milestoneId: id });
  process.stdout.write(`${JSON.stringify({ milestone, tasks })}\n`);
  process.stderr.write(
    `scrum milestone show: ${id} (${milestone.status}, ${tasks.length} tasks)\n`,
  );
  return 0;
}

function doClose(store: ScrumStore, id: string | undefined): number {
  if (id === undefined || id.length === 0) {
    process.stderr.write('scrum milestone close: <id> positional argument required\n');
    return 1;
  }
  const milestone = store.closeMilestone(id);
  process.stdout.write(`${JSON.stringify(milestone)}\n`);
  process.stderr.write(`scrum milestone close: ${id}\n`);
  return 0;
}

function generateId(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
  const suffix = Date.now().toString(36);
  return slug.length > 0 ? `${slug}-${suffix}` : `milestone-${suffix}`;
}
