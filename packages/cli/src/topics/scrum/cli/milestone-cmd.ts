/**
 * `claude-prove scrum milestone <action> [args] [flags]`
 *
 * Action dispatch:
 *   create --title X [--description Y] [--target-state S] [--id I]
 *   list   [--status planned|active|closed]
 *   show <id>
 *   update <id> [--title T] [--description D] [--target-state S] [--initiative I]
 *   close <id>
 *   activate <id>
 *   reopen <id>
 *
 * `update` amends a milestone's descriptive fields after creation. Only the
 * flags passed are written; a nullable field (`--description`, `--target-state`,
 * `--initiative`) passed empty (`--description ""`) clears it to NULL. Rejects a
 * closed milestone (closed is terminal — annotate it instead).
 *
 * Exit codes:
 *   0  success
 *   1  usage error, unknown action, or missing milestone
 */

import { mainWorktreeRoot } from '@claude-prove/shared';
import { gatherMilestoneStories, reconcileMilestoneClosed } from '../reconcile';
import type { ScrumStore, UpdateMilestoneInput } from '../store';
import type { MilestoneStatus } from '../types';
import { openCliStore } from './cli-store';
import { generateId } from './scrum-utils';

export interface MilestoneCmdFlags {
  title?: string;
  description?: string;
  targetState?: string;
  id?: string;
  status?: string;
  /** `create`: initiative grouping label; `list`: filter to one initiative. */
  initiative?: string;
  workspaceRoot?: string;
}

export type MilestoneAction =
  | 'create'
  | 'list'
  | 'show'
  | 'update'
  | 'close'
  | 'activate'
  | 'reopen';

const MILESTONE_ACTIONS: MilestoneAction[] = [
  'create',
  'list',
  'show',
  'update',
  'close',
  'activate',
  'reopen',
];
const VALID_STATUSES: MilestoneStatus[] = ['planned', 'active', 'closed'];

