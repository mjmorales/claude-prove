/**
 * `prove scrum status [--human] [--workspace-root W]`
 *
 * Snapshot of active scrum state:
 *   - active_tasks  — every non-terminal, non-deleted task
 *   - milestones    — planned + active milestones (excludes closed)
 *   - recent_events — last 20 cross-task events
 *
 * Default emits a single-line JSON document on stdout for agents and
 * pipelines; `--human` prints a compact text table on stdout instead.
 * The stderr line always carries a one-line summary so tailing hooks
 * see context regardless of format.
 *
 * Exit codes:
 *   0  success
 *   1  workspace unresolvable or store open error
 */

import { type ScrumStore, openScrumStore } from '../store';
import type { TaskStatus } from '../types';

export interface StatusCmdFlags {
  human?: boolean;
  workspaceRoot?: string;
}

const RECENT_EVENT_LIMIT = 20;

const ACTIVE_STATUSES: TaskStatus[] = ['backlog', 'ready', 'in_progress', 'review', 'blocked'];

export function runStatusCmd(flags: StatusCmdFlags): number {
  const store = openScrumStore();
  try {
    const snapshot = buildSnapshot(store);
    if (flags.human === true) {
      process.stdout.write(renderHumanTable(snapshot));
    } else {
      process.stdout.write(`${JSON.stringify(snapshot)}\n`);
    }
    process.stderr.write(
      `scrum status: ${snapshot.active_tasks.length} active tasks, ${snapshot.milestones.length} milestones, ${snapshot.recent_events.length} recent events\n`,
    );
    return 0;
  } finally {
    store.close();
  }
}

interface Snapshot {
  active_tasks: ReturnType<ScrumStore['listTasks']>;
  milestones: ReturnType<ScrumStore['listMilestones']>;
  recent_events: ReturnType<ScrumStore['listRecentEvents']>;
}

function buildSnapshot(store: ScrumStore): Snapshot {
  const allTasks = store.listTasks();
  const active = allTasks.filter((t) => ACTIVE_STATUSES.includes(t.status));
  const milestones = store.listMilestones().filter((m) => m.status !== 'closed');
  const recent = store.listRecentEvents(RECENT_EVENT_LIMIT);
  return { active_tasks: active, milestones, recent_events: recent };
}

function renderHumanTable(snapshot: Snapshot): string {
  const lines: string[] = [];
  lines.push(`Active tasks (${snapshot.active_tasks.length}):`);
  for (const task of snapshot.active_tasks) {
    lines.push(`  [${task.status}] ${task.id}  ${task.title}`);
  }
  lines.push('');
  lines.push(`Milestones (${snapshot.milestones.length}):`);
  for (const m of snapshot.milestones) {
    lines.push(`  [${m.status}] ${m.id}  ${m.title}`);
  }
  lines.push('');
  lines.push(`Recent events (${snapshot.recent_events.length}):`);
  for (const e of snapshot.recent_events) {
    lines.push(`  ${e.ts}  ${e.task_id}  ${e.kind}`);
  }
  return `${lines.join('\n')}\n`;
}
