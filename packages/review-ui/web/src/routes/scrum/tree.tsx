import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { ScrumMilestone } from "@claude-prove/cli/scrum/types";
import { scrumApi } from "../../lib/scrumApi";
import { useActiveProject } from "../../lib/active-project";
import { useScrumSelection } from "../../lib/scrumStore";
import { cn } from "../../lib/cn";
import {
  AcceptanceCriteria,
  EmptyState,
  ErrorBox,
  LayerBadge,
  Loading,
  StatusPill,
} from "./_components";
import {
  buildMilestoneTrees,
  type MilestoneTreeGroup,
  type TaskTreeNode,
} from "./tree-assembly";

const STALE_MS = 30_000;

/**
 * Layered task-tree view. Renders the epic→story→task containment forest
 * (`parent_id` edges) grouped by milestone, each task expanding to surface its
 * acceptance criteria.
 *
 * Two queries — one flat `scrumApi.tasks()` fetch and one `scrumApi.milestones()`
 * — feed a single client-side assembly (`buildMilestoneTrees`); the tree is
 * never reconstructed via per-node fetches. Both query keys carry the active
 * `projectKey` so a workspace switch refetches under a fresh key rather than
 * serving another project's cached forest.
 */
export function ScrumTreeView() {
  const { projectKey } = useActiveProject();

  const tasksQ = useQuery({
    queryKey: ["scrum", "tasks", "tree", projectKey],
    queryFn: () => scrumApi.tasks(),
    staleTime: STALE_MS,
  });
  const milestonesQ = useQuery({
    queryKey: ["scrum", "milestones", "tree", projectKey],
    queryFn: () => scrumApi.milestones(),
    staleTime: STALE_MS,
  });

  const groups = useMemo<MilestoneTreeGroup[]>(() => {
    if (!tasksQ.data || !milestonesQ.data) return [];
    return buildMilestoneTrees(tasksQ.data.tasks, milestonesQ.data.milestones);
  }, [tasksQ.data, milestonesQ.data]);

  if (tasksQ.isPending || milestonesQ.isPending) {
    return <div className="p-6"><Loading label="Loading task tree…" /></div>;
  }
  if (tasksQ.isError) return <div className="p-6"><ErrorBox error={tasksQ.error} /></div>;
  if (milestonesQ.isError) return <div className="p-6"><ErrorBox error={milestonesQ.error} /></div>;

  const hasAnyTask = groups.some((g) => g.taskCount > 0);
  if (!hasAnyTask) {
    return (
      <div className="p-6 max-w-2xl mx-auto">
        <EmptyState>No tasks yet. Create one with <span className="mono text-fg-base">prove scrum task create</span>.</EmptyState>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-4">
      {groups.map((group) => (
        <MilestoneGroup key={group.milestone?.id ?? "__unassigned__"} group={group} />
      ))}
    </div>
  );
}

function MilestoneGroup({ group }: { group: MilestoneTreeGroup }) {
  const [open, setOpen] = useState(true);
  const title = group.milestone?.title ?? "Unassigned";
  const headingId = `tree-ms-${group.milestone?.id ?? "unassigned"}`;

  return (
    <section aria-labelledby={headingId} className="rounded-md border border-bg-line bg-bg-panel">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center gap-2 px-4 h-11 text-left border-b border-bg-line"
      >
        <Chevron open={open} />
        {group.milestone && <MilestoneStatusBadge status={group.milestone.status} />}
        <h3 id={headingId} className="text-fg-bright font-medium text-[14px] truncate">{title}</h3>
        <span className="ml-auto mono text-[11.5px] text-fg-faint tabular-nums shrink-0">
          {group.taskCount} {group.taskCount === 1 ? "task" : "tasks"}
        </span>
      </button>
      {open && (
        <div className="p-2">
          {group.roots.length === 0 ? (
            <p className="px-2 py-3 text-fg-faint text-[12px] text-center mono">No tasks assigned.</p>
          ) : (
            group.roots.map((node) => <TreeNode key={node.task.id} node={node} />)
          )}
        </div>
      )}
    </section>
  );
}

/**
 * One node of the containment tree. Collapsing the node hides its acceptance
 * criteria AND its child subtree; a leaf with no children and no criteria still
 * renders its header row (clickable through to the detail view). Indentation is
 * driven by the pre-computed `node.depth` so nesting reads at a glance.
 */
function TreeNode({ node }: { node: TaskTreeNode }) {
  const navigate = useNavigate();
  const setTaskId = useScrumSelection((s) => s.setTaskId);
  const [expanded, setExpanded] = useState(node.depth === 0);

  const { task } = node;
  const criteria = task.acceptance?.criteria ?? [];
  const hasChildren = node.children.length > 0;
  const hasDetail = hasChildren || criteria.length > 0;

  const openDetail = () => {
    setTaskId(task.id);
    navigate(`/scrum/task/${encodeURIComponent(task.id)}`);
  };

  return (
    <div style={{ marginLeft: node.depth === 0 ? 0 : 16 }}>
      <div
        className={cn(
          "group flex items-center gap-2 px-2 h-9 rounded-md border border-transparent",
          "hover:bg-bg-raised hover:border-bg-line transition-colors",
        )}
      >
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-label={expanded ? "Collapse" : "Expand"}
          disabled={!hasDetail}
          className={cn("shrink-0 w-4", hasDetail ? "" : "opacity-0 pointer-events-none")}
        >
          <Chevron open={expanded} />
        </button>
        <StatusPill status={task.status} />
        <LayerBadge layer={task.layer} />
        <button
          type="button"
          onClick={openDetail}
          className="flex-1 min-w-0 text-left text-fg-bright text-[13px] truncate hover:text-phos focus:outline-none focus:text-phos"
        >
          {task.title}
        </button>
        <span className="mono text-[11px] text-fg-faint shrink-0">{task.id.slice(0, 8)}</span>
      </div>

      {expanded && criteria.length > 0 && (
        <div style={{ marginLeft: 24 }} className="my-1.5 pl-3 border-l border-bg-line">
          <h4 className="eyebrow !text-[10px] mb-1">Acceptance</h4>
          <AcceptanceCriteria criteria={criteria} />
        </div>
      )}

      {expanded && hasChildren && (
        <div className="mt-0.5 space-y-0.5">
          {node.children.map((child) => (
            <TreeNode key={child.task.id} node={child} />
          ))}
        </div>
      )}
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <span
      className="text-fg-faint text-[11px] transition-transform inline-block"
      style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)" }}
      aria-hidden
    >
      ▸
    </span>
  );
}

function MilestoneStatusBadge({ status }: { status: ScrumMilestone["status"] }) {
  const color = status === "active" ? "#bd93f9" : status === "closed" ? "#50fa7b" : "#6272a4";
  return (
    <span
      className="inline-flex items-center px-1.5 h-5 rounded text-[10.5px] mono uppercase tracking-wider shrink-0"
      style={{ color, background: `${color}14`, border: `1px solid ${color}55` }}
    >
      {status}
    </span>
  );
}
