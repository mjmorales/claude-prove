/**
 * `claude-prove scrum task <action> [args] [flags]`
 *
 * Action dispatch:
 *   create         --title X [--description Y] [--milestone M] [--id I]
 *   show <id>
 *   list           [--status S] [--milestone M] [--tag T]
 *   tag <id> <tag>
 *   link-decision <id> <decision-path>
 *   status <id> <new-status>
 *   move <id>      (--milestone M | --unassign | --milestone="")
 *   delete <id>
 *   add-dep <from> <to>     [--kind blocks|blocked_by]   (default: blocks)
 *   remove-dep <from> <to>  [--kind blocks|blocked_by]   (default: blocks)
 *   acceptance add <id>     --text T --verifies-by K --check C [--idempotent]
 *                                                     [--timeout 30s] [--criterion ID]
 *   acceptance list <id>
 *   acceptance supersede <id> --criterion ID --reason R [--by NEW-ID]
 *
 * Stdout contract: JSON result per action on stdout; one-line human
 * summary on stderr. The `list` action returns a JSON array. The `show`
 * action's JSON additively carries `blocked_by` and `blocking` arrays
 * (pulled from `scrum_deps` with `kind='blocks'`).
 *
 * Exit codes:
 *   0  success
 *   1  usage error, unknown action, or domain invariant violation
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { mainWorktreeRoot } from '@claude-prove/shared';
import type { ListTasksOptions, ScrumStore } from '../store';
import { openScrumStore } from '../store';
import type { AcceptanceCriterion, AcceptanceVerifiesBy, DepKind, TaskStatus } from '../types';
import { parseDecisionFile } from './decision-cmd';
import { generateId } from './scrum-utils';

export interface TaskCmdFlags {
  title?: string;
  description?: string;
  milestone?: string;
  id?: string;
  status?: string;
  tag?: string;
  unassign?: boolean;
  kind?: string;
  workspaceRoot?: string;
  // `acceptance` sub-action flags (v5).
  text?: string;
  verifiesBy?: string;
  check?: string;
  idempotent?: boolean;
  timeout?: string;
  criterion?: string;
  reason?: string;
  by?: string;
}

export type TaskAction =
  | 'create'
  | 'show'
  | 'list'
  | 'tag'
  | 'link-decision'
  | 'status'
  | 'move'
  | 'delete'
  | 'add-dep'
  | 'remove-dep'
  | 'acceptance';

const TASK_ACTIONS: TaskAction[] = [
  'create',
  'show',
  'list',
  'tag',
  'link-decision',
  'status',
  'move',
  'delete',
  'add-dep',
  'remove-dep',
  'acceptance',
];

const VALID_DEP_KINDS: DepKind[] = ['blocks', 'blocked_by'];

const VALID_VERIFIES_BY: AcceptanceVerifiesBy[] = ['bash', 'assert', 'gate', 'agent'];

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
      case 'status':
        return doStatus(store, positional[0], positional[1]);
      case 'move':
        return doMove(store, positional[0], flags);
      case 'delete':
        return doDelete(store, positional[0]);
      case 'add-dep':
        return doAddDep(store, positional[0], positional[1], flags);
      case 'remove-dep':
        return doRemoveDep(store, positional[0], positional[1], flags);
      case 'acceptance':
        return doAcceptance(store, positional[0], positional[1], flags);
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
  // Dep edges are additive keys on the show payload so operators can
  // see the graph without a second subcommand. Storage is canonical:
  // every edge is a 'blocks' row (add-dep normalizes 'blocked_by' to its
  // inverse), so both arrays read the 'blocks' kind exclusively.
  const blocked_by = store.getBlockedBy(id);
  const blocking = store.getBlocking(id);
  process.stdout.write(`${JSON.stringify({ task, tags, events, runs, blocked_by, blocking })}\n`);
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

function doStatus(store: ScrumStore, id: string | undefined, next: string | undefined): number {
  if (id === undefined || id.length === 0 || next === undefined || next.length === 0) {
    process.stderr.write(
      'scrum task status: <id> and <new-status> positional arguments required\n',
    );
    return 1;
  }
  if (!VALID_STATUSES.includes(next as TaskStatus)) {
    process.stderr.write(
      `scrum task status: invalid status '${next}'. expected one of: ${VALID_STATUSES.join(', ')}\n`,
    );
    return 1;
  }
  const task = store.updateTaskStatus(id, next as TaskStatus);
  process.stdout.write(`${JSON.stringify(task)}\n`);
  process.stderr.write(`scrum task status: ${id} -> ${next}\n`);
  return 0;
}

function doDelete(store: ScrumStore, id: string | undefined): number {
  if (id === undefined || id.length === 0) {
    process.stderr.write('scrum task delete: <id> positional argument required\n');
    return 1;
  }
  store.softDeleteTask(id);
  process.stdout.write(`${JSON.stringify({ deleted: true, task_id: id })}\n`);
  process.stderr.write(`scrum task delete: ${id}\n`);
  return 0;
}

/**
 * Reassign a task's milestone. Target resolution:
 *   --unassign                → null (wins when combined with any --milestone)
 *   --milestone=""            → null
 *   --milestone <id>          → <id>
 *   (neither flag)            → usage error, exit 1
 *
 * Closed-milestone warning is surfaced on stderr with exit 0 preserved, so
 * operators can intentionally move tasks into a closed milestone when
 * reviving scope.
 */
