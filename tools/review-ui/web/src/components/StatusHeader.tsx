import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useSelection } from "../lib/store";
import { useConnection } from "../hooks/useConnection";
import { cn } from "../lib/cn";

export function StatusHeader({ onOpenPalette }: { onOpenPalette: () => void }) {
  const { state } = useConnection();
  const slug = useSelection((s) => s.slug);
  const branch = useSelection((s) => s.branch);
  const reviewMode = useSelection((s) => s.reviewMode);
  const setReviewMode = useSelection((s) => s.setReviewMode);
  const { data: runs } = useQuery({ queryKey: ["runs"], queryFn: api.runs });
  const { data: tasks } = useQuery({
    queryKey: ["tasks", slug],
    queryFn: () => api.tasks(slug!),
    enabled: !!slug,
    retry: false,
  });

  const run = runs?.runs.find((r) => r.composite === slug);
  const allSteps = (tasks?.tasks ?? []).flatMap((t) => t.steps);
  const done = allSteps.filter((s) => s.status === "completed").length;
  const total = allSteps.length;
  const pct = total ? Math.round((done / total) * 100) : 0;

  const connTone =
    state === "live" ? "ok" : state === "stale" ? "amber" : state === "down" ? "anom" : "dim";
  const connLabel =
    state === "live" ? "Live" : state === "stale" ? "Stale" : state === "down" ? "Offline" : "Idle";

  return (
    <header className="shrink-0 border-b border-bg-line bg-bg-deep">
      <div className="h-12 px-4 flex items-center gap-5">
        {/* Brand */}
        <div className="flex items-center gap-2.5 pr-4 border-r border-bg-line h-6">
          <span className="w-2 h-2 rounded-full bg-phos shadow-phos" />
          <span className="font-mono font-bold text-[14px] text-fg-bright">prove</span>
          <span className="mono text-[13px] text-fg-faint">/</span>
          <span className="mono text-[13px] text-fg-dim">review</span>
        </div>

        {/* Run context */}
        <div className="flex items-center gap-4 min-w-0 flex-1">
          {slug ? (
            <>
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-[11px] uppercase tracking-wider text-fg-faint">Run</span>
                <span className="mono text-[12.5px] text-fg-bright truncate max-w-[320px]">
                  {run ? `${run.branch}/${run.slug}` : slug}
                </span>
              </div>
              {branch && (
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-[11px] uppercase tracking-wider text-fg-faint">Branch</span>
                  <span className="mono text-[12.5px] text-data truncate max-w-[280px]">{branch}</span>
                </div>
              )}
              {total > 0 && (
                <div className="flex items-center gap-2">
                  <span className="text-[11px] uppercase tracking-wider text-fg-faint">Progress</span>
                  <ProgressChip pct={pct} done={done} total={total} />
                </div>
              )}
            </>
          ) : (
            <span className="text-fg-dim text-[13px]">Select a run to begin</span>
          )}
        </div>

        {/* Connection + actions */}
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2 px-3 h-8 rounded-md border border-bg-line bg-bg-panel">
            <span
              className={cn(
                "led",
                connTone === "ok" && "led-ok",
                connTone === "amber" && "led-amber",
                connTone === "anom" && "led-red",
                connTone === "dim" && "led-dim",
              )}
            />
            <span className="mono text-[11.5px] text-fg-base">{connLabel}</span>
          </div>

          <button
            onClick={onOpenPalette}
            className="btn btn-ghost btn-sm"
            title="Command palette"
          >
            <span>Commands</span>
            <span className="kbd">⌘K</span>
          </button>

          <button
            onClick={() => setReviewMode(!reviewMode)}
            disabled={!slug}
            title={slug ? "Open review mode" : "Select a run first"}
            className={cn(
              "btn",
              reviewMode ? "btn-primary" : "btn-ghost",
              !slug && "is-disabled",
            )}
          >
            <span className="text-[14px] leading-none">{reviewMode ? "◉" : "▶"}</span>
            <span>{reviewMode ? "Reviewing" : "Review"}</span>
            <span className={cn("kbd", reviewMode && "kbd-on-solid")}>⇧R</span>
          </button>
        </div>
      </div>
    </header>
  );
}

function ProgressChip({ pct, done, total }: { pct: number; done: number; total: number }) {
  const color = pct === 100 ? "#50fa7b" : pct >= 50 ? "#bd93f9" : "#ffb86c";
  return (
    <div className="flex items-center gap-2">
      <div className="relative w-28 h-1.5 bg-bg-raised rounded-full overflow-hidden">
        <div
          className="absolute inset-y-0 left-0 rounded-full transition-all"
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
      <span className="mono text-[11.5px] tabular-nums text-fg-base">
        {done}/{total}
        <span className="text-fg-faint ml-1.5">{pct}%</span>
      </span>
    </div>
  );
}
