import { useEffect, useRef } from "react";
import { useScrumSelection } from "../lib/scrumStore";

/**
 * Two-way sync between `useScrumSelection.taskId` and `?task=<id>` in the
 * URL. Mirrors `useUrlState` for ACB — mounted once at the scrum layout so
 * the subscriber lifetime matches the route lifetime.
 *
 * Uses `history.replaceState` so selection changes don't spam browser
 * history. Path is preserved; only the query string is rewritten.
 */
export function useScrumUrlState() {
  const applied = useRef(false);

  useEffect(() => {
    if (applied.current) return;
    applied.current = true;

    const p = new URLSearchParams(window.location.search);
    const urlTask = p.get("task");
    if (urlTask) {
      useScrumSelection.getState().setTaskId(urlTask);
    }
  }, []);

  useEffect(() => {
    const unsub = useScrumSelection.subscribe((state) => {
      if (!applied.current) return;
      const p = new URLSearchParams(window.location.search);
      const current = p.get("task");
      if (state.taskId && state.taskId !== current) {
        p.set("task", state.taskId);
      } else if (!state.taskId && current) {
        p.delete("task");
      } else {
        return;
      }
      const qs = p.toString();
      const url = window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash;
      window.history.replaceState(null, "", url);
    });
    return unsub;
  }, []);
}
