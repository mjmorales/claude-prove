/**
 * Compile a scrum status `Snapshot` (the tree-aware rollup) into a report/v1
 * `ReportDocument` — a read-only dashboard. Mechanical: snapshot in, blocks out.
 * The snapshot shape is owned by the scrum status command; this module only maps
 * its milestones / task forest / active tasks to blocks.
 */

import type { Snapshot, TreeNode } from '../scrum/cli/status-cmd';
import type { Block, ReportDocument } from './blocks';

/** Flatten the task forest depth-first into indented `[task, layer, status, derived]` rows. */
function treeRows(nodes: TreeNode[], depth: number, rows: string[][]): void {
  for (const node of nodes) {
    const indent = '— '.repeat(depth);
    rows.push([
      `${indent}${node.id}: ${node.title}`,
      node.layer ?? '',
      node.status,
      node.derived_status,
    ]);
    treeRows(node.children, depth + 1, rows);
  }
}

/** Compile a status snapshot into a dashboard report/v1 document. */
export function statusSnapshotToReportDocument(snapshot: Snapshot): ReportDocument {
  const blocks: Block[] = [];

  blocks.push({
    type: 'section',
    title: `Milestones (${snapshot.milestones.length} of ${snapshot.total_milestones})`,
    blocks: [
      snapshot.milestones.length > 0
        ? {
            type: 'table',
            columns: ['Milestone', 'Title', 'Status'],
            rows: snapshot.milestones.map((m) => [m.id, m.title, m.status]),
          }
        : { type: 'paragraph', text: 'No open milestones.' },
    ],
  });

  const rows: string[][] = [];
  treeRows(snapshot.task_tree, 0, rows);
  blocks.push({
    type: 'section',
    title: `Task tree (${snapshot.task_tree.length} root${snapshot.task_tree.length === 1 ? '' : 's'})`,
    blocks: [
      rows.length > 0
        ? { type: 'table', columns: ['Task', 'Layer', 'Status', 'Derived'], rows }
        : { type: 'paragraph', text: 'No tasks.' },
    ],
  });

  blocks.push({
    type: 'section',
    title: `Active tasks (${snapshot.active_tasks.length})`,
    blocks: [
      snapshot.active_tasks.length > 0
        ? {
            type: 'table',
            columns: ['Task', 'Status', 'Title'],
            rows: snapshot.active_tasks.map((t) => [t.id, t.status, t.title]),
          }
        : { type: 'paragraph', text: 'Nothing active.' },
    ],
  });

  return { schema_version: '1', title: 'Scrum Status', blocks };
}
