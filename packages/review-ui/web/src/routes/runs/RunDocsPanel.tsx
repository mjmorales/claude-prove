import { useEffect, useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { api, type PlanStep, type PlanTaskView, type ValidatorPhase } from "../../lib/api";
import { useActiveProject } from "../../lib/active-project";
import { useRunsSelection } from "./store";
import { DOCS, renderDoc } from "./run-docs";
import { cn } from "../../lib/cn";
import { Markdown } from "../../components/Markdown";
import { PanelLoading } from "../../components/PanelLoading";
import { Empty } from "../../components/Empty";

const VALIDATOR_PHASES: ValidatorPhase[] = ["build", "lint", "test", "custom", "llm"];

/**
 * Project-scoped run-detail view. Surfaces the run's plan/prd/state docs as
 * rendered markdown plus a validator-summary rollup across every plan step. Doc
 * probes and the tasks fetch all key off `[..., projectKey, slug, ...]` so a
 * project switch invalidates cleanly.
 */
export function RunDocsPanel() {
  const { projectKey } = useActiveProject();
  const slug = useRunsSelection((s) => s.slug);
  const view = useRunsSelection((s) => s.docView);
  const setView = useRunsSelection((s) => s.setDocView);

  const probes = useQueries({
    queries: DOCS.map((d) => ({
      queryKey: ["doc", projectKey, slug, d.file],
      queryFn: () => api.doc(slug!, d.file),
      enabled: !!slug,
      retry: false,
      staleTime: 10_000,
    })),
  });
  // Collapse probe statuses to one primitive so the auto-switch effect only
  // re-runs on a real status transition, not on every fresh useQueries array.
  const probeStatusKey = probes.map((p) => p.status).join(",");
  const availability = useMemo(
    () =>
      DOCS.map((d, i) => ({
        id: d.id,
        available: probes[i].status === "success",
        pending: probes[i].status === "pending",
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [probeStatusKey],
  );

  useEffect(() => {
    if (!slug) return;
    const currentIdx = DOCS.findIndex((d) => d.id === view);
    if (availability[currentIdx]?.available) return;
    if (availability.some((a) => a.pending)) return;
    const firstAvail = availability.find((a) => a.available);
    if (firstAvail) setView(firstAvail.id);
  }, [slug, view, availability, setView]);

  const { data: tasksData } = useQuery({
    queryKey: ["tasks", projectKey, slug],
    queryFn: () => api.tasks(slug!),
    enabled: !!slug,
    retry: false,
  });

  const doc = DOCS.find((d) => d.id === view)!;
  const currentProbe = probes[DOCS.findIndex((d) => d.id === view)];
  const raw = (currentProbe?.data as { content?: string } | undefined)?.content ?? "";
  const rendered = raw ? renderDoc(raw, doc.id) : "";

  if (!slug) return <Empty text="Select a run" />;

  const anyAvailable = availability.some((a) => a.available);

  return (
    <div className="flex flex-col h-full min-h-0">
      <ValidatorRollup tasks={tasksData?.tasks ?? []} />
      <div className="shrink-0 flex items-stretch border-b border-bg-line bg-bg-deep">
        {DOCS.map((d, i) => {
          const avail = availability[i];
          const active = view === d.id;
          return (
            <button
              key={d.id}
              onClick={() => setView(d.id)}
              className={cn(
                "px-3 h-8 text-[10.5px] font-mono tracking-wide2 font-semibold transition-colors border-r border-bg-line flex items-center gap-1.5",
                active
                  ? "text-phos bg-bg-panel"
                  : avail.available
                    ? "text-fg-dim hover:text-fg-base hover:bg-bg-panel/60"
                    : "text-fg-faint",
              )}
              title={avail.available ? d.file : `${d.file} — not available`}
            >
              <span
                className={cn(
                  "w-[5px] h-[5px] rounded-full",
                  avail.available ? "bg-phos shadow-phos" : "bg-fg-faint",
                )}
              />
              {d.label}
            </button>
          );
        })}
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-thin p-5">
        {!anyAvailable && probes.every((p) => p.status !== "pending") ? (
          <div className="flex h-full flex-col items-center justify-center text-center gap-3">
            <div className="label text-amber">NO DOCS YET</div>
            <div className="text-[12px] font-mono text-fg-dim max-w-sm">
              Run in-flight. prd.json / plan.json / state.json will populate as the orchestrator
              writes them to{" "}
              <code className="text-phos bg-bg-panel px-1 border border-bg-line">
                .prove/runs/{slug}/
              </code>
              .
            </div>
          </div>
        ) : currentProbe?.status === "pending" ? (
          <PanelLoading label={`LOADING ${doc.file}`} />
        ) : currentProbe?.status === "error" ? (
          <div className="flex h-full flex-col items-center justify-center text-center gap-2">
            <div className="label text-amber">{doc.file} — NOT AVAILABLE</div>
            <div className="text-[11px] font-mono text-fg-dim">
              switch to a doc with a pulsing indicator
            </div>
          </div>
        ) : (
          <Markdown source={rendered} />
        )}
      </div>
    </div>
  );
}

/** Aggregate validator verdicts across every step into one per-phase tally so
 * the run's overall gate health reads at a glance above the doc body. */
function ValidatorRollup({ tasks }: { tasks: PlanTaskView[] }) {
  const steps: PlanStep[] = tasks.flatMap((t) => t.steps);
  if (steps.length === 0) return null;
  const tally = VALIDATOR_PHASES.map((phase) => {
    let pass = 0;
    let fail = 0;
    for (const step of steps) {
      const v = step.validatorSummary[phase];
      if (v === "pass") pass += 1;
      else if (v === "fail") fail += 1;
    }
    return { phase, pass, fail };
  }).filter((t) => t.pass > 0 || t.fail > 0);

  if (tally.length === 0) return null;
  return (
    <div className="shrink-0 px-3 h-8 flex items-center gap-2 bg-bg-deep border-b border-bg-line">
      <span className="label label-bright">VALIDATORS</span>
      <div className="flex items-center gap-1 flex-wrap">
        {tally.map(({ phase, pass, fail }) => (
          <span
            key={phase}
            className={cn(
              "px-1.5 py-[1px] text-[9.5px] tracking-wide2 font-semibold uppercase border",
              fail > 0
                ? "text-anom border-anom/40 bg-anom/10"
                : "text-phos border-phos/40 bg-phos/10",
            )}
            title={`${phase}: ${pass} pass / ${fail} fail`}
          >
            {phase.slice(0, 3)} {pass}✓{fail > 0 ? ` ${fail}✕` : ""}
          </span>
        ))}
      </div>
    </div>
  );
}
