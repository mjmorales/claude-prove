/**
 * `claude-prove scrum tag <action> [args]`
 *
 * Action dispatch:
 *   add <task-id> <tag>
 *   remove <task-id> <tag>
 *   list [--task <id>] [--tag <tag>]     (lists tags for a task OR tasks for a tag)
 *
 * Exit codes:
 *   0  success
 *   1  usage error, unknown action
 */

import { join } from 'node:path';
import { mainWorktreeRoot } from '@claude-prove/shared';
import { type ScrumStore, openScrumStore } from '../store';

export interface TagCmdFlags {
  task?: string;
  tag?: string;
  workspaceRoot?: string;
}

export type TagAction = 'add' | 'remove' | 'list';

const TAG_ACTIONS: TagAction[] = ['add', 'remove', 'list'];

export function runTagCmd(
  action: string,
  positional: (string | undefined)[],
  flags: TagCmdFlags,
): number {
  if (!isTagAction(action)) {
    process.stderr.write(
      `error: unknown tag action '${action}'. expected one of: ${TAG_ACTIONS.join(', ')}\n`,
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
      case 'add':
        return doAdd(store, positional[0], positional[1]);
      case 'remove':
        return doRemove(store, positional[0], positional[1]);
      case 'list':
        return doList(store, flags);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`scrum tag ${action}: ${msg}\n`);
    return 1;
  } finally {
    store.close();
  }
}

function isTagAction(value: string): value is TagAction {
  return (TAG_ACTIONS as string[]).includes(value);
}

function doAdd(store: ScrumStore, taskId: string | undefined, tag: string | undefined): number {
  if (taskId === undefined || taskId.length === 0 || tag === undefined || tag.length === 0) {
    process.stderr.write('scrum tag add: <task-id> and <tag> positional arguments required\n');
    return 1;
  }
  store.addTag(taskId, tag);
  process.stdout.write(`${JSON.stringify({ added: true, task_id: taskId, tag })}\n`);
  process.stderr.write(`scrum tag add: ${taskId} += ${tag}\n`);
  return 0;
}

function doRemove(store: ScrumStore, taskId: string | undefined, tag: string | undefined): number {
  if (taskId === undefined || taskId.length === 0 || tag === undefined || tag.length === 0) {
    process.stderr.write('scrum tag remove: <task-id> and <tag> positional arguments required\n');
    return 1;
  }
  store.removeTag(taskId, tag);
  process.stdout.write(`${JSON.stringify({ removed: true, task_id: taskId, tag })}\n`);
  process.stderr.write(`scrum tag remove: ${taskId} -= ${tag}\n`);
  return 0;
}

function doList(store: ScrumStore, flags: TagCmdFlags): number {
  if (flags.task !== undefined && flags.task.length > 0) {
    const rows = store.listTagsForTask(flags.task);
    process.stdout.write(`${JSON.stringify(rows)}\n`);
    process.stderr.write(`scrum tag list: ${rows.length} tags on ${flags.task}\n`);
    return 0;
  }
  if (flags.tag !== undefined && flags.tag.length > 0) {
    const rows = store.listTasksForTag(flags.tag);
    process.stdout.write(`${JSON.stringify(rows)}\n`);
    process.stderr.write(`scrum tag list: ${rows.length} tasks for tag '${flags.tag}'\n`);
    return 0;
  }
  process.stderr.write('scrum tag list: --task or --tag is required\n');
  return 1;
}
