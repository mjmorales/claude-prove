import { useQuery } from "@tanstack/react-query";
import type { ScrumMilestone, TaskStatus } from "@claude-prove/cli/scrum/types";
import { scrumApi } from "../../lib/scrumApi";
import { EmptyState, ErrorBox, Loading, TASK_STATUSES, statusMeta } from "./_components";

const STALE_MS = 30_000;

/**
 * Milestones view. Lists all milestones with a per-milestone status rollup
 * fetched via a fan-out of `GET /api/scrum/milestones/:id` queries. Each
 * rollup is its own query key so React Query can cache/refresh per milestone
 * without knocking out neighbors.
 */
export function ScrumMilestonesView() {
  const list = useQuery({
    queryKey: ["scrum", "milestones", {}],
    queryFn: () => scrumApi.milestones(),
    staleTime: STALE_MS,
  });

  if (list.isPending) return <div className="p-6"><Loading label="Loading milestones…" /></div>;
  if (list.isError) return <div className="p-6"><ErrorBox error={list.error} /></div>;
  if (list.data.milestones.length === 0) {
    return (
      <div className="p-6 max-w-2xl mx-auto">
        <EmptyState>No milestones defined.</EmptyState>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-4">
      {list.data.milestones.map((m) => (
        <MilestoneRow key={m.id} milestone={m} />
      ))}
    </div>
  );
}

function MilestoneRow({ milestone }: { milestone: ScrumMilestone }) {
  const rollup = useQuery({
    queryKey: ["scrum", "milestone", milestone.id],
    queryFn: () => scrumApi.milestone(milestone.id),
    staleTime: STALE_MS,
  });

  return (
    <section
      aria-labelledby={`ms-${milestone.id}`}
      className="rounded-md border border-bg-line bg-bg-panel"
    >
      <header className="p-4 border-b border-bg-line flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <StatusBadge status={milestone.status} />
            <h3 id={`ms-${milestone.id}`} className="text-fg-bright font-medium text-[14px]">
              {milestone.title}
            </h3>
          </div>
          {milestone.description && (
            <p className="mt-1 text-[12.5px] text-fg-dim line-clamp-2">{milestone.description}</p>
          )}
          {milestone.target_state && (
            <p className="mt-1 text-[11.5px] text-fg-faint mono">
              target: {milestone.target_state}
            </p>
          )}
        </div>
        <span className="mono text-[11px] text-fg-faint shrink-0">{milestone.id.slice(0, 10)}</span>
      </header>
      <div className="p-3">
        {rollup.isPending && <Loading label="Loading rollup…" />}
        {rollup.isError && <ErrorBox error={rollup.error} />}
        {rollup.isSuccess && <RollupGrid rollup={rollup.data.rollup} total={rollup.data.tasks.length} />}
      </div>
    </section>
  );
}

function RollupGrid({ rollup, total }: { rollup: Record<TaskStatus, number>; total: number }) {
  if (total === 0) {
    return <p className="text-fg-faint text-[12.5px] text-center py-2">No tasks assigned.</p>;
  }
  return (
    <div className="grid grid-cols-2 md:grid-cols-7 gap-2">
      {TASK_STATUSES.map((status) => {
        const count = rollup[status];
        const meta = statusMeta(status);
        const empty = count === 0;
        return (
          <div
            key={status}
            className="flex flex-col items-center p-2 rounded border"
            style={{
              borderColor: empty ? "#44475a" : meta.color + "55",
              background: empty ? "transparent" : `${meta.color}0f`,
            }}
          >
            <span
              className="mono text-[18px] font-semibold tabular-nums"
              style={{ color: empty ? "#6272a4" : meta.color }}
            >
              {count}
            </span>
            <span className="text-[10.5px] uppercase tracking-wider text-fg-faint">{meta.label}</span>
          </div>
        );
      })}
    </div>
  );
}

function StatusBadge({ status }: { status: ScrumMilestone["status"] }) {
  const color = status === "active" ? "#bd93f9" : status === "closed" ? "#50fa7b" : "#6272a4";
  return (
    <span
      className="inline-flex items-center px-1.5 h-5 rounded text-[10.5px] mono uppercase tracking-wider"
      style={{ color, background: `${color}14`, border: `1px solid ${color}55` }}
    >
      {status}
    </span>
  );
}
