import { create } from "zustand";
import type { DocView } from "../../lib/run-doc-render";

/**
 * Selection store for the project-scoped Runs surface. Independent from the ACB
 * `lib/store` selection so a run picked here never leaks into the ACB review
 * machine (and vice versa). Holds the active composite run key, the active
 * detail tab, and the doc sub-view the docs tab shows.
 */
export type RunDetailTab = "docs" | "brief" | "decisions";

// Re-exported so callers can keep importing the doc-view union from the store
// while its single declaration lives in run-doc-render.
export type { DocView };

type RunsSelection = {
  /** Composite run key `<branch>/<slug>`, or null when nothing is selected. */
  slug: string | null;
  /** Which detail tab the right pane shows for the selected run. */
  tab: RunDetailTab;
  /** The doc sub-view active within the docs tab. */
  docView: DocView;
};

type RunsActions = {
  selectRun: (slug: string) => void;
  clearRun: () => void;
  setTab: (tab: RunDetailTab) => void;
  setDocView: (v: DocView) => void;
};

export const useRunsSelection = create<RunsSelection & RunsActions>((set) => ({
  slug: null,
  tab: "docs",
  docView: "PLAN",
  // Switching runs resets the tab + doc sub-view so a run with no decisions
  // doesn't strand the user on an empty tab carried over from the prior run.
  selectRun: (slug) => set({ slug, tab: "docs", docView: "PLAN" }),
  clearRun: () => set({ slug: null, tab: "docs", docView: "PLAN" }),
  setTab: (tab) => set({ tab }),
  setDocView: (docView) => set({ docView }),
}));
