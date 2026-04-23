import { useMemo, useRef, type ReactNode } from "react";
import { usePanelSizes } from "../hooks/usePanelSizes";
import { cn } from "../lib/cn";

export type Column = {
  node: ReactNode;
  label: string;
  /** Skip rendering entirely when false. Column still occupies a slot in the
   * persisted size map so widths stay stable across transitions. */
  visible?: boolean;
};

const STRIP_W = 28;

export function ResizableColumns({ columns }: { columns: Column[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const n = columns.length;
  const { widths, collapsed, onDragStart, toggleCollapse, reset } = usePanelSizes(n);

  const visibleIndices = useMemo(
    () => columns.map((c, i) => (c.visible === false ? -1 : i)).filter((i) => i >= 0),
    [columns],
  );
  const lastVisible = visibleIndices[visibleIndices.length - 1];

  return (
    <div ref={ref} className="flex h-full min-h-0 bg-bg-line">
      {columns.map((col, i) => {
        if (col.visible === false) return null;

        const isLastVisible = i === lastVisible;
        const isCollapsed = collapsed[i];
        const nextVisible = visibleIndices[visibleIndices.indexOf(i) + 1];
        const showDividerAfter = nextVisible !== undefined;
        const nextCollapsed = nextVisible !== undefined && collapsed[nextVisible];

        const style = isCollapsed
          ? { width: `${STRIP_W}px`, flex: "0 0 auto", minWidth: 0 }
          : isLastVisible
            ? { flex: "1 1 0%", minWidth: 0 }
            : { width: `${widths[i]}px`, flex: "0 0 auto", minWidth: 0 };

        return (
          <div key={i} className="contents">
            <div
              style={style}
              className={cn(
                "relative bg-bg-panel min-h-0 h-full overflow-hidden group",
                isCollapsed && "hover:bg-bg-raised cursor-pointer select-none",
              )}
              onClick={isCollapsed ? () => toggleCollapse(i) : undefined}
            >
              {isCollapsed ? (
                <CollapsedStrip label={col.label} />
              ) : (
                <>
                  {col.node}
                  <CollapseHandle onClick={() => toggleCollapse(i)} />
                </>
              )}
            </div>
            {showDividerAfter && (
              <button
                type="button"
                aria-label={`resize column ${i + 1}`}
                disabled={isCollapsed || nextCollapsed}
                onMouseDown={(e) => {
                  if (!ref.current) return;
                  if (isCollapsed || nextCollapsed) return;
                  onDragStart(i, ref.current)(e);
                }}
                onDoubleClick={reset}
                className={cn(
                  "group/div relative w-px bg-bg-line transition-colors shrink-0",
                  isCollapsed || nextCollapsed
                    ? "cursor-default"
                    : "hover:bg-phos/60 cursor-col-resize",
                )}
                style={{ touchAction: "none" }}
              >
                <span className="absolute inset-y-0 -left-1 -right-1" />
                {!isCollapsed && !nextCollapsed && (
                  <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex flex-col gap-1 opacity-0 group-hover/div:opacity-100 transition-opacity pointer-events-none">
                    <span className="block w-[3px] h-[3px] bg-phos rounded-full" />
                    <span className="block w-[3px] h-[3px] bg-phos rounded-full" />
                    <span className="block w-[3px] h-[3px] bg-phos rounded-full" />
                  </span>
                )}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function CollapsedStrip({ label }: { label: string }) {
  return (
    <div className="h-full flex flex-col items-center justify-between py-3 text-fg-dim hover:text-phos transition-colors">
      <span className="text-[11px] text-phos">▸</span>
      <span
        className="text-[11px] font-medium whitespace-nowrap"
        style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
      >
        {label}
      </span>
      <span className="text-[10px] text-fg-faint">+</span>
    </div>
  );
}

function CollapseHandle({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Collapse column"
      className="absolute top-1 right-1 z-20 w-5 h-5 flex items-center justify-center text-[11px] text-fg-faint hover:text-phos opacity-0 group-hover:opacity-100 transition-opacity"
    >
      ▸
    </button>
  );
}
