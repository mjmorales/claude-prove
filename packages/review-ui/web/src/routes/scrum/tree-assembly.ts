import type { ScrumMilestone, ScrumTask, TaskLayer } from "@claude-prove/cli/scrum/types";

/**
 * Client-side assembly of the layered epic→story→task containment tree from a
 * single flat tasks list. The server returns every task in one fetch; this
 * module rebuilds the `parent_id` forest in memory rather than fanning out a
 * request per node — the same no-N+1 idiom the milestone-rollup view uses.
 *
 * One concept per file: pure data transforms only, no React, so the assembly
 * is unit-testable in isolation from the rendering tree.
 */

/**
 * One node of the assembled containment tree. Wraps a `ScrumTask` with its
 * resolved children so the renderer recurses on `children` without re-walking
 * the flat list. `depth` is the 0-based nesting level (a milestone's top-level
 * task is depth 0), pre-computed here so indentation needs no render-time math.
 */
export interface TaskTreeNode {
  task: ScrumTask;
  children: TaskTreeNode[];
  depth: number;
}

/**
 * A milestone with its assembled task forest. `roots` are the milestone's
 * top-level nodes (tasks whose `parent_id` is null OR points outside the
 * milestone's own task set). The `milestone` is null for the synthetic
 * unassigned bucket that collects tasks carrying no `milestone_id`.
 */
export interface MilestoneTreeGroup {
  milestone: ScrumMilestone | null;
  roots: TaskTreeNode[];
  /** Total tasks in this group across all depths — the group-header count. */
  taskCount: number;
}

/** The stable id of the synthetic group that holds milestone-less tasks. */
export const UNASSIGNED_GROUP_ID = "__unassigned__";

/**
 * Canonical layer order for stable sibling sort: epics first, then stories,
 * then tasks, then untiered (null layer) last. Within a layer, ties break on
 * task id so the assembled tree is deterministic regardless of fetch order.
 */
const LAYER_RANK: Record<TaskLayer, number> = {
  epic: 0,
  story: 1,
  task: 2,
};

function layerRank(layer: TaskLayer | null): number {
  if (layer === null) return 3;
  return LAYER_RANK[layer] ?? 3;
}

/**
 * Group tasks by `milestone_id`, then build each group's `parent_id` forest.
 * Single pass to bucket by milestone, then one forest build per bucket — the
 * whole assembly is O(n) plus the per-group sibling sort.
 *
 * A task whose `parent_id` names a task in a DIFFERENT milestone (or a missing
 * task) is treated as a root of its own milestone group rather than dropped, so
 * a cross-milestone or dangling parent edge never makes a task disappear.
 *
 * A task whose `milestone_id` is NOT in the supplied milestones list (a dangling
 * reference to a deleted/unknown milestone) is folded into the unassigned bucket
 * rather than spawning a second `milestone === null` group — a separate dangling
 * group would carry the same null key as the genuine unassigned bucket and one
 * would clobber the other in `sortGroups`, silently dropping tasks. Folding
 * preserves the no-drop invariant by concatenation.
 */
export function buildMilestoneTrees(
  tasks: ScrumTask[],
  milestones: ScrumMilestone[],
): MilestoneTreeGroup[] {
  const milestoneById = new Map(milestones.map((m) => [m.id, m] as const));
  const byMilestone = bucketTasksByMilestone(tasks, milestoneById);

  const groups: MilestoneTreeGroup[] = [];
  for (const [milestoneId, groupTasks] of byMilestone) {
    const milestone =
      milestoneId === UNASSIGNED_GROUP_ID ? null : milestoneById.get(milestoneId) ?? null;
    groups.push({
      milestone,
      roots: buildForest(groupTasks),
      taskCount: groupTasks.length,
    });
  }

  return sortGroups(groups, milestones);
}

/**
 * Bucket tasks into a `milestone_id → tasks` map. A task is routed to the
 * `UNASSIGNED_GROUP_ID` bucket when it carries no `milestone_id` OR when its
 * `milestone_id` is absent from `milestoneById` (a dangling reference). Folding
 * dangling-milestone tasks into the one unassigned bucket keeps a single null
 * key, so no group overwrites another. Insertion order is preserved so a
 * milestone with no tasks never produces an empty bucket here (empty milestones
 * are merged back in by `sortGroups`).
 */
function bucketTasksByMilestone(
  tasks: ScrumTask[],
  milestoneById: Map<string, ScrumMilestone>,
): Map<string, ScrumTask[]> {
  const byMilestone = new Map<string, ScrumTask[]>();
  for (const task of tasks) {
    const known = task.milestone_id !== null && milestoneById.has(task.milestone_id);
    const key = known ? task.milestone_id! : UNASSIGNED_GROUP_ID;
    const bucket = byMilestone.get(key);
    if (bucket) bucket.push(task);
    else byMilestone.set(key, [task]);
  }
  return byMilestone;
}

/**
 * Build the `parent_id` forest for one milestone's tasks. Children are linked
 * only when the parent is also in THIS group's set — an out-of-group or missing
 * parent promotes the child to a root. Depth is assigned during the recursive
 * descent from each root.
 */
function buildForest(groupTasks: ScrumTask[]): TaskTreeNode[] {
  const nodeById = new Map<string, TaskTreeNode>();
  for (const task of groupTasks) {
    nodeById.set(task.id, { task, children: [], depth: 0 });
  }

  const roots: TaskTreeNode[] = [];
  for (const node of nodeById.values()) {
    const parentId = node.task.parent_id;
    const parent = parentId !== null ? nodeById.get(parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  for (const root of roots) assignDepth(root, 0);
  sortSiblings(roots);
  return roots;
}

/** Recursively stamp `depth` from a root downward and sort each child list. */
function assignDepth(node: TaskTreeNode, depth: number): void {
  node.depth = depth;
  for (const child of node.children) assignDepth(child, depth + 1);
  sortSiblings(node.children);
}

/** Stable sibling order: by layer rank (epic→story→task→untiered), then id. */
function sortSiblings(nodes: TaskTreeNode[]): void {
  nodes.sort((a, b) => {
    const rank = layerRank(a.task.layer) - layerRank(b.task.layer);
    if (rank !== 0) return rank;
    return a.task.id.localeCompare(b.task.id);
  });
}

/**
 * Order the groups for display: every known milestone first (in the order the
 * milestones list supplies, which is the store's own ordering), then the
 * synthetic unassigned bucket last. A known milestone with zero tasks is still
 * rendered (an empty group) so the panel mirrors the full milestone set.
 */
function sortGroups(
  groups: MilestoneTreeGroup[],
  milestones: ScrumMilestone[],
): MilestoneTreeGroup[] {
  const byMilestoneId = new Map<string, MilestoneTreeGroup>();
  let unassigned: MilestoneTreeGroup | null = null;
  for (const group of groups) {
    if (group.milestone === null) unassigned = group;
    else byMilestoneId.set(group.milestone.id, group);
  }

  const ordered: MilestoneTreeGroup[] = [];
  for (const milestone of milestones) {
    const existing = byMilestoneId.get(milestone.id);
    ordered.push(existing ?? { milestone, roots: [], taskCount: 0 });
  }
  if (unassigned) ordered.push(unassigned);
  return ordered;
}
