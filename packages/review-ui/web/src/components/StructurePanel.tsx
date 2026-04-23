import { useSelection, type StructureTab } from "../lib/store";
import { cn } from "../lib/cn";
import { BranchTree } from "./BranchTree";
import { StepsPanel } from "./StepsPanel";
import { CommitsPanel } from "./CommitsPanel";
import { IntentsPanel } from "./IntentsPanel";
import { DocsPanel } from "./DocsPanel";
import { DecisionsPanel } from "./DecisionsPanel";

const TABS: Array<{ id: StructureTab; key: string; label: string }> = [
  { id: "branches", key: "1", label: "Branches" },
  { id: "steps", key: "2", label: "Steps" },
  { id: "commits", key: "3", label: "Commits" },
  { id: "intents", key: "4", label: "Intents" },
  { id: "docs", key: "5", label: "Docs" },
  { id: "decisions", key: "6", label: "ADRs" },
];

export function StructurePanel() {
  const tab = useSelection((s) => s.structureTab);
  const setTab = useSelection((s) => s.setStructureTab);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="shrink-0 flex items-stretch bg-bg-deep border-b border-bg-line">
        {TABS.map((t) => {
          const active = t.id === tab;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              title={`${t.label} (${t.key})`}
              className={cn(
                "flex-1 h-10 flex items-center justify-center transition-colors relative text-[12.5px]",
                active
                  ? "text-fg-bright"
                  : "text-fg-dim hover:text-fg-base hover:bg-bg-panel/60",
              )}
            >
              {active && (
                <span className="absolute bottom-0 left-2 right-2 h-[2px] bg-phos rounded-full" />
              )}
              <span className="font-medium">{t.label}</span>
            </button>
          );
        })}
      </div>
      <div className="flex-1 min-h-0">
        {tab === "branches" && <BranchTree />}
        {tab === "steps" && <StepsPanel />}
        {tab === "commits" && <CommitsPanel />}
        {tab === "intents" && <IntentsPanel />}
        {tab === "docs" && <DocsPanel />}
        {tab === "decisions" && <DecisionsPanel />}
      </div>
    </div>
  );
}
