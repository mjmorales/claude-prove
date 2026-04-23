import { useSelection, type RightTab } from "../lib/store";
import { cn } from "../lib/cn";
import { DiffView } from "./DiffView";
import { IntentPanel } from "./IntentPanel";
import { ContextPanel } from "./ContextPanel";

const TABS: Array<{ id: RightTab; label: string; key: string }> = [
  { id: "diff", label: "Diff", key: "d" },
  { id: "intent", label: "Intent", key: "i" },
  { id: "context", label: "Context", key: "c" },
];

export function RightPane() {
  const tab = useSelection((s) => s.rightTab);
  const setTab = useSelection((s) => s.setRightTab);
  const sha = useSelection((s) => s.commitSha);

  return (
    <div className="flex flex-col h-full min-h-0 bg-bg-void">
      <div className="shrink-0 flex items-stretch bg-bg-deep border-b border-bg-line">
        {TABS.map((t) => {
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              title={`${t.label} (${t.key})`}
              className={cn(
                "h-10 px-5 flex items-center gap-2 transition-colors relative text-[12.5px]",
                active ? "text-fg-bright" : "text-fg-dim hover:text-fg-base hover:bg-bg-panel/60",
              )}
            >
              {active && (
                <span className="absolute bottom-0 left-2 right-2 h-[2px] bg-phos rounded-full" />
              )}
              <span className="font-medium">{t.label}</span>
              {t.id === "intent" && sha && (
                <span className="font-mono text-[11px] text-fg-faint">{sha.slice(0, 7)}</span>
              )}
            </button>
          );
        })}
        <div className="flex-1" />
      </div>
      <div className="flex-1 min-h-0">
        {tab === "diff" && <DiffView />}
        {tab === "intent" && <IntentPanel />}
        {tab === "context" && <ContextPanel />}
      </div>
    </div>
  );
}
