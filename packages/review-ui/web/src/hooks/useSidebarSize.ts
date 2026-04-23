import { useCallback, useEffect, useRef, useState } from "react";

const STORAGE_KEY = "prove-review.sidebar.v1";
const DEFAULT_WIDTH = 300;
const MIN = 220;
const MAX = 600;

export type SidebarSize = {
  width: number;
  collapsed: boolean;
};

function load(): SidebarSize {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { width: DEFAULT_WIDTH, collapsed: false };
    const parsed = JSON.parse(raw) as SidebarSize;
    return {
      width: clamp(parsed.width ?? DEFAULT_WIDTH, MIN, MAX),
      collapsed: !!parsed.collapsed,
    };
  } catch {
    return { width: DEFAULT_WIDTH, collapsed: false };
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Persisted sidebar width + collapsed flag. Shared between the layout shell
 * and the focus-mode toggle.
 */
export function useSidebarSize() {
  const [state, setState] = useState<SidebarSize>(load);
  const raf = useRef<number | null>(null);

  const commit = useCallback((next: SidebarSize) => {
    setState(next);
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* noop */
      }
    });
  }, []);

  const onDragStart = useCallback(
    (container: HTMLElement) => (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = state.width;
      const rect = container.getBoundingClientRect();
      const hardMax = Math.min(MAX, Math.floor(rect.width * 0.7));
      const onMove = (ev: MouseEvent) => {
        const next = clamp(startW + (ev.clientX - startX), MIN, hardMax);
        commit({ ...state, width: Math.round(next) });
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [state, commit],
  );

  const toggleCollapsed = useCallback(() => {
    commit({ ...state, collapsed: !state.collapsed });
  }, [state, commit]);

  const setCollapsed = useCallback(
    (collapsed: boolean) => commit({ ...state, collapsed }),
    [state, commit],
  );

  const reset = useCallback(
    () => commit({ width: DEFAULT_WIDTH, collapsed: false }),
    [commit],
  );

  useEffect(() => {
    const onResize = () => {
      const avail = window.innerWidth;
      // Keep at least 400px of content pane visible on narrow viewports.
      const hardMax = Math.min(MAX, Math.max(MIN, avail - 400));
      if (state.width > hardMax) commit({ ...state, width: hardMax });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [state, commit]);

  return {
    width: state.collapsed ? 0 : state.width,
    rawWidth: state.width,
    collapsed: state.collapsed,
    onDragStart,
    toggleCollapsed,
    setCollapsed,
    reset,
  };
}