function doMove(store: ScrumStore, id: string | undefined, flags: TaskCmdFlags): number {
  if (id === undefined || id.length === 0) {
    process.stderr.write('scrum task move: <id> positional argument required\n');
    return 1;
  }

  const unassignRequested = flags.unassign === true;
  const milestoneFlagProvided = flags.milestone !== undefined;

  if (!unassignRequested && !milestoneFlagProvided) {
    process.stderr.write('scrum task move: --milestone <id> or --unassign is required\n');
    return 1;
  }

  let target: string | null;
  if (unassignRequested) {
    target = null;
  } else if (flags.milestone === undefined || flags.milestone.length === 0) {
    target = null;
  } else {
    target = flags.milestone;
  }

  const task = store.updateTaskMilestone(id, target);

  if (target !== null) {
    const milestone = store.getMilestone(target);
    if (milestone?.status === 'closed') {
      process.stderr.write(`scrum task move: warning — target milestone '${target}' is closed\n`);
    }
  }

  process.stdout.write(`${JSON.stringify(task)}\n`);
  process.stderr.write(`scrum task move: ${id} -> ${target ?? 'unassigned'}\n`);
  return 0;
}

/**
 * Link a decision file to a task. Auto-records the decision in
 * `scrum_decisions` when absent so the row and the event stay in sync:
 *
 *   1. Verify the file exists at `decisionPath` (resolved against cwd).
 *   2. Look up `scrum_decisions.id` (filename slug). If missing, parse the
 *      file via `parseDecisionFile` and upsert via `store.recordDecision`.
 *   3. Append a `decision_linked` event carrying both keys:
 *      `{ decision_id, decision_path }`. Legacy path-only payloads remain
 *      readable — see `reconcile.ts::collectDecisions`.
 */
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

  const abs = isAbsolute(decisionPath) ? decisionPath : resolve(process.cwd(), decisionPath);
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    process.stderr.write(`scrum task link-decision: file not found '${decisionPath}'\n`);
    return 1;
  }

  const content = readFileSync(abs, 'utf8');
  const parsed = parseDecisionFile(content, decisionPath);
  if (store.getDecision(parsed.id) === null) {
    store.recordDecision(parsed);
  }

  const eventId = store.appendEvent({
    taskId: id,
    kind: 'decision_linked',
    payload: { decision_id: parsed.id, decision_path: decisionPath },
  });
  process.stdout.write(
    `${JSON.stringify({
      linked: true,
      task_id: id,
      decision_id: parsed.id,
      decision_path: decisionPath,
      event_id: eventId,
    })}\n`,
  );
  process.stderr.write(`scrum task link-decision: ${id} -> ${parsed.id} (${decisionPath})\n`);
  return 0;
}

/**
 * Record a dependency edge. Thin wrapper over `store.addDep` — domain
 * checks (self-edge, unknown task) bubble through as exit-1 errors
 * with stderr carrying the store's message. Idempotent at the store
 * layer; repeat calls are a no-op (stdout reports `added: true`
 * regardless, matching the `scrum task tag` convention).
 */
function doAddDep(
  store: ScrumStore,
  from: string | undefined,
  to: string | undefined,
  flags: TaskCmdFlags,
): number {
  if (from === undefined || from.length === 0 || to === undefined || to.length === 0) {
    process.stderr.write('scrum task add-dep: <from> and <to> positional arguments required\n');
    return 1;
  }
  const kind = resolveDepKind(flags.kind, 'add-dep');
  if (kind === null) return 1;
  store.addDep(from, to, kind);
  process.stdout.write(
    `${JSON.stringify({ added: true, from_task_id: from, to_task_id: to, kind })}\n`,
  );
  process.stderr.write(`scrum task add-dep: ${from} -${kind}-> ${to}\n`);
  return 0;
}

function doRemoveDep(
  store: ScrumStore,
  from: string | undefined,
  to: string | undefined,
  flags: TaskCmdFlags,
): number {
  if (from === undefined || from.length === 0 || to === undefined || to.length === 0) {
    process.stderr.write('scrum task remove-dep: <from> and <to> positional arguments required\n');
    return 1;
  }
  const kind = resolveDepKind(flags.kind, 'remove-dep');
  if (kind === null) return 1;
  store.removeDep(from, to, kind);
  process.stdout.write(
    `${JSON.stringify({ removed: true, from_task_id: from, to_task_id: to, kind })}\n`,
  );
  process.stderr.write(`scrum task remove-dep: ${from} -${kind}-> ${to}\n`);
  return 0;
}

