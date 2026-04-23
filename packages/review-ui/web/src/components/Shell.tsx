import { useRef, type ReactNode } from "react";
import { useSidebarSize } from "../hooks/useSidebarSize";

/**
 * Two-pane layout shell: sidebar (resizable, collapsible) + inspector.
 * The divider is draggable; double-click resets. A floating "show sidebar"
 * button appears when the user enters focus mode.
 */
export function Shell({
  sidebar,
  inspector,
}: {
  sidebar: ReactNode;
  inspector: ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { width, rawWidth, collapsed, onDragStart, toggleCollapsed, reset } = useSidebarSize();

  return (
    <div ref={containerRef} className="flex h-full min-h-0 bg-bg-line relative">
      {!collapsed && (
        <>
          <aside
            style={{ width: `${width}px`, flex: "0 0 auto", minWidth: 0 }}
            className="relative h-full min-h-0 bg-bg-panel border-r border-bg-line overflow-hidden"
          >
            {sidebar}
            <button
              onClick={toggleCollapsed}
              title="Hide sidebar (⌘.)"
              className="absolute top-1 right-1 w-6 h-6 flex items-center justify-center rounded text-fg-faint hover:text-fg-bright hover:bg-bg-raised opacity-0 group-hover:opacity-100 transition-opacity"
            >
              ◂
            </button>
          </aside>
          <button
            type="button"
            aria-label="Resize sidebar"
            onMouseDown={(e) => {
              if (!containerRef.current) return;
              onDragStart(containerRef.current)(e);
            }}
            onDoubleClick={reset}
            className="group/div relative w-px shrink-0 bg-bg-line hover:bg-phos/60 cursor-col-resize transition-colors"
            style={{ touchAction: "none" }}
          >
            <span className="absolute inset-y-0 -left-1 -right-1" />
          </button>
        </>
      )}
      <main className="flex-1 min-w-0 min-h-0 bg-bg-void">{inspector}</main>
      {collapsed && (
        <button
          onClick={toggleCollapsed}
          title={`Show sidebar (${rawWidth}px)`}
          className="absolute top-2 left-2 z-20 w-8 h-8 flex items-center justify-center rounded-md border border-bg-line bg-bg-panel hover:bg-bg-raised text-fg-base shadow-soft"
        >
          ▸
        </button>
      )}
    </div>
  );
}
