import { create } from "zustand";

/**
 * Scrum UI ephemeral state.
 *
 * Currently tracks only the selected task id — URL-synced via
 * `hooks/useScrumUrlState.ts`. Kept separate from `lib/store.ts` (the ACB
 * selection store) so the two domains don't leak into each other's subscriber
 * sets; both are mounted at the app root but only the active route reads
 * from its own slice.
 */

export type ScrumSelection = {
  /** Selected task id (synced to `?task=<id>` on `/scrum/*` routes). */
  taskId: string | null;
};

type Actions = {
  setTaskId: (id: string | null) => void;
};

export const useScrumSelection = create<ScrumSelection & Actions>((set) => ({
  taskId: null,
  setTaskId: (taskId) => set({ taskId }),
}));