function resolveDepKind(raw: string | undefined, action: 'add-dep' | 'remove-dep'): DepKind | null {
  if (raw === undefined || raw.length === 0) return 'blocks';
  if (!(VALID_DEP_KINDS as string[]).includes(raw)) {
    process.stderr.write(
      `scrum task ${action}: invalid --kind '${raw}'. expected one of: ${VALID_DEP_KINDS.join(', ')}\n`,
    );
    return null;
  }
  return raw as DepKind;
}

// ---------------------------------------------------------------------------
// acceptance — author/list/supersede acceptance criteria (v5, audit §5.2)
//
//   task acceptance add <task-id> --text T --verifies-by K --check C
//                                 [--idempotent] [--timeout 30s] [--criterion ID]
//   task acceptance list <task-id>
//   task acceptance supersede <task-id> --criterion ID --reason R [--by NEW-ID]
//
// Append-only: `supersede` flips a criterion's status, never removing it.
// ---------------------------------------------------------------------------

type AcceptanceSubAction = 'add' | 'list' | 'supersede';

const ACCEPTANCE_SUB_ACTIONS: AcceptanceSubAction[] = ['add', 'list', 'supersede'];

function doAcceptance(
  store: ScrumStore,
  sub: string | undefined,
  taskId: string | undefined,
  flags: TaskCmdFlags,
): number {
  if (sub === undefined || !(ACCEPTANCE_SUB_ACTIONS as string[]).includes(sub)) {
    process.stderr.write(
      `scrum task acceptance: sub-action required (one of: ${ACCEPTANCE_SUB_ACTIONS.join(' | ')})\n`,
    );
    return 1;
  }
  if (taskId === undefined || taskId.length === 0) {
    process.stderr.write(`scrum task acceptance ${sub}: <task-id> positional argument required\n`);
    return 1;
  }
  switch (sub as AcceptanceSubAction) {
    case 'add':
      return doAcceptanceAdd(store, taskId, flags);
    case 'list':
      return doAcceptanceList(store, taskId);
    case 'supersede':
      return doAcceptanceSupersede(store, taskId, flags);
  }
}

function doAcceptanceAdd(store: ScrumStore, taskId: string, flags: TaskCmdFlags): number {
  if (flags.text === undefined || flags.text.length === 0) {
    process.stderr.write('scrum task acceptance add: --text is required\n');
    return 1;
  }
  if (flags.check === undefined || flags.check.length === 0) {
    process.stderr.write('scrum task acceptance add: --check is required\n');
    return 1;
  }
  if (
    flags.verifiesBy === undefined ||
    !VALID_VERIFIES_BY.includes(flags.verifiesBy as AcceptanceVerifiesBy)
  ) {
    process.stderr.write(
      `scrum task acceptance add: --verifies-by must be one of: ${VALID_VERIFIES_BY.join(', ')}\n`,
    );
    return 1;
  }

  const criterion: AcceptanceCriterion = {
    id:
      flags.criterion && flags.criterion.length > 0
        ? flags.criterion
        : generateId(flags.text, 'ac'),
    text: flags.text,
    verifies_by: flags.verifiesBy as AcceptanceVerifiesBy,
    check: flags.check,
    status: 'active',
    idempotent: flags.idempotent === true,
    superseded_by: null,
    reason: null,
    inherited_from: null,
  };
  if (flags.timeout !== undefined && flags.timeout.length > 0) criterion.timeout = flags.timeout;

  const task = store.addCriterion(taskId, criterion);
  process.stdout.write(`${JSON.stringify(task)}\n`);
  process.stderr.write(`scrum task acceptance add: ${taskId} += ${criterion.id}\n`);
  return 0;
}

function doAcceptanceList(store: ScrumStore, taskId: string): number {
  const task = store.getTask(taskId);
  if (task === null) {
    process.stderr.write(`scrum task acceptance list: task '${taskId}' not found\n`);
    return 1;
  }
  const criteria = task.acceptance?.criteria ?? [];
  process.stdout.write(`${JSON.stringify(criteria)}\n`);
  process.stderr.write(`scrum task acceptance list: ${taskId} (${criteria.length} criteria)\n`);
  return 0;
}

function doAcceptanceSupersede(store: ScrumStore, taskId: string, flags: TaskCmdFlags): number {
  if (flags.criterion === undefined || flags.criterion.length === 0) {
    process.stderr.write('scrum task acceptance supersede: --criterion <id> is required\n');
    return 1;
  }
  if (flags.reason === undefined || flags.reason.length === 0) {
    process.stderr.write('scrum task acceptance supersede: --reason <text> is required\n');
    return 1;
  }
  const task = store.supersedeCriterion(
    taskId,
    flags.criterion,
    flags.reason,
    flags.by && flags.by.length > 0 ? flags.by : null,
  );
  process.stdout.write(`${JSON.stringify(task)}\n`);
  process.stderr.write(
    `scrum task acceptance supersede: ${taskId} / ${flags.criterion} -> superseded\n`,
  );
  return 0;
}
