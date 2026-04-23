import { useQuery } from "@tanstack/react-query";
import type { ScrumEvent, ScrumTask } from "@claude-prove/cli/scrum/types";
import { scrumApi, type BrokenDep } from "../../lib/scrumApi";
import { EmptyState, ErrorBox, Loading, TaskCard, relTime } from "./_components";

const STALE_MS = 30_000;

/**
 * Alerts view. Four sections surface the pathologies the server computes:
 *   - stalled_wip:      in-progress tasks with no event in the last 7 days
 *   - broken_deps:      deps pointing at soft-deleted / missing tasks
 *   - missing_context:  in-progress tasks with no context bundle
 *   - orphaned_runs:    recent `unlinked_run_detected` events
 *
 * Each section renders independently from the single `/api/scrum/alerts`
 * payload so an empty category shows its own "all clear" state.
 */
export function ScrumAlertsView() {
  const q = useQuery({
    queryKey: ["scrum", "alerts"],
    queryFn: () => scrumApi.alerts(),
    staleTime: STALE_MS,
  });

  if (q.isPending) return <div className="p-6"><Loading label="Loading alerts…" /></div>;
  if (q.isError) return <div className="p-6"><ErrorBox error={q.error} /></div>;

  const { stalled_wip, broken_deps, missing_context, orphaned_runs } = q.data;
  const totalAlerts =
    stalled_wip.length + broken_deps.length + missing_context.length + orphaned_runs.length;

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {totalAlerts === 0 && (
        <EmptyState>All clear. No alerts across any category.</EmptyState>
      )}

      <AlertSection title="Stalled WIP" count={stalled_wip.length} hint="In-progress with no event in 7 days.">
        {stalled_wip.length === 0 ? (
          <AllClear />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {stalled_wip.map((t) => <TaskCard key={t.id} task={t} />)}
          </div>
        )}
      </AlertSection>

      <AlertSection title="Broken dependencies" count={broken_deps.length} hint="Deps pointing at deleted tasks.">
        {broken_deps.length === 0 ? <AllClear /> : <BrokenDepsList items={broken_deps} />}
      </AlertSection>

      <AlertSection title="Missing context" count={missing_context.length} hint="In-progress without a context bundle.">
        {missing_context.length === 0 ? (
          <AllClear />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {missing_context.map((t: ScrumTask) => <TaskCard key={t.id} task={t} />)}
          </div>
        )}
      </AlertSection>

      <AlertSection title="Orphaned runs" count={orphaned_runs.length} hint="Runs detected without a task link.">
        {orphaned_runs.length === 0 ? <AllClear /> : <OrphanList events={orphaned_runs} />}
      </AlertSection>
    </div>
  );
}

function AlertSection({
  title,
  count,
  hint,
  children,
}: {
  title: string;
  count: number;
  hint: string;
  children: React.ReactNode;
}) {
  const tone = count === 0 ? "#6272a4" : count >= 3 ? "#ff5555" : "#ffb86c";
  return (
    <section aria-labelledby={`alert-${title}`}>
      <header className="flex items-baseline gap-2 mb-2">
        <h3 id={`alert-${title}`} className="text-fg-bright font-semibold text-[14px]">{title}</h3>
        <span
          className="mono text-[11.5px] px-1.5 h-5 rounded inline-flex items-center tabular-nums"
          style={{ color: tone, border: `1px solid ${tone}55`, background: `${tone}14` }}
        >
          {count}
        </span>
        <span className="text-[11.5px] text-fg-faint">{hint}</span>
      </header>
      {children}
    </section>
  );
}

function AllClear() {
  return (
    <div className="p-3 rounded-md border border-bg-line bg-bg-deep/40 text-fg-faint text-[12.5px] text-center mono">
      clear
    </div>
  );
}

function BrokenDepsList({ items }: { items: BrokenDep[] }) {
  return (
    <ul className="divide-y divide-bg-line border border-bg-line rounded-md bg-bg-panel">
      {items.map((d, i) => (
        <li key={`${d.task_id}-${d.missing_to_task_id}-${i}`} className="px-3 h-9 flex items-center gap-3 text-[12.5px] mono">
          <span className="text-fg-bright">{d.task_id.slice(0, 12)}</span>
          <span className="text-fg-faint">{d.kind}</span>
          <span className="text-anom">→ {d.missing_to_task_id.slice(0, 12)}</span>
          <span className="ml-auto text-anom/80 text-[11.5px]">missing</span>
        </li>
      ))}
    </ul>
  );
}

function OrphanList({ events }: { events: ScrumEvent[] }) {
  return (
    <ul className="divide-y divide-bg-line border border-bg-line rounded-md bg-bg-panel">
      {events.map((e) => {
        const payload = e.payload as { run_path?: string; slug?: string } | null;
        return (
          <li key={e.id} className="px-3 h-9 flex items-center gap-3 text-[12.5px] mono">
            <span className="text-amber">⚠</span>
            <span className="text-fg-bright truncate">{payload?.slug ?? payload?.run_path ?? "(unknown)"}</span>
            <span className="ml-auto text-fg-faint">{relTime(e.ts)}</span>
          </li>
        );
      })}
    </ul>
  );
}
