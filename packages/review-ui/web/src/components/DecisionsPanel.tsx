import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type DecisionRef } from "../lib/api";
import { useSelection } from "../lib/store";
import { cn } from "../lib/cn";
import { Markdown } from "./Markdown";
import { PanelLoading } from "./PanelLoading";

export function DecisionsPanel() {
  const slug = useSelection((s) => s.slug);
  const [selected, setSelected] = useState<string | null>(null);

  const { data, isPending, isFetching } = useQuery({
    queryKey: ["decisions", slug],
    queryFn: () => api.decisions(slug!),
    enabled: !!slug,
  });
  const { data: detail, isFetching: detailFetching } = useQuery({
    queryKey: ["decision", selected],
    queryFn: () => api.decision(selected!),
    enabled: !!selected,
  });

  if (!slug) return <Empty text="Select a run" />;
  if (isPending || (isFetching && !data)) return <PanelLoading label="LOADING DECISIONS" />;

  if (selected) {
    return (
      <div className="flex flex-col h-full min-h-0">
        <button
          onClick={() => setSelected(null)}
          className="shrink-0 h-8 px-3 flex items-center gap-3 bg-bg-deep border-b border-bg-line hover:bg-bg-panel text-[11px] font-mono text-fg-base"
        >
          <span className="text-phos">◂</span>
          <span className="label">BACK</span>
          <span className="text-fg-dim truncate">{selected}</span>
        </button>
        <div className="flex-1 overflow-y-auto scrollbar-thin p-5">
          {detail ? (
            <Markdown source={detail.content} />
          ) : detailFetching ? (
            <PanelLoading label="LOADING DECISION" />
          ) : null}
        </div>
      </div>
    );
  }

  const referenced = data?.referenced ?? [];
  const all = data?.all ?? [];
  const rest = all.filter((d) => !referenced.find((r) => r.id === d.id));

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="shrink-0 px-3 h-8 flex items-center gap-3 bg-bg-deep border-b border-bg-line">
        <span className="label label-bright">DECISION LEDGER</span>
        <span className="ml-auto font-mono text-[10.5px] text-fg-dim">
          {referenced.length} REF · {all.length} TOTAL
        </span>
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {referenced.length > 0 && (
          <>
            <GroupLabel text="REFERENCED BY RUN" tone="amber" />
            {referenced.map((d) => (
              <Row key={d.id} d={d} onOpen={() => setSelected(d.id)} tone="amber" />
            ))}
          </>
        )}
        {rest.length > 0 && (
          <>
            <GroupLabel text="ARCHIVE" />
            {rest.map((d) => (
              <Row key={d.id} d={d} onOpen={() => setSelected(d.id)} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function Row({
  d,
  onOpen,
  tone,
}: {
  d: DecisionRef;
  onOpen: () => void;
  tone?: "amber";
}) {
  return (
    <button
      onClick={onOpen}
      className={cn(
        "w-full text-left px-3 py-2 flex items-start gap-3 border-l-2 border-b border-bg-line/60 hover:bg-bg-panel transition-colors font-mono text-[12px]",
        tone === "amber" ? "border-l-amber/50" : "border-l-transparent",
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="text-fg-base truncate">{d.title}</div>
        <div className="text-[10px] text-fg-dim truncate">{d.id}</div>
      </div>
      {d.date && <span className="text-[10px] text-fg-dim tabular-nums shrink-0">{d.date}</span>}
    </button>
  );
}

function GroupLabel({ text, tone }: { text: string; tone?: "amber" }) {
  return (
    <div className="px-3 py-1.5 bg-bg-deep/60 border-b border-bg-line flex items-center gap-2">
      <span className={cn("label", tone === "amber" ? "text-amber" : "label-bright")}>{text}</span>
      <span className="flex-1 h-px bg-bg-line" />
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="flex h-full items-center justify-center text-fg-dim text-[13px]">{text}</div>;
}
