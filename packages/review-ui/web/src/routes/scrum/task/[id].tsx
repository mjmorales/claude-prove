import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type {
  ScrumDep,
  ScrumEvent,
  ScrumRunLink,
  ScrumTask,
} from "@claude-prove/cli/scrum/types";
import { scrumApi } from "../../../lib/scrumApi";
import { useScrumSelection } from "../../../lib/scrumStore";
import {
  EmptyState,
  ErrorBox,
  Loading,
  StatusPill,
  relTime,
} from "../_components";

const STALE_MS = 30_000;

/**
 * Task detail. Five stacked panels:
 *   1. metadata header
 *   2. event timeline (chronological, oldest→newest)
 *   3. linked runs (clickable when the run has a branch+slug → /acb?run=…)
 *   4. linked decisions (from decision_linked events)
 *   5. collapsible context-bundle JSON viewer (lazy-fetched)
 *
 * The selected-task id is mirrored into the scrum selection store on mount
 * so deep-linking `/scrum/task/:id` also populates `?task=<id>` via
 * `useScrumUrlState`.
 */
export function ScrumTaskDetailView() {
  const { id = "" } = useParams<{ id: string }>();
  const setTaskId = useScrumSelection((s) => s.setTaskId);

  useEffect(() => {
    if (id) setTaskId(id);
  }, [id, setTaskId]);

  const q = useQuery({
    queryKey: ["scrum", "task", id],
    queryFn: () => scrumApi.task(id),
    staleTime: STALE_MS,
    enabled: !!id,
  });

  if (!id) return <div className="p-6"><ErrorBox error={new Error("missing task id")} /></div>;
  if (q.isPending) return <div className="p-6"><Loading label="Loading task…" /></div>;
  if (q.isError) return <div className="p-6"><ErrorBox error={q.error} /></div>;

  const { task, tags, events, runs, decisions, blocked_by, blocking } = q.data;

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <MetadataHeader task={task} tags={tags} blockedBy={blocked_by} blocking={blocking} />

      <section aria-labelledby="td-timeline">
        <h2 id="td-timeline" className="eyebrow mb-2">Timeline</h2>
        {events.length === 0 ? (
          <EmptyState>No events recorded.</EmptyState>
        ) : (
          <Timeline events={events} />
        )}
      </section>

      <section aria-labelledby="td-runs">
        <h2 id="td-runs" className="eyebrow mb-2">Linked runs</h2>
        {runs.length === 0 ? (
          <EmptyState>No runs linked.</EmptyState>
        ) : (
          <RunsList runs={runs} />
        )}
      </section>

      <section aria-labelledby="td-decisions">
        <h2 id="td-decisions" className="eyebrow mb-2">Linked decisions</h2>
        {decisions.length === 0 ? (
          <EmptyState>No decisions linked.</EmptyState>
        ) : (
          <DecisionsList decisions={decisions} />
        )}
      </section>

      <ContextBundlePanel taskId={id} />
    </div>
  );
}

function MetadataHeader({
  task,
  tags,
  blockedBy,
  blocking,
}: {
  task: ScrumTask;
  tags: string[];
  blockedBy: ScrumDep[];
  blocking: ScrumDep[];
}) {
  return (
    <header className="rounded-md border border-bg-line bg-bg-panel p-4">
      <div className="flex items-start gap-3">
        <StatusPill status={task.status} />
        <span className="mono text-[11.5px] text-fg-faint shrink-0">{task.id}</span>
      </div>
      <h1 className="mt-2 text-[18px] text-fg-bright font-semibold leading-snug">{task.title}</h1>
      {task.description && (
        <p className="mt-2 text-[13px] text-fg-base whitespace-pre-wrap">{task.description}</p>
      )}
      <dl className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-1 text-[12px] mono">
        <MetaCell label="Created" value={task.created_at} />
        <MetaCell label="Last event" value={task.last_event_at ?? "—"} />
        <MetaCell label="Milestone" value={task.milestone_id ?? "—"} />
        <MetaCell label="Created by" value={task.created_by_agent ?? "—"} />
      </dl>
      {tags.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {tags.map((tag) => (
            <span
              key={tag}
              className="px-1.5 h-5 rounded text-[11px] mono text-data bg-data/10 border border-data/30 inline-flex items-center"
            >
              {tag}
            </span>
          ))}
        </div>
      )}
      {(blockedBy.length > 0 || blocking.length > 0) && (
        <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3 text-[12px]">
          <DepList title="Blocked by" deps={blockedBy} field="from_task_id" />
          <DepList title="Blocks" deps={blocking} field="to_task_id" />
        </div>
      )}
    </header>
  );
}

function MetaCell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10.5px] uppercase tracking-wider text-fg-faint">{label}</dt>
      <dd className="text-fg-base">{value}</dd>
    </div>
  );
}

