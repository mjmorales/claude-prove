import { useEffect } from "react";
import type { RightTab } from "../lib/store";
import { useSelection, type StructureTab } from "../lib/store";

const STRUCTURE_ORDER: StructureTab[] = ["branches", "steps", "commits", "docs", "decisions"];

type HotkeyOptions = {
  onOpenPalette: () => void;
};

export function useHotkeys({ onOpenPalette }: HotkeyOptions) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement) {
        const tag = e.target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;
      }
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        onOpenPalette();
        return;
      }
      const s = useSelection.getState();

      // In review mode, ReviewSession owns the keyboard.
      if (s.reviewMode) return;

      // Shift+R → enter review mode (requires a selected run)
      if (!mod && e.key === "R" && s.slug) {
        e.preventDefault();
        s.setReviewMode(true);
        return;
      }
      // Tab switching 1-5 → structure tabs
      if (!mod && /^[1-5]$/.test(e.key)) {
        s.setStructureTab(STRUCTURE_ORDER[Number(e.key) - 1]);
        return;
      }
      // d / i / c → right-pane tabs
      if (!mod && ["d", "i", "c"].includes(e.key.toLowerCase())) {
        const map: Record<string, RightTab> = { d: "diff", i: "intent", c: "context" };
        s.setRightTab(map[e.key.toLowerCase()]);
        return;
      }
      // ? → palette as help
      if (e.key === "?") {
        onOpenPalette();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onOpenPalette]);
}

/** List-local j/k navigation helper. Returns keydown handler to attach to the scroll container. */
export function useListNav<T extends { id: string } | string>(
  items: T[],
  selected: string | null,
  onSelect: (id: string) => void,
): (e: React.KeyboardEvent) => void {
  return (e) => {
    if (e.target instanceof HTMLInputElement) return;
    const getId = (x: T) => (typeof x === "string" ? x : x.id);
    const idx = items.findIndex((x) => getId(x) === selected);
    if (e.key === "j" || e.key === "ArrowDown") {
      e.preventDefault();
      const next = Math.min(items.length - 1, Math.max(0, idx + 1));
      if (items[next]) onSelect(getId(items[next]));
    } else if (e.key === "k" || e.key === "ArrowUp") {
      e.preventDefault();
      const prev = Math.max(0, idx - 1);
      if (items[prev]) onSelect(getId(items[prev]));
    } else if (e.key === "g") {
      e.preventDefault();
      if (items[0]) onSelect(getId(items[0]));
    } else if (e.key === "G") {
      e.preventDefault();
      if (items.length) onSelect(getId(items[items.length - 1]));
    }
  };
}
