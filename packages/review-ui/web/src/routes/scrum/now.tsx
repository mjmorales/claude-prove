import { useQuery } from "@tanstack/react-query";
import type { ScrumEvent } from "@claude-prove/cli/scrum/types";
import { scrumApi } from "../../lib/scrumApi";
import { EmptyState, ErrorBox, Loading, TaskCard, relTime } from "./_components";

const STALE_MS = 30_000;

/**
 * "Now" view — the dashboard home page. Three stacked sections:
 *   1. Active in-progress tasks (the current WIP set)
 *   2. In-flight runs (task-linked events still in `run_started` state)
 *   3. Recent events feed (cross-task activity tail)
 *
 * All three queries hit `/api/scrum/*` with a 30s stale time. Data flows
 * one-way: no mutation UI, no optimistic updates.
 */
export function ScrumNowView() {
  const inProgress = useQuery({
    queryKey: ["scrum", "tasks", { status: "in_progress" }],
    queryFn: () => scrumApi.tasks({ status: "in_progress" }),
    staleTime: STALE_MS,
  });
  const recent = useQuery({
    queryKey: ["scrum", "events", "recent", 50],
    queryFn: () => scrumApi.recentEvents(50),
    staleTime: STALE_MS,
  });

  const inFlightRuns = (recent.data?.events ?? []).filter(
    (e) => e.kind === "run_started",
  );

  return (
    <div className="p-6 space-y-8 max-w-6xl mx-auto">
      <section aria-labelledby="now-active">
        <h2 id="now-active" className="eyebrow mb-3">Active tasks</h2>
        {inProgress.isPending && <Loading label="Loading active tasks…" />}
        {inProgress.isError && <ErrorBox error={inProgress.error} />}
        {inProgress.isSuccess && inProgress.data.tasks.length === 0 && (
          <EmptyState>No active tasks. Run <span className="mono text-fg-base">prove scrum next</span> to pick one up.</EmptyState>
        )}
        {inProgress.isSuccess && inProgress.data.tasks.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {inProgress.data.tasks.map((t) => (
              <TaskCard key={t.id} task={t} />
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="now-runs">
        <h2 id="now-runs" className="eyebrow mb-3">In-flight runs</h2>
        {recent.isPending && <Loading label="Loading runs…" />}
        {recent.isError && <ErrorBox error={recent.error} />}
        {recent.isSuccess && inFlightRuns.length === 0 && (
          <EmptyState>No runs currently in flight.</EmptyState>
        )}
        {inFlightRuns.length > 0 && (
          <ul className="space-y-1.5">
            {inFlightRuns.map((e) => (
              <RunRow key={e.id} event={e} />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="now-feed">
        <h2 id="now-feed" className="eyebrow mb-3">Recent events</h2>
        {recent.isPending && <Loading label="Loading events…" />}
        {recent.isError && <ErrorBox error={recent.error} />}
        {recent.isSuccess && recent.data.events.length === 0 && (
          <EmptyState>No recent events.</EmptyState>
        )}
        {recent.data && recent.data.events.length > 0 && (
          <ul className="divide-y divide-bg-line border border-bg-line rounded-md bg-bg-panel">
            {recent.data.events.slice(0, 50).map((e) => (
              <EventRow key={e.id} event={e} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function RunRow({ event }: { event: ScrumEvent }) {
  const payload = event.payload as { run_path?: string; slug?: string } | null;
  return (
    <li className="flex items-center gap-3 px-3 h-9 rounded-md border border-bg-line bg-bg-panel text-[12.5px] mono">
      <span className="text-phos">▶</span>
      <span className="text-fg-bright truncate">{payload?.slug ?? payload?.run_path ?? "(unknown run)"}</span>
      <span className="ml-auto text-fg-faint">task:{event.task_id.slice(0, 8)}</span>
      <span className="text-fg-faint">{relTime(event.ts)}</span>
    </li>
  );
}

function EventRow({ event }: { event: ScrumEvent }) {
  return (
    <li className="flex items-center gap-3 px-3 h-8 text-[12px] mono">
      <span className="text-fg-faint w-28 shrink-0">{relTime(event.ts)}</span>
      <span className="text-data w-32 shrink-0 truncate">{event.kind}</span>
      <span className="text-fg-dim w-28 shrink-0 truncate">task:{event.task_id.slice(0, 8)}</span>
      {event.agent && <span className="text-phos truncate">{event.agent}</span>}
    </li>
  );
}
