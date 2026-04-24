/**
 * `prove scrum task <action> [args] [flags]`
 *
 * Action dispatch:
 *   create         --title X [--description Y] [--milestone M] [--id I]
 *   show <id>
 *   list           [--status S] [--milestone M] [--tag T]
 *   tag <id> <tag>
 *   link-decision <id> <decision-path>
 *
 * Stdout contract: JSON result per action on stdout; one-line human
 * summary on stderr. The `list` action returns a JSON array.
 *
 * Exit codes:
 *   0  success
 *   1  usage error, unknown action, or domain invariant violation
 */

import { join } from 'node:path';
import { mainWorktreeRoot } from '@claude-prove/shared';
import type { ListTasksOptions, ScrumStore } from '../store';
import { openScrumStore } from '../store';
import type { TaskStatus } from '../types';
import { generateId } from './scrum-utils';

export interface TaskCmdFlags {
  title?: string;
  description?: string;
  milestone?: string;
  id?: string;
  status?: string;
  tag?: string;
  workspaceRoot?: string;
}

export type TaskAction = 'create' | 'show' | 'list' | 'tag' | 'link-decision';

const TASK_ACTIONS: TaskAction[] = ['create', 'show', 'list', 'tag', 'link-decision'];

const VALID_STATUSES: TaskStatus[] = [
  'backlog',
  'ready',
  'in_progress',
  'review',
  'blocked',
  'done',
  'cancelled',
];

export function runTaskCmd(
  action: string,
  positional: (string | undefined)[],
  flags: TaskCmdFlags,
): number {
  if (!isTaskAction(action)) {
    process.stderr.write(
      `error: unknown task action '${action}'. expected one of: ${TASK_ACTIONS.join(', ')}\n`,
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
      case 'show':
        return doShow(store, positional[0]);
      case 'list':
        return doList(store, flags);
      case 'tag':
        return doTag(store, positional[0], positional[1]);
      case 'link-decision':
        return doLinkDecision(store, positional[0], positional[1]);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`scrum task ${action}: ${msg}\n`);
    return 1;
  } finally {
    store.close();
  }
}

function isTaskAction(value: string): value is TaskAction {
  return (TASK_ACTIONS as string[]).includes(value);
}

function doCreate(store: ScrumStore, flags: TaskCmdFlags): number {
  if (flags.title === undefined || flags.title.length === 0) {
    process.stderr.write('scrum task create: --title is required\n');
    return 1;
  }
  const id =
    flags.id !== undefined && flags.id.length > 0 ? flags.id : generateId(flags.title, 'task');
  const milestoneId =
    flags.milestone !== undefined && flags.milestone.length > 0 ? flags.milestone : null;
  const task = store.createTask({
    id,
    title: flags.title,
    description: flags.description ?? null,
    milestoneId,
  });
  process.stdout.write(`${JSON.stringify(task)}\n`);
  process.stderr.write(`scrum task create: ${task.id}\n`);
  return 0;
}

function doShow(store: ScrumStore, id: string | undefined): number {
  if (id === undefined || id.length === 0) {
    process.stderr.write('scrum task show: <id> positional argument required\n');
    return 1;
  }
  const task = store.getTask(id);
  if (task === null) {
    process.stderr.write(`scrum task show: task '${id}' not found\n`);
    return 1;
  }
  const tags = store.listTagsForTask(id);
  const events = store.listEventsForTask(id, 50);
  const runs = store.listRunsForTask(id);
  process.stdout.write(`${JSON.stringify({ task, tags, events, runs })}\n`);
  process.stderr.write(`scrum task show: ${id} (${task.status})\n`);
  return 0;
}

function doList(store: ScrumStore, flags: TaskCmdFlags): number {
  const options: ListTasksOptions = {};
  if (flags.status !== undefined && flags.status.length > 0) {
    if (!VALID_STATUSES.includes(flags.status as TaskStatus)) {
      process.stderr.write(
        `scrum task list: unknown --status '${flags.status}'. expected one of: ${VALID_STATUSES.join(', ')}\n`,
      );
      return 1;
    }
    options.status = flags.status as TaskStatus;
  }
  if (flags.milestone !== undefined && flags.milestone.length > 0) {
    options.milestoneId = flags.milestone;
  }

  // --tag narrows the list via listTasksForTag then applies additional
  // filters client-side. Rare combo, but honoring --tag + --status is the
  // least-surprise path.
  let tasks =
    flags.tag !== undefined && flags.tag.length > 0
      ? store.listTasksForTag(flags.tag)
      : store.listTasks(options);

  if (flags.tag !== undefined && flags.tag.length > 0) {
    if (options.status !== undefined) tasks = tasks.filter((t) => t.status === options.status);
    if (options.milestoneId !== undefined) {
      tasks = tasks.filter((t) => t.milestone_id === options.milestoneId);
    }
  }

  process.stdout.write(`${JSON.stringify(tasks)}\n`);
  process.stderr.write(`scrum task list: ${tasks.length} tasks\n`);
  return 0;
}

function doTag(store: ScrumStore, id: string | undefined, tag: string | undefined): number {
  if (id === undefined || id.length === 0 || tag === undefined || tag.length === 0) {
    process.stderr.write('scrum task tag: <id> and <tag> positional arguments required\n');
    return 1;
  }
  store.addTag(id, tag);
  // Stdout contract matches `scrum tag add` (`{added: true, task_id, tag}`)
  // so downstream consumers can parse either entry point identically.
  process.stdout.write(`${JSON.stringify({ added: true, task_id: id, tag })}\n`);
  process.stderr.write(`scrum task tag: ${id} += ${tag}\n`);
  return 0;
}

function doLinkDecision(
  store: ScrumStore,
  id: string | undefined,
  decisionPath: string | undefined,
): number {
  if (
    id === undefined ||
    id.length === 0 ||
    decisionPath === undefined ||
    decisionPath.length === 0
  ) {
    process.stderr.write(
      'scrum task link-decision: <id> and <decision-path> positional arguments required\n',
    );
    return 1;
  }
  if (store.getTask(id) === null) {
    process.stderr.write(`scrum task link-decision: unknown task '${id}'\n`);
    return 1;
  }
  const eventId = store.appendEvent({
    taskId: id,
    kind: 'decision_linked',
    payload: { decision_path: decisionPath },
  });
  process.stdout.write(
    `${JSON.stringify({ linked: true, task_id: id, decision_path: decisionPath, event_id: eventId })}\n`,
  );
  process.stderr.write(`scrum task link-decision: ${id} -> ${decisionPath}\n`);
  return 0;
}

