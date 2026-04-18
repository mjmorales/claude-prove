import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useSelection } from "../lib/store";
import { PanelLoading } from "./PanelLoading";

export function IntentPanel() {
  const sha = useSelection((s) => s.commitSha);
  const { data, isPending, isFetching } = useQuery({
    queryKey: ["intent", sha],
    queryFn: () => api.intent(sha!),
    enabled: !!sha,
  });

  if (!sha) {
    return (
      <Hollow>
        <div className="text-[14px] text-fg-bright mb-1">Intent manifest</div>
        <div className="text-[13px]">Select a commit to decode its manifest.</div>
      </Hollow>
    );
  }
  if (isPending || (isFetching && !data)) return <PanelLoading label="Decoding manifest" />;

  if (!data?.manifest) {
    return (
      <Hollow>
        <div className="text-[14px] text-amber mb-1">No manifest</div>
        <div className="font-mono text-[11.5px] text-fg-dim mb-3">{sha.slice(0, 12)}</div>
        <div className="max-w-md text-[13px] leading-relaxed">
          No intent manifest recorded. Generate with{" "}
          <code className="font-mono text-phos bg-bg-panel px-1.5 py-0.5 rounded border border-bg-line">
            python3 -m tools.acb save-manifest
          </code>{" "}
          before each feature-branch commit.
        </div>
      </Hollow>
    );
  }

  const m = data.manifest;
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="shrink-0 h-9 px-4 flex items-center gap-3 bg-bg-deep border-b border-bg-line">
        <span className="mono text-[11px] uppercase tracking-wider text-data">Intent</span>
        <span className="font-mono text-[12.5px] text-fg-bright">{m.commitSha.slice(0, 12)}</span>
        <span className="text-fg-dim text-[11.5px]">{m.branch}</span>
        <span className="ml-auto font-mono text-[11px] text-fg-faint tabular-nums">
          {new Date(m.timestamp).toISOString().replace("T", " ").slice(0, 19)}Z
        </span>
      </div>
      <div className="flex-1 overflow-auto scrollbar-thin p-5 bg-bg-void">
        <pre className="font-mono text-[12px] leading-relaxed text-fg-base whitespace-pre-wrap">
          {typeof m.data === "string" ? m.data : JSON.stringify(m.data, null, 2)}
        </pre>
      </div>
    </div>
  );
}

function Hollow({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full flex flex-col items-center justify-center text-center text-fg-dim p-8">
      {children}
    </div>
  );
}
