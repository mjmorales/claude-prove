import { create } from "zustand";
import type { DocView } from "./run-doc-render";

// Re-exported so callers can keep importing the doc-view union from the store
// while its single declaration lives in run-doc-render.
export type { DocView };

export type StructureTab = "branches" | "steps" | "commits" | "intents" | "docs" | "decisions";
export type RightTab = "diff" | "intent" | "context";

export type Selection = {
  /** Composite run key: `<branch>/<slug>`. */
  slug: string | null;
  branch: string | null;
  base: string | null;
  head: string | null;
  filePath: string | null;
  pendingMode: boolean;
  commitSha: string | null;
  structureTab: StructureTab;
  rightTab: RightTab;
  docView: DocView;
  reviewMode: boolean;
  /** The intent group currently under review. Drives auto-advance and the
   * scroll position of the active card. */
  activeIntentId: string | null;
  /** When true (default), a verdict auto-advances to the next queued intent.
   * Space toggles it in review mode. */
  reviewAutoAdvance: boolean;
};

export type ManifestGroupRef = {
  branch: string;
  base: string | null;
  head: string | null;
  pending: boolean;
};

type Actions = {
  selectRun: (compositeSlug: string) => void;
  selectBranch: (branch: string, base: string) => void;
  selectFile: (path: string | null) => void;
  selectFileFromGroup: (filePath: string, group: ManifestGroupRef) => void;
  togglePending: (on: boolean, orchestratorBranch?: string | null) => void;
  selectCommit: (sha: string | null) => void;
  setStructureTab: (t: StructureTab) => void;
  setRightTab: (t: RightTab) => void;
  setDocView: (v: DocView) => void;
  setReviewMode: (on: boolean) => void;
  setActiveIntentId: (id: string | null) => void;
  setReviewAutoAdvance: (on: boolean) => void;
};

export const useSelection = create<Selection & Actions>((set) => ({
  slug: null,
  branch: null,
  base: null,
  head: null,
  filePath: null,
  pendingMode: false,
  commitSha: null,
  structureTab: "branches",
  rightTab: "diff",
  docView: "PLAN",
  reviewMode: false,
  activeIntentId: null,
  reviewAutoAdvance: true,
  selectRun: (slug) =>
    set({
      slug,
      branch: null,
      base: null,
      head: null,
      filePath: null,
      pendingMode: false,
      commitSha: null,
      structureTab: "branches",
      // Review-session state is per-run: drop out of review mode and clear the
      // prior run's active intent so it can't leak into the freshly-selected run.
      reviewMode: false,
      activeIntentId: null,
    }),
  selectBranch: (branch, base) =>
    set({
      branch,
      base,
      head: branch,
      filePath: null,
      pendingMode: false,
      commitSha: null,
      // activeIntentId is per-run; a branch switch is within-run so reviewMode
      // stays, but the active intent must not carry across branches.
      activeIntentId: null,
    }),
  selectFile: (filePath) => set({ filePath }),
  selectFileFromGroup: (filePath, group) =>
    set({
      filePath,
      branch: group.branch,
      base: group.base,
      head: group.head,
      pendingMode: group.pending,
      commitSha: null,
    }),
  togglePending: (pendingMode, orchestratorBranch) =>
    set((s) => {
      if (!pendingMode) {
        return { pendingMode: false, filePath: null, commitSha: null };
      }
      const branch = orchestratorBranch ?? s.branch;
      return {
        pendingMode: true,
        branch,
        head: branch,
        base: null,
        filePath: null,
        commitSha: null,
      };
    }),
  selectCommit: (commitSha) =>
    set((s) => ({
      commitSha,
      pendingMode: false,
      base: commitSha ? `${commitSha}^` : s.base,
      head: commitSha ?? s.head,
      filePath: null,
    })),
  setStructureTab: (structureTab) => set({ structureTab }),
  setRightTab: (rightTab) => set({ rightTab }),
  setDocView: (docView) => set({ docView }),
  setReviewMode: (reviewMode) => set({ reviewMode }),
  setActiveIntentId: (activeIntentId) => set({ activeIntentId }),
  setReviewAutoAdvance: (reviewAutoAdvance) => set({ reviewAutoAdvance }),
}));
