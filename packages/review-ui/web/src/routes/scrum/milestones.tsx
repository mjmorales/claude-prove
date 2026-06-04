import { useQuery } from "@tanstack/react-query";
import type { ScrumMilestone, ScrumTask, TaskStatus } from "@claude-prove/cli/scrum/types";
import { scrumApi } from "../../lib/scrumApi";
import { useActiveProject } from "../../lib/active-project";
import { EmptyState, ErrorBox, Loading, TASK_STATUSES, statusMeta } from "./_components";

const STALE_MS = 30_000;

type MilestoneRollup = { rollup: Record<TaskStatus, number>; total: number };

function emptyRollup(): Record<TaskStatus, number> {
  const r = {} as Record<TaskStatus, number>;
  for (const s of TASK_STATUSES) r[s] = 0;
  return r;
}

/**
 * Compute per-milestone status rollups from a single tasks list, grouped by
 * `milestone_id` — one pass over the tasks query, no per-milestone fetch.
 * Unknown statuses are ignored by the fixed-key record.
 */
function rollupsByMilestone(tasks: ScrumTask[]): Map<string, MilestoneRollup> {
  const byMilestone = new Map<string, MilestoneRollup>();
  for (const t of tasks) {
    if (!t.milestone_id) continue;
    let entry = byMilestone.get(t.milestone_id);
    if (!entry) {
      entry = { rollup: emptyRollup(), total: 0 };
      byMilestone.set(t.milestone_id, entry);
    }
    if (t.status in entry.rollup) entry.rollup[t.status] += 1;
    entry.total += 1;
  }
  return byMilestone;
}

/**
 * Milestones view. Lists all milestones with a per-milestone status rollup
 * computed client-side from a single `scrumApi.tasks()` fetch grouped by
 * `milestone_id` — no per-milestone request fan-out.
 */
export function ScrumMilestonesView() {
  const { projectKey } = useActiveProject();

  const list = useQuery({
    queryKey: ["scrum", "milestones", {}, projectKey],
    queryFn: () => scrumApi.milestones(),
    staleTime: STALE_MS,
  });
  const tasksQ = useQuery({
    queryKey: ["scrum", "tasks", {}, projectKey],
    queryFn: () => scrumApi.tasks(),
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

  const rollups = tasksQ.isSuccess
    ? rollupsByMilestone(tasksQ.data.tasks)
    : undefined;

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-4">
      {list.data.milestones.map((m) => (
        <MilestoneRow
          key={m.id}
          milestone={m}
          rollup={rollups?.get(m.id) ?? { rollup: emptyRollup(), total: 0 }}
          loading={tasksQ.isPending}
          error={tasksQ.isError ? tasksQ.error : null}
        />
      ))}
    </div>
  );
}

function MilestoneRow({
  milestone,
  rollup,
  loading,
  error,
}: {
  milestone: ScrumMilestone;
  rollup: MilestoneRollup;
  loading: boolean;
  error: unknown;
}) {
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
        {loading && <Loading label="Loading rollup…" />}
        {error != null && <ErrorBox error={error} />}
        {!loading && error == null && (
          <RollupGrid rollup={rollup.rollup} total={rollup.total} />
        )}
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
