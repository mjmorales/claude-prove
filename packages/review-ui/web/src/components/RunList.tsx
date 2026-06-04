import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useSelection } from "../lib/store";
import { useActiveProject } from "../lib/active-project";
import { cn } from "../lib/cn";
import { FILTER_GROUPS, FilterChip, relTime, statusMeta } from "../lib/run-list-presentation";

export function RunList() {
  const { projectKey } = useActiveProject();
  const { data } = useQuery({ queryKey: ["runs", projectKey], queryFn: api.runs });
  const selectedSlug = useSelection((s) => s.slug);
  const selectRun = useSelection((s) => s.selectRun);
  const runs = data?.runs ?? [];

  const [query, setQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filterGroup = activeFilter
      ? FILTER_GROUPS.find((g) => g.id === activeFilter)
      : null;
    return runs.filter((r) => {
      if (filterGroup && !filterGroup.statuses.includes(r.progress.runStatus)) return false;
      if (q) {
        const hay = `${r.branch}/${r.slug}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [runs, query, activeFilter]);

  return (
    <div className="flex flex-col h-full min-h-0">
      {runs.length > 0 && (
        <div className="shrink-0 border-b border-bg-line bg-bg-deep/60">
          <div className="px-3 py-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter runs…"
              className="w-full h-7 px-2 rounded border border-bg-line bg-bg-void text-[12.5px] text-fg-base placeholder:text-fg-faint focus:outline-none focus:border-phos"
            />
          </div>
          <div className="px-3 pb-2 flex items-center gap-1.5">
            <FilterChip
              label="All"
              active={activeFilter === null}
              onClick={() => setActiveFilter(null)}
            />
            {FILTER_GROUPS.map((g) => (
              <FilterChip
                key={g.id}
                label={g.label}
                active={activeFilter === g.id}
                onClick={() => setActiveFilter(activeFilter === g.id ? null : g.id)}
              />
            ))}
          </div>
        </div>
      )}
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {runs.length === 0 && (
          <div className="px-4 py-10 text-center text-[13px] text-fg-dim">
            No runs yet.
            <div className="text-[12px] text-fg-faint mt-1">
              Launch <code className="mono text-phos">/prove:orchestrator --full</code> to get started.
            </div>
          </div>
        )}
        {runs.length > 0 && filtered.length === 0 && (
          <div className="px-4 py-6 text-center text-[12.5px] text-fg-dim">
            No runs match your filter.
          </div>
        )}
        {filtered.map((run) => {
          const active = run.composite === selectedSlug;
          const meta = statusMeta(run.progress.runStatus);
          return (
            <button
              key={run.composite}
              onClick={() => selectRun(run.composite)}
              className={cn(
                "row w-full text-left px-4 py-3 flex items-start gap-3 border-b border-bg-line/50",
                active && "is-active",
              )}
            >
              <span className={cn("mt-1.5 w-2 h-2 rounded-full shrink-0", meta.dot)} aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="mono text-[11.5px] text-fg-faint truncate">
                    {run.branch}/
                  </span>
                  <span className="mono text-[13.5px] text-fg-bright truncate font-medium">
                    {run.slug}
                  </span>
                </div>
                <div className="flex items-center gap-3 mt-1">
                  <span className={cn("text-[11.5px]", meta.text)}>{meta.label}</span>
                  <span className="text-[11.5px] text-fg-faint tabular-nums">
                    {run.lastActivity ? relTime(run.lastActivity) : "—"}
                  </span>
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
