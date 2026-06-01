/**
 * `claude-prove scrum status [--human] [--workspace-root W]`
 *
 * Snapshot of active scrum state:
 *   - active_tasks      — every non-terminal, non-deleted task (flat list)
 *   - task_tree         — the parent_id containment forest (epic→story→task),
 *                         each node carrying its rolled-up `derived_status`
 *   - milestones        — planned + active milestones (excludes closed)
 *   - total_milestones  — count of every milestone row including closed
 *   - recent_events     — last 20 cross-task events
 *
 * Default emits a single-line JSON document on stdout for agents and
 * pipelines; `--human` prints a compact text table on stdout instead.
 * The stderr line always carries a one-line summary so tailing hooks
 * see context regardless of format.
 *
 * The tree surfaces the v3 `derivedStatus` rollup that was previously computed
 * and thrown away at the operator boundary (audit §11.3). Flat tasks
 * (parent_id NULL, no children) appear as single-node roots, so pre-v3 stores
 * render exactly as before plus a now-trivial tree.
 *
 * Exit codes:
 *   0  success
 *   1  workspace unresolvable or store open error
 */

import { join } from 'node:path';
import { mainWorktreeRoot } from '@claude-prove/shared';
import { type ScrumStore, openScrumStore } from '../store';
import type { ScrumTask, TaskLayer, TaskStatus } from '../types';

export interface StatusCmdFlags {
  human?: boolean;
  workspaceRoot?: string;
}

const RECENT_EVENT_LIMIT = 20;

const ACTIVE_STATUSES: TaskStatus[] = ['backlog', 'ready', 'in_progress', 'review', 'blocked'];

export function runStatusCmd(flags: StatusCmdFlags): number {
  const workspaceRoot =
    flags.workspaceRoot && flags.workspaceRoot.length > 0
      ? flags.workspaceRoot
      : (mainWorktreeRoot() ?? process.cwd());
  const store = openScrumStore({ override: join(workspaceRoot, '.prove', 'prove.db') });
  try {
    const snapshot = buildSnapshot(store);
    if (flags.human === true) {
      process.stdout.write(renderHumanTable(snapshot));
    } else {
      process.stdout.write(`${JSON.stringify(snapshot)}\n`);
    }
    process.stderr.write(
      `scrum status: ${snapshot.active_tasks.length} active tasks, ${snapshot.milestones.length}/${snapshot.total_milestones} active milestones, ${snapshot.recent_events.length} recent events\n`,
    );
    return 0;
  } finally {
    store.close();
  }
}

/**
 * One node of the containment forest. `status` is the task's own authored
 * status; `derived_status` is the rolled-up status over its subtree (equal to
 * `status` for a leaf). Children are nested depth-first in `created_at` order.
 */
interface TreeNode {
  id: string;
  title: string;
  layer: TaskLayer | null;
  status: TaskStatus;
  derived_status: TaskStatus;
  children: TreeNode[];
}

interface Snapshot {
  active_tasks: ReturnType<ScrumStore['listTasks']>;
  task_tree: TreeNode[];
  milestones: ReturnType<ScrumStore['listMilestones']>;
  total_milestones: number;
  recent_events: ReturnType<ScrumStore['listRecentEvents']>;
}

function buildSnapshot(store: ScrumStore): Snapshot {
  const allTasks = store.listTasks();
  const active = allTasks.filter((t) => ACTIVE_STATUSES.includes(t.status));
  const allMilestones = store.listMilestones();
  const milestones = allMilestones.filter((m) => m.status !== 'closed');
  const recent = store.listRecentEvents(RECENT_EVENT_LIMIT);
  return {
    active_tasks: active,
    task_tree: buildTaskTree(store, allTasks),
    milestones,
    total_milestones: allMilestones.length,
    recent_events: recent,
  };
}

/**
 * Assemble the `parent_id` forest from the full non-deleted task list. Roots
 * are the parent-less tasks; each node's children come from `getChildren`
 * (already `created_at`-ordered) and its `derived_status` from
 * `derivedStatus`. Tasks are kept in `created_at` order so root ordering is
 * stable. A `seen` set prevents a malformed `parent_id` cycle from looping.
 */
function buildTaskTree(store: ScrumStore, allTasks: ScrumTask[]): TreeNode[] {
  const build = (task: ScrumTask, seen: Set<string>): TreeNode => {
    seen.add(task.id);
    const children = store
      .getChildren(task.id)
      .filter((c) => !seen.has(c.id))
      .map((c) => build(c, seen));
    return {
      id: task.id,
      title: task.title,
      layer: task.layer,
      status: task.status,
      derived_status: store.derivedStatus(task.id),
      children,
    };
  };
  const seen = new Set<string>();
  return allTasks.filter((t) => t.parent_id === null).map((root) => build(root, seen));
}

function renderHumanTable(snapshot: Snapshot): string {
  const lines: string[] = [];
  lines.push(`Active tasks (${snapshot.active_tasks.length}):`);
  for (const task of snapshot.active_tasks) {
    lines.push(`  [${task.status}] ${task.id}  ${task.title}`);
  }
  lines.push('');
  lines.push(
    `Active milestones (${snapshot.milestones.length} of ${snapshot.total_milestones} total):`,
  );
  for (const m of snapshot.milestones) {
    lines.push(`  [${m.status}] ${m.id}  ${m.title}`);
  }
  lines.push('');
  lines.push(`Task tree (${snapshot.task_tree.length} root${plural(snapshot.task_tree.length)}):`);
  for (const root of snapshot.task_tree) renderTreeNode(root, 1, lines);
  lines.push('');
  lines.push(`Recent events (${snapshot.recent_events.length}):`);
  for (const e of snapshot.recent_events) {
    lines.push(`  ${e.ts}  ${e.task_id}  ${e.kind}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Render one tree node and its subtree, two spaces per depth level. A node
 * shows its `derived_status`; a parent whose own authored status differs from
 * the rollup appends `(self: <status>)` so the distinction stays visible.
 */
function renderTreeNode(node: TreeNode, depth: number, lines: string[]): void {
  const indent = '  '.repeat(depth);
  const layer = node.layer ? `${node.layer}: ` : '';
  const selfNote =
    node.children.length > 0 && node.status !== node.derived_status
      ? `  (self: ${node.status})`
      : '';
  lines.push(`${indent}[${node.derived_status}] ${layer}${node.id}  ${node.title}${selfNote}`);
  for (const child of node.children) renderTreeNode(child, depth + 1, lines);
}

function plural(n: number): string {
  return n === 1 ? '' : 's';
}
