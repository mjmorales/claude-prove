import { useEffect, useRef } from "react";
import { useSelection, type Selection, type StructureTab, type RightTab } from "../lib/store";

/**
 * Two-way sync between the zustand selection store and the URL query string.
 *
 * - On mount, read the query string and apply whatever's there to the store.
 * - On every relevant store change, push the new state into the URL via
 *   `history.replaceState` (so back/forward isn't spammed) unless the URL
 *   is already in sync.
 *
 * Refresh-safe, shareable-link-safe. Intentionally does not participate in
 * browser history — selection changes are transient UI, not navigation.
 */

type UrlShape = {
  run: string | null;
  branch: string | null;
  file: string | null;
  commit: string | null;
  pending: boolean;
  st: StructureTab | null;
  rt: RightTab | null;
  review: boolean;
};

const STRUCTURE_TABS: StructureTab[] = [
  "branches",
  "steps",
  "commits",
  "intents",
  "docs",
  "decisions",
];
const RIGHT_TABS: RightTab[] = ["diff", "intent", "context"];

function parse(search: string): UrlShape {
  const p = new URLSearchParams(search);
  return {
    run: p.get("run"),
    branch: p.get("branch"),
    file: p.get("file"),
    commit: p.get("commit"),
    pending: p.get("pending") === "1",
    st: asEnum(p.get("st"), STRUCTURE_TABS),
    rt: asEnum(p.get("rt"), RIGHT_TABS),
    review: p.get("review") === "1",
  };
}

function asEnum<T extends string>(v: string | null, allowed: T[]): T | null {
  return v && (allowed as string[]).includes(v) ? (v as T) : null;
}

function serialize(s: Selection): string {
  const p = new URLSearchParams();
  if (s.slug) p.set("run", s.slug);
  if (s.branch) p.set("branch", s.branch);
  if (s.filePath) p.set("file", s.filePath);
  if (s.commitSha) p.set("commit", s.commitSha);
  if (s.pendingMode) p.set("pending", "1");
  if (s.structureTab !== "branches") p.set("st", s.structureTab);
  if (s.rightTab !== "diff") p.set("rt", s.rightTab);
  if (s.reviewMode) p.set("review", "1");
  const out = p.toString();
  return out ? `?${out}` : "";
}

export function useUrlState() {
  const applied = useRef(false);

  // Apply URL → store on first mount.
  useEffect(() => {
    if (applied.current) return;
    applied.current = true;

    const url = parse(window.location.search);
    const s = useSelection.getState();

    if (url.run) s.selectRun(url.run);
    if (url.branch) s.selectBranch(url.branch, "main");
    if (url.commit) s.selectCommit(url.commit);
    if (url.pending) s.togglePending(true);
    if (url.file) s.selectFile(url.file);
    if (url.st) s.setStructureTab(url.st);
    if (url.rt) s.setRightTab(url.rt);
    if (url.review) s.setReviewMode(true);
  }, []);

  // Sync store → URL on every relevant change.
  useEffect(() => {
    const unsub = useSelection.subscribe((state) => {
      if (!applied.current) return;
      const next = serialize(state);
      const current = window.location.search;
      if (next !== current) {
        const url = window.location.pathname + next + window.location.hash;
        window.history.replaceState(null, "", url);
      }
    });
    return unsub;
  }, []);
}
