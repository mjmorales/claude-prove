import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useSelection } from "../lib/store";
import { cn } from "../lib/cn";
import { PanelLoading } from "./PanelLoading";

export function ContextPanel() {
  const slug = useSelection((s) => s.slug);

  const runQ = useQuery({
    queryKey: ["run", slug],
    queryFn: () => api.run(slug!),
    enabled: !!slug,
  });
  const tasksQ = useQuery({
    queryKey: ["tasks", slug],
    queryFn: () => api.tasks(slug!),
    enabled: !!slug,
    retry: false,
  });
  const stewardQ = useQuery({ queryKey: ["steward-reports"], queryFn: () => api.stewardReports() });

  if (!slug)
    return (
      <div className="h-full flex items-center justify-center text-fg-dim text-[13px]">
        Select a run
      </div>
    );

  if (runQ.isPending || tasksQ.isPending || stewardQ.isPending)
    return <PanelLoading label="LOADING CONTEXT" />;

  const run = runQ.data;
  const tasks = tasksQ.data?.tasks ?? [];
  const reports = stewardQ.data?.reports ?? [];

  const reviews = tasks
    .filter((t) => t.review.verdict !== "pending" && t.review.verdict !== "n/a")
    .map((t) => ({
      task: t.id,
      verdict: t.review.verdict.toUpperCase(),
      when: (t.review.reviewedAt || "").slice(11, 16),
      reviewer: t.review.reviewer || "—",
      notes: t.review.notes,
    }));

  const halts: Array<{ task: string; step: string; reason: string }> = [];
  for (const t of tasks) {
    for (const s of t.steps) {
      if (s.haltReason) halts.push({ task: t.id, step: s.id, reason: s.haltReason });
    }
  }

  return (
    <div className="h-full overflow-y-auto scrollbar-thin gridbg">
      <Block title="RUN STATUS" tone="phos">
        {run ? (
          <div className="grid grid-cols-3 gap-0 border-t border-bg-line">
            <KV
              k="STATUS"
              v={run.progress.runStatus}
              tone={run.progress.runStatus === "completed" ? "phos" : "amber"}
            />
            <KV k="STARTED" v={run.progress.startedAt || "—"} />
            <KV
              k="CURRENT"
              v={`${run.progress.currentTask || "—"} / ${run.progress.currentStep || "—"}`}
              mono
            />
          </div>
        ) : (
          <Dim text="NO STATE.JSON" />
        )}
      </Block>

      <Block title="REVIEW VERDICTS" tone="phos" count={reviews.length}>
        {reviews.length ? (
          <table className="w-full font-mono text-[12px]">
            <tbody>
              {reviews.map((r, i) => (
                <tr key={i} className="border-b border-bg-line/60">
                  <td className="px-4 py-1.5 text-fg-dim tabular-nums w-16">{r.when || "—"}</td>
                  <td className="px-2 py-1.5 text-fg-base">TASK {r.task}</td>
                  <td className="px-4 py-1.5 text-right">
                    <span
                      className={cn(
                        "px-2 py-[2px] text-[10px] tracking-wide2 font-semibold border",
                        r.verdict === "APPROVED"
                          ? "border-phos/40 text-phos bg-phos/10"
                          : r.verdict === "REJECTED"
                            ? "border-anom/40 text-anom bg-anom/10"
                            : "border-amber/40 text-amber bg-amber/10",
                      )}
                    >
                      {r.verdict}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Dim text="NO REVIEWS RECORDED" />
        )}
      </Block>

      <Block title="HALTS" tone="amber" count={halts.length}>
        {halts.length ? (
          <ul className="px-4 py-2 font-mono text-[12px] text-fg-base space-y-1">
            {halts.map((h, i) => (
              <li key={i} className="before:content-['!'] before:text-amber before:mr-2">
                <span className="text-fg-dim">
                  {h.task}/{h.step}
                </span>{" "}
                — {h.reason}
              </li>
            ))}
          </ul>
        ) : (
          <Dim text="ALL NOMINAL" />
        )}
      </Block>

      <Block title="STEWARD AUDITS" count={reports.length}>
        {reports.length ? (
          <table className="w-full font-mono text-[12px]">
            <tbody>
              {reports.map((r) => (
                <tr key={r.name} className="border-b border-bg-line/60">
                  <td className="px-4 py-1.5 text-fg-base truncate">{r.name}</td>
                  <td className="px-4 py-1.5 text-right text-fg-dim tabular-nums text-[11px]">
                    {(r.sizeBytes / 1024).toFixed(1)}k
                  </td>
                  <td className="px-4 py-1.5 text-right text-fg-dim text-[11px] whitespace-nowrap">
                    {new Date(r.mtime).toISOString().slice(0, 10)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Dim text="NO AUDITS" />
        )}
      </Block>
    </div>
  );
}

function Block({
  title,
  tone,
  count,
  children,
}: {
  title: string;
  tone?: "phos" | "amber" | "anom" | "data";
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <section className="border-b border-bg-line">
      <header className="h-8 px-4 flex items-center gap-3 bg-bg-deep">
        <span
          className={cn(
            "label",
            tone === "phos" && "label-phos",
            tone === "amber" && "text-amber",
            tone === "anom" && "text-anom",
            tone === "data" && "text-data",
            !tone && "label-bright",
          )}
        >
          {title}
        </span>
        {typeof count === "number" && (
          <span className="font-mono text-[10.5px] text-fg-dim">[{count}]</span>
        )}
        <span className="flex-1 h-px bg-bg-line/60 ml-2" />
      </header>
      <div className="bg-bg-panel/50">{children}</div>
    </section>
  );
}

function KV({
  k,
  v,
  tone,
  mono,
}: {
  k: string;
  v: string;
  tone?: "phos" | "amber";
  mono?: boolean;
}) {
  return (
    <div className="px-4 py-3 border-r border-bg-line last:border-r-0">
      <div className="label">{k}</div>
      <div
        className={cn(
          "text-[12.5px] truncate mt-0.5",
          mono && "font-mono",
          tone === "phos" && "text-phos",
          tone === "amber" && "text-amber",
          !tone && "text-fg-bright",
        )}
      >
        {v}
      </div>
    </div>
  );
}

function Dim({ text }: { text: string }) {
  return <div className="px-4 py-3 text-fg-dim label">{text}</div>;
}