export async function runMilestoneCmd(
  action: string,
  positional: (string | undefined)[],
  flags: MilestoneCmdFlags,
): Promise<number> {
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
  const store = await openCliStore(workspaceRoot);
  try {
    switch (action) {
      case 'create':
        return await doCreate(store, flags);
      case 'list':
        return await doList(store, flags);
      case 'show':
        return await doShow(store, positional[0]);
      case 'update':
        return await doUpdate(store, positional[0], flags);
      case 'close':
        return await doClose(store, positional[0], workspaceRoot);
      case 'activate':
        return await doActivate(store, positional[0]);
      case 'reopen':
        return await doReopen(store, positional[0]);
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

async function doCreate(store: ScrumStore, flags: MilestoneCmdFlags): Promise<number> {
  if (flags.title === undefined || flags.title.length === 0) {
    process.stderr.write('scrum milestone create: --title is required\n');
    return 1;
  }
  const id =
    flags.id !== undefined && flags.id.length > 0 ? flags.id : generateId(flags.title, 'milestone');
  const milestone = await store.createMilestone({
    id,
    title: flags.title,
    description: flags.description ?? null,
    targetState: flags.targetState ?? null,
    initiative: flags.initiative ?? null,
  });
  process.stdout.write(`${JSON.stringify(milestone)}\n`);
  process.stderr.write(`scrum milestone create: ${milestone.id}\n`);
  return 0;
}

async function doList(store: ScrumStore, flags: MilestoneCmdFlags): Promise<number> {
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
  const rows = await store.listMilestones(status, flags.initiative);
  process.stdout.write(`${JSON.stringify(rows)}\n`);
  process.stderr.write(`scrum milestone list: ${rows.length} milestones\n`);
  return 0;
}

async function doShow(store: ScrumStore, id: string | undefined): Promise<number> {
  if (id === undefined || id.length === 0) {
    process.stderr.write('scrum milestone show: <id> positional argument required\n');
    return 1;
  }
  const milestone = await store.getMilestone(id);
  if (milestone === null) {
    process.stderr.write(`scrum milestone show: milestone '${id}' not found\n`);
    return 1;
  }
  const tasks = await store.listTasks({ milestoneId: id });
  process.stdout.write(`${JSON.stringify({ milestone, tasks })}\n`);
  process.stderr.write(
    `scrum milestone show: ${id} (${milestone.status}, ${tasks.length} tasks)\n`,
  );
  return 0;
}

async function doUpdate(
  store: ScrumStore,
  id: string | undefined,
  flags: MilestoneCmdFlags,
): Promise<number> {
  if (id === undefined || id.length === 0) {
    process.stderr.write('scrum milestone update: <id> positional argument required\n');
    return 1;
  }

  const patch: UpdateMilestoneInput = {};
  if (flags.title !== undefined) {
    if (flags.title.length === 0) {
      process.stderr.write('scrum milestone update: --title cannot be empty\n');
      return 1;
    }
    patch.title = flags.title;
  }
  // The nullable fields follow one convention: a non-empty value sets the
  // column, an empty value (`--description ""`) clears it to NULL, and omitting
  // the flag leaves it untouched.
  if (flags.description !== undefined) {
    patch.description = flags.description.length > 0 ? flags.description : null;
  }
  if (flags.targetState !== undefined) {
    patch.targetState = flags.targetState.length > 0 ? flags.targetState : null;
  }
  if (flags.initiative !== undefined) {
    patch.initiative = flags.initiative.length > 0 ? flags.initiative : null;
  }

  if (Object.keys(patch).length === 0) {
    process.stderr.write(
      'scrum milestone update: at least one of --title, --description, --target-state, --initiative required\n',
    );
    return 1;
  }

  const milestone = await store.updateMilestone(id, patch);
  process.stdout.write(`${JSON.stringify(milestone)}\n`);
  process.stderr.write(`scrum milestone update: ${id}\n`);
  return 0;
}

async function doClose(
  store: ScrumStore,
  id: string | undefined,
  workspaceRoot: string,
): Promise<number> {
  if (id === undefined || id.length === 0) {
    process.stderr.write('scrum milestone close: <id> positional argument required\n');
    return 1;
  }
  // Capture prior status before the close so the close-transition work fires
  // only on a real planned/active → closed transition. Re-closing an
  // already-closed milestone must not re-emit curation_proposed events — the
  // forced bubble-up fires once per close transition.
  const prior = await store.getMilestone(id);
  const milestone = await store.closeMilestone(id);

  // Emit the close result immediately after the durable store mutation so
  // callers always receive the closed milestone JSON, regardless of whether
  // the secondary curation/rollup steps succeed.
  process.stdout.write(`${JSON.stringify(milestone)}\n`);

  let closeNote = '';
  if (prior !== null && prior.status !== 'closed') {
    // Curation and rollup are best-effort post-close work: the milestone is
    // already closed in the store, so a failure here should warn but not
    // change the exit code or suppress the close result already on stdout.
    try {
      const curation = await reconcileMilestoneClosed(id, store, workspaceRoot);
      // The same close transition surfaces the stakeholder milestone brief.
      // The brief is rendered on demand via `acb milestone-brief render
      // --milestone <id>`; here we just report how many constituent stories
      // it will roll up so the operator knows the rollup is available.
      const stories = await gatherMilestoneStories(id, store, workspaceRoot);
      const compactNote =
        curation.compactedTeams.length > 0
          ? `; journal compaction: ${curation.compactedTeams.length} terminating team(s) summarized`
          : '';
      closeNote = ` (curation: ${curation.emitted.length} task(s) proposed${compactNote}; milestone brief: ${stories.length} stor(ies) — render via 'acb milestone-brief render --milestone ${id}')`;
    } catch (curationErr) {
      const msg = curationErr instanceof Error ? curationErr.message : String(curationErr);
      process.stderr.write(`scrum milestone close: WARNING: post-close curation failed: ${msg}\n`);
    }
  }

  process.stderr.write(`scrum milestone close: ${id}${closeNote}\n`);
  return 0;
}

async function doActivate(store: ScrumStore, id: string | undefined): Promise<number> {
  if (id === undefined || id.length === 0) {
    process.stderr.write('scrum milestone activate: <id> positional argument required\n');
    return 1;
  }
  const milestone = await store.setMilestoneStatus(id, 'active');
  process.stdout.write(`${JSON.stringify(milestone)}\n`);
  process.stderr.write(`scrum milestone activate: ${id}\n`);
  return 0;
}

async function doReopen(store: ScrumStore, id: string | undefined): Promise<number> {
  if (id === undefined || id.length === 0) {
    process.stderr.write('scrum milestone reopen: <id> positional argument required\n');
    return 1;
  }
  const milestone = await store.setMilestoneStatus(id, 'planned');
  process.stdout.write(`${JSON.stringify(milestone)}\n`);
  process.stderr.write(`scrum milestone reopen: ${id}\n`);
  return 0;
}
