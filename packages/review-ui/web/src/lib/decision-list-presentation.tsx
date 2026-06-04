/**
 * Shared presentational pieces for decision-ledger surfaces. The ACB decisions
 * panel and the project-scoped run decisions panel render the same group header
 * and the same clickable decision row, so those units live here once. Each panel
 * keeps its own query wiring (which store, which query key) and imports these.
 */
import type { DecisionRef } from "./api";
import { cn } from "./cn";

/** A clickable decision row showing title, id, and optional date. */
export function DecisionRow({
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

/** A section divider labeling a group of decision rows. */
export function DecisionGroupLabel({ text, tone }: { text: string; tone?: "amber" }) {
  return (
    <div className="px-3 py-1.5 bg-bg-deep/60 border-b border-bg-line flex items-center gap-2">
      <span className={cn("label", tone === "amber" ? "text-amber" : "label-bright")}>{text}</span>
      <span className="flex-1 h-px bg-bg-line" />
    </div>
  );
}