function DepList({
  title,
  deps,
  field,
}: {
  title: string;
  deps: ScrumDep[];
  field: "from_task_id" | "to_task_id";
}) {
  if (deps.length === 0) return null;
  return (
    <div>
      <h4 className="text-[10.5px] uppercase tracking-wider text-fg-faint mb-1">{title}</h4>
      <ul className="space-y-1">
        {deps.map((d, i) => (
          <li key={`${d[field]}-${i}`}>
            <Link
              to={`/scrum/task/${encodeURIComponent(d[field])}`}
              className="mono text-[12px] text-data hover:text-data-bright hover:underline"
            >
              {d[field]}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Timeline({ events }: { events: ScrumEvent[] }) {
  // Server returns newest-first; reverse for chronological top-down display.
  const sorted = [...events].sort((a, b) => a.ts.localeCompare(b.ts));
  return (
    <ol className="relative border-l border-bg-line ml-2 space-y-3">
      {sorted.map((e) => (
        <li key={e.id} className="ml-4 relative">
          <span className="absolute -left-[21px] top-1.5 w-2 h-2 rounded-full bg-phos" aria-hidden />
          <div className="rounded-md border border-bg-line bg-bg-panel px-3 py-2">
            <div className="flex items-baseline gap-3 text-[11.5px] mono">
              <span className="text-data">{e.kind}</span>
              {e.agent && <span className="text-phos">{e.agent}</span>}
              <span className="ml-auto text-fg-faint">{relTime(e.ts)}</span>
            </div>
            {e.payload !== null && e.payload !== undefined && (
              <pre className="mt-1.5 text-[11px] mono text-fg-dim whitespace-pre-wrap break-words">
                {safeStringify(e.payload)}
              </pre>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

function RunsList({ runs }: { runs: ScrumRunLink[] }) {
  return (
    <ul className="divide-y divide-bg-line border border-bg-line rounded-md bg-bg-panel">
      {runs.map((r, i) => {
        const composite = r.branch && r.slug ? `${r.branch}/${r.slug}` : null;
        return (
          <li key={`${r.run_path}-${i}`} className="px-3 h-10 flex items-center gap-3 text-[12.5px] mono">
            <span className="text-fg-bright truncate flex-1 min-w-0">{r.run_path}</span>
            {composite ? (
              <Link
                to={`/acb?run=${encodeURIComponent(composite)}`}
                className="text-phos hover:text-phos-bright hover:underline shrink-0"
              >
                open in ACB →
              </Link>
            ) : (
              <span className="text-fg-faint shrink-0" title="No ACB document found for this run">
                no ACB document
              </span>
            )}
            <span className="text-fg-faint shrink-0">{relTime(r.linked_at)}</span>
          </li>
        );
      })}
    </ul>
  );
}

function DecisionsList({
  decisions,
}: {
  decisions: Array<{ id: number; ts: string; payload: unknown }>;
}) {
  return (
    <ul className="divide-y divide-bg-line border border-bg-line rounded-md bg-bg-panel">
      {decisions.map((d) => {
        const p = d.payload as { path?: string; title?: string } | null;
        const path = p?.path ?? null;
        return (
          <li key={d.id} className="px-3 h-10 flex items-center gap-3 text-[12.5px] mono">
            <span className="text-amber">◆</span>
            {path ? (
              <a
                href={path.startsWith("http") ? path : `/${path}`}
                className="text-data hover:underline truncate flex-1 min-w-0"
                target={path.startsWith("http") ? "_blank" : undefined}
                rel={path.startsWith("http") ? "noreferrer" : undefined}
              >
                {p?.title ?? path}
              </a>
            ) : (
              <span className="text-fg-dim truncate flex-1 min-w-0">{p?.title ?? "(decision)"}</span>
            )}
            <span className="text-fg-faint shrink-0">{relTime(d.ts)}</span>
          </li>
        );
      })}
    </ul>
  );
}

function ContextBundlePanel({ taskId }: { taskId: string }) {
  const [open, setOpen] = useState(false);
  const q = useQuery({
    queryKey: ["scrum", "context-bundle", taskId],
    queryFn: () => scrumApi.contextBundle(taskId),
    staleTime: STALE_MS,
    enabled: open,
    retry: false,
  });

  return (
    <section aria-labelledby="td-bundle">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-2 text-left"
      >
        <span
          className="text-fg-faint text-[11px] transition-transform inline-block"
          style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)" }}
          aria-hidden
        >
          ▸
        </span>
        <h2 id="td-bundle" className="eyebrow !m-0">Context bundle</h2>
      </button>
      {open && (
        <div className="mt-2 rounded-md border border-bg-line bg-bg-panel p-3">
          {q.isPending && <Loading label="Loading bundle…" />}
          {q.isError && (
            <p className="text-fg-faint text-[12.5px] mono">No bundle available for this task.</p>
          )}
          {q.isSuccess && (
            <pre className="text-[11px] mono text-fg-base whitespace-pre-wrap break-words max-h-96 overflow-auto">
              {safeStringify(q.data)}
            </pre>
          )}
        </div>
      )}
    </section>
  );
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
