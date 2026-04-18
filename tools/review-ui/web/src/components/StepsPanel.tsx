import { useQuery } from "@tanstack/react-query";
import { api, type PlanStep, type PlanTaskView, type StepStatus } from "../lib/api";
import { useSelection } from "../lib/store";
import { cn } from "../lib/cn";
import { PanelLoading } from "./PanelLoading";

export function StepsPanel() {
  const slug = useSelection((s) => s.slug);
  const selectedSha = useSelection((s) => s.commitSha);
  const selectCommit = useSelection((s) => s.selectCommit);
  const setRightTab = useSelection((s) => s.setRightTab);

  const { data, isPending, isFetching, isError } = useQuery({
    queryKey: ["tasks", slug],
    queryFn: () => api.tasks(slug!),
    enabled: !!slug,
    retry: false,
  });

  const tasks: PlanTaskView[] = data?.tasks ?? [];
  const steps: PlanStep[] = tasks.flatMap((t) => t.steps);
  const done = steps.filter((s) => s.status === "completed").length;
  const pct = steps.length ? Math.round((done / steps.length) * 100) : 0;

  if (!slug) return <Empty text="Select a run" />;
  if (isPending || (isFetching && !data)) return <PanelLoading label="LOADING PLAN" />;
  if (isError || steps.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center p-8 gap-3">
        <div className="label text-amber">PLAN.JSON NOT AVAILABLE</div>
        <div className="text-[12px] font-mono text-fg-dim max-w-xs">
          Plan not yet written for this run. Steps will populate once the orchestrator produces{" "}
          <code className="text-phos bg-bg-panel px-1 border border-bg-line">
            .prove/runs/{slug}/plan.json
          </code>
          .
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="shrink-0 bg-bg-deep border-b border-bg-line">
        <div className="px-3 h-8 flex items-center gap-3">
          <span className="label label-bright">STEP SEQUENCE</span>
          <span className="font-mono text-[10.5px] text-fg-dim tabular-nums">
            {done.toString().padStart(2, "0")} / {steps.length.toString().padStart(2, "0")}
          </span>
          <span className="ml-auto font-mono text-[10.5px] text-phos tabular-nums">{pct}%</span>
        </div>
        <div className="h-[3px] w-full bg-bg-line/60">
          <div
            className="h-full bg-phos shadow-phos transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {tasks.map((task) => (
          <div key={task.id}>
            <div className="px-3 py-1.5 bg-bg-panel border-y border-bg-line font-mono text-[11px] flex items-center gap-2">
              <span className="label text-fg-dim">TASK {task.id}</span>
              <span className="truncate text-fg-base">{task.title}</span>
              {task.review.verdict !== "pending" && task.review.verdict !== "n/a" && (
                <span
                  className={cn(
                    "ml-auto px-1.5 py-[1px] text-[9.5px] tracking-wide2 font-semibold uppercase",
                    task.review.verdict === "approved"
                      ? "bg-phos/15 text-phos border border-phos/40"
                      : "bg-anom/15 text-anom border border-anom/40",
                  )}
                >
                  {task.review.verdict}
                </span>
              )}
            </div>
            {task.steps.map((s, i) => {
              const active = s.commitSha === selectedSha && !!selectedSha;
              const glyph = statusGlyph(s.status);
              const color = statusColor(s.status);
              return (
                <button
                  key={s.id}
                  onClick={() => {
                    if (s.commitSha) {
                      selectCommit(s.commitSha);
                      setRightTab("diff");
                    }
                  }}
                  disabled={!s.commitSha}
                  className={cn(
                    "w-full text-left px-3 py-2.5 flex gap-3 border-l-2 border-b border-bg-line/60 font-mono text-[12.5px] transition-colors",
                    active
                      ? "bg-bg-raised border-l-phos text-fg-bright"
                      : "border-l-transparent hover:bg-bg-panel text-fg-base disabled:opacity-50 disabled:hover:bg-transparent",
                  )}
                >
                  <span className="text-fg-dim tabular-nums w-6 text-[10.5px] mt-0.5">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span className={cn("font-bold shrink-0 w-4 mt-0.5", color)}>{glyph}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="label text-fg-dim">{s.id}</span>
                      {s.commitSha && (
                        <span className="ml-auto font-mono text-[10px] text-fg-dim">
                          {s.commitSha.slice(0, 9)}
                        </span>
                      )}
                    </div>
                    <div className="text-[12.5px] leading-snug break-words">{s.title}</div>
                    <ValidatorChips summary={s.validatorSummary} />
                    {s.haltReason && (
                      <div className="mt-1 text-[10.5px] text-anom line-clamp-2">
                        HALT: {s.haltReason}
                      </div>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function ValidatorChips({ summary }: { summary: PlanStep["validatorSummary"] }) {
  const phases: Array<keyof PlanStep["validatorSummary"]> = [
    "build",
    "lint",
    "test",
    "custom",
    "llm",
  ];
  const any = phases.some((p) => summary[p] !== "pending");
  if (!any) return null;
  return (
    <div className="mt-1 flex gap-1 flex-wrap">
      {phases.map((p) => {
        const v = summary[p];
        if (v === "pending") return null;
        const tone =
          v === "pass"
            ? "text-phos border-phos/40 bg-phos/10"
            : v === "fail"
              ? "text-anom border-anom/40 bg-anom/10"
              : "text-fg-dim border-bg-line bg-bg-panel";
        return (
          <span
            key={p}
            className={cn(
              "px-1 py-[1px] text-[9.5px] tracking-wide2 font-semibold uppercase border",
              tone,
            )}
          >
            {p.slice(0, 3)} {v.slice(0, 4)}
          </span>
        );
      })}
    </div>
  );
}

function statusGlyph(s: StepStatus): string {
  switch (s) {
    case "completed":
      return "●";
    case "in_progress":
      return "◐";
    case "failed":
      return "✕";
    case "halted":
      return "⊘";
    case "skipped":
      return "—";
    case "pending":
      return "○";
    default:
      return "·";
  }
}

function statusColor(s: StepStatus): string {
  switch (s) {
    case "completed":
      return "text-phos";
    case "in_progress":
      return "text-amber animate-pulse";
    case "failed":
    case "halted":
      return "text-anom";
    default:
      return "text-fg-dim";
  }
}

function Empty({ text }: { text: string }) {
  return <div className="flex h-full items-center justify-center text-fg-dim label">{text}</div>;
}
