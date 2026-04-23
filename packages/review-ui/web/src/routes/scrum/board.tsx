import { useQuery } from "@tanstack/react-query";
import type { ScrumTask, TaskStatus } from "@claude-prove/cli/scrum/types";
import { scrumApi } from "../../lib/scrumApi";
import { EmptyState, ErrorBox, Loading, TASK_STATUSES, TaskCard, statusMeta } from "./_components";

const STALE_MS = 30_000;

/**
 * Kanban-style read-only board. Tasks are fetched unfiltered then bucketed
 * client-side into the 7 canonical status columns. No drag/drop — the UI
 * mirrors the SQLite store, which only advances via CLI/agent.
 */
export function ScrumBoardView() {
  const q = useQuery({
    queryKey: ["scrum", "tasks", {}],
    queryFn: () => scrumApi.tasks(),
    staleTime: STALE_MS,
  });

  if (q.isPending) return <div className="p-6"><Loading label="Loading board…" /></div>;
  if (q.isError) return <div className="p-6"><ErrorBox error={q.error} /></div>;
  if (q.data.tasks.length === 0) {
    return (
      <div className="p-6 max-w-2xl mx-auto">
        <EmptyState>No tasks yet. Create one with <span className="mono text-fg-base">prove scrum task add</span>.</EmptyState>
      </div>
    );
  }

  const columns = bucketByStatus(q.data.tasks);

  return (
    <div className="p-4 h-full">
      <div className="flex gap-3 h-full overflow-x-auto pb-4">
        {TASK_STATUSES.map((status) => (
          <Column key={status} status={status} tasks={columns[status]} />
        ))}
      </div>
    </div>
  );
}

function Column({ status, tasks }: { status: TaskStatus; tasks: ScrumTask[] }) {
  const meta = statusMeta(status);
  return (
    <section
      aria-label={`${meta.label} column`}
      className="w-72 shrink-0 flex flex-col min-h-0 rounded-md border border-bg-line bg-bg-deep"
    >
      <header className="shrink-0 h-9 px-3 flex items-center gap-2 border-b border-bg-line">
        <span
          className="w-2 h-2 rounded-full"
          style={{ background: meta.color }}
          aria-hidden
        />
        <span className="text-fg-bright font-semibold text-[13px]">{meta.label}</span>
        <span className="ml-auto mono text-[11.5px] text-fg-faint tabular-nums">{tasks.length}</span>
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-2">
        {tasks.length === 0 ? (
          <div className="text-center text-fg-faint text-[11.5px] py-6 mono">empty</div>
        ) : (
          tasks.map((t) => <TaskCard key={t.id} task={t} compact />)
        )}
      </div>
    </section>
  );
}

function bucketByStatus(tasks: ScrumTask[]): Record<TaskStatus, ScrumTask[]> {
  const out: Record<TaskStatus, ScrumTask[]> = {
    backlog: [],
    ready: [],
    in_progress: [],
    review: [],
    blocked: [],
    done: [],
    cancelled: [],
  };
  for (const t of tasks) {
    out[t.status].push(t);
  }
  return out;
}
