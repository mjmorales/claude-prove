import { useEffect, useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useSelection } from "../lib/store";
import { DOCS, renderDoc } from "../lib/run-doc-render";
import { cn } from "../lib/cn";
import { Markdown } from "./Markdown";
import { PanelLoading } from "./PanelLoading";

export function DocsPanel() {
  const slug = useSelection((s) => s.slug);
  const view = useSelection((s) => s.docView);
  const setView = useSelection((s) => s.setDocView);

  const probes = useQueries({
    queries: DOCS.map((d) => ({
      queryKey: ["doc", slug, d.file],
      queryFn: () => api.doc(slug!, d.file),
      enabled: !!slug,
      retry: false,
      staleTime: 10_000,
    })),
  });
  // Stable projection of probe statuses so downstream memoization / effects
  // depend on a single primitive that only flips when an actual status
  // transition happens — avoids re-running the auto-switch effect on every
  // render caused by fresh array identity out of `useQueries`.
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

  const doc = DOCS.find((d) => d.id === view)!;
  const currentProbe = probes[DOCS.findIndex((d) => d.id === view)];
  const raw = (currentProbe?.data as { content?: string } | undefined)?.content ?? "";
  const rendered = raw ? renderDoc(raw, doc.id) : "";

  if (!slug) return <Empty text="Select a run" />;

  const anyAvailable = availability.some((a) => a.available);

  return (
    <div className="flex flex-col h-full min-h-0">
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

function Empty({ text }: { text: string }) {
  return <div className="flex h-full items-center justify-center text-fg-dim text-[13px]">{text}</div>;
}
