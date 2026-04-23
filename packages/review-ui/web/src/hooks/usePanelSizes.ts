import { useEffect, useRef, useState, useCallback } from "react";

const STORAGE_KEY = "occ.panels.v2";

export type PanelSizes = {
  widths: number[];
  collapsed: boolean[];
};

const DEFAULTS: Record<number, PanelSizes> = {
  4: { widths: [220, 320, 340], collapsed: [false, false, false, false] },
};

function load(n: number): PanelSizes {
  const def = DEFAULTS[n] ?? { widths: [], collapsed: new Array(n).fill(false) };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return def;
    const parsed = JSON.parse(raw) as PanelSizes;
    if (
      Array.isArray(parsed.widths) &&
      parsed.widths.length === n - 1 &&
      Array.isArray(parsed.collapsed) &&
      parsed.collapsed.length === n
    ) {
      return parsed;
    }
  } catch {
    /* noop */
  }
  return def;
}

function save(state: PanelSizes) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* noop */
  }
}

export function usePanelSizes(numColumns: number, min = 160, max = 900) {
  const [state, setState] = useState<PanelSizes>(() => load(numColumns));
  const framing = useRef<number | null>(null);

  const commit = useCallback((next: PanelSizes) => {
    setState(next);
    if (framing.current) cancelAnimationFrame(framing.current);
    framing.current = requestAnimationFrame(() => save(next));
  }, []);

  const onDragStart = useCallback(
    (index: number, container: HTMLElement) => (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = state.widths[index];
      const onMove = (ev: MouseEvent) => {
        const rect = container.getBoundingClientRect();
        const sumActive = state.widths
          .map((w, i) => (state.collapsed[i] ? 0 : w))
          .reduce((s, w, i) => (i === index ? s : s + w), 0);
        let next = startWidth + (ev.clientX - startX);
        const maxForIdx = Math.max(min, rect.width - sumActive - 160);
        next = Math.max(min, Math.min(Math.min(max, maxForIdx), next));
        const copy = state.widths.slice();
        copy[index] = Math.round(next);
        commit({ ...state, widths: copy });
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
    [state, commit, min, max],
  );

  const toggleCollapse = useCallback(
    (index: number) => {
      const next = state.collapsed.slice();
      next[index] = !next[index];
      commit({ ...state, collapsed: next });
    },
    [state, commit],
  );

  const reset = useCallback(() => {
    commit(DEFAULTS[numColumns] ?? { widths: [], collapsed: new Array(numColumns).fill(false) });
  }, [numColumns, commit]);

  useEffect(() => {
    const onResize = () => {
      const total = window.innerWidth;
      const reserved = 200;
      const active = state.widths.filter((_, i) => !state.collapsed[i]);
      const sum = active.reduce((s, w) => s + w, 0);
      if (sum + reserved > total) {
        const scale = (total - reserved) / sum;
        commit({
          ...state,
          widths: state.widths.map((w, i) =>
            state.collapsed[i] ? w : Math.max(min, Math.round(w * scale)),
          ),
        });
      }
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [state, commit, min]);

  return {
    widths: state.widths,
    collapsed: state.collapsed,
    onDragStart,
    toggleCollapse,
    reset,
  };
}
