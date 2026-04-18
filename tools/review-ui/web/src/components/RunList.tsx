import { useQuery } from "@tanstack/react-query";
import { api, type RunStatus } from "../lib/api";
import { useSelection } from "../lib/store";
import { cn } from "../lib/cn";

function relTime(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

type StatusMeta = { label: string; dot: string; text: string };

function statusMeta(s: RunStatus): StatusMeta {
  switch (s) {
    case "running":
      return { label: "Running", dot: "bg-phos", text: "text-phos" };
    case "pending":
      return { label: "Pending", dot: "bg-amber", text: "text-amber" };
    case "completed":
      return { label: "Done", dot: "bg-ok", text: "text-ok" };
    case "failed":
      return { label: "Failed", dot: "bg-anom", text: "text-anom" };
    case "halted":
      return { label: "Halted", dot: "bg-anom", text: "text-anom" };
    default:
      return { label: "Idle", dot: "bg-fg-faint", text: "text-fg-dim" };
  }
}

export function RunList() {
  const { data } = useQuery({ queryKey: ["runs"], queryFn: api.runs });
  const selectedSlug = useSelection((s) => s.slug);
  const selectRun = useSelection((s) => s.selectRun);
  const runs = data?.runs ?? [];

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="shrink-0 px-4 h-10 flex items-center justify-between bg-bg-deep border-b border-bg-line">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-fg-bright text-[13px]">Runs</span>
          <span className="mono text-[11px] text-fg-faint tabular-nums">{runs.length}</span>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {runs.length === 0 && (
          <div className="px-4 py-10 text-center text-[12.5px] text-fg-dim">
            No runs yet.
            <div className="text-[11.5px] text-fg-faint mt-1">
              Launch <code className="mono text-phos">/prove:full-auto</code> to get started.
            </div>
          </div>
        )}
        {runs.map((run) => {
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
              <span
                className={cn("mt-1.5 w-2 h-2 rounded-full shrink-0", meta.dot)}
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="mono text-[11px] text-fg-faint truncate">
                    {run.branch}/
                  </span>
                  <span className="mono text-[13px] text-fg-bright truncate font-medium">
                    {run.slug}
                  </span>
                </div>
                <div className="flex items-center gap-3 mt-1">
                  <span className={cn("text-[11px]", meta.text)}>{meta.label}</span>
                  <span className="text-[11px] text-fg-faint tabular-nums">
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
