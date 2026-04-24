import type { GroupVerdict } from "../../lib/api";

/**
 * Central Dracula-derived palette. All hex literals referenced by
 * review-UI components live here so the theme is changed in one place.
 *
 * Buckets:
 *  - `verdict.*` / `verdictDim.*`: verdict status colors (strong + muted).
 *  - `accent.*`: Dracula accents reused outside verdicts (purple, yellow,
 *    comment-gray, neutral-gray).
 *  - `surface.*`: panel-level grays used for borders & faint backgrounds.
 *  - `status.*`: aliases for file-change glyphs (add/mod/del/rename) that
 *    intentionally reuse verdict hues — kept as separate names so callers
 *    read domain-intent, not "accepted green".
 *  - `classification.*` / `ambiguity.*`: GroupCard badge hues.
 */
export const PALETTE = {
  verdict: {
    accepted: "#50fa7b",
    rejected: "#ff5555",
    needsDiscussion: "#8be9fd",
    rework: "#ffb86c",
  },
  verdictDim: {
    accepted: "#2f9547",
    rejected: "#a03a3a",
    needsDiscussion: "#4f8998",
    rework: "#8a5a2b",
  },
  accent: {
    /** Dracula purple — used for phos UI (active selection, progress). */
    phos: "#bd93f9",
    /** Dracula yellow — judgment-call callouts. */
    judgment: "#f1fa8c",
    /** Dracula comment — dimmed/empty chip text and "pending" tone. */
    dim: "#6272a4",
    /** Neutral fg-dim gray — generic text on dark surfaces. */
    neutral: "#a9b0c4",
    /** Generic bright fg — fallback classification label. */
    bright: "#e2e2e6",
  },
  surface: {
    /** Subtle border on raised UI (chips, ambiguity pills). */
    border: "#44475a",
  },
  status: {
    /** Alias for additions (reuses verdict-accepted green). */
    added: "#50fa7b",
    /** Alias for modifications (reuses needs-discussion cyan). */
    modified: "#8be9fd",
    /** Alias for deletions (reuses verdict-rejected red). */
    deleted: "#ff5555",
    /** Alias for renames (reuses verdict-rework amber). */
    renamed: "#ffb86c",
  },
  classification: {
    explicit: "#bd93f9",
    inferred: "#8be9fd",
    speculative: "#ffb86c",
    implicit: "#ff5555",
  },
  ambiguity: {
    /** Hot ambiguity tags (scope_creep, conflicting_signals). */
    hot: "#ffb86c",
    /** Cold/default ambiguity tag. */
    cold: "#a9b0c4",
  },
} as const;

export type VerdictToken = {
  verdict: GroupVerdict;
  label: string;
  glyph: string;
  keycap: string;
  color: string;
  dim: string;
  btnClass: string;
  cardClass: string;
};

export const VERDICTS: Record<Exclude<GroupVerdict, "pending">, VerdictToken> = {
  accepted: {
    verdict: "accepted",
    label: "Approve",
    glyph: "✓",
    keycap: "a",
    color: PALETTE.verdict.accepted,
    dim: PALETTE.verdictDim.accepted,
    btnClass: "btn-success",
    cardClass: "card-accepted",
  },
  rejected: {
    verdict: "rejected",
    label: "Reject",
    glyph: "✕",
    keycap: "r",
    color: PALETTE.verdict.rejected,
    dim: PALETTE.verdictDim.rejected,
    btnClass: "btn-danger",
    cardClass: "card-rejected",
  },
  needs_discussion: {
    verdict: "needs_discussion",
    label: "Discuss",
    glyph: "?",
    keycap: "d",
    color: PALETTE.verdict.needsDiscussion,
    dim: PALETTE.verdictDim.needsDiscussion,
    btnClass: "btn-info",
    cardClass: "card-needs-discussion",
  },
  rework: {
    verdict: "rework",
    label: "Rework",
    glyph: "↻",
    keycap: "f",
    color: PALETTE.verdict.rework,
    dim: PALETTE.verdictDim.rework,
    btnClass: "btn-warning",
    cardClass: "card-rework",
  },
};

export function tokenOf(v: GroupVerdict | null | undefined): VerdictToken | null {
  if (!v || v === "pending") return null;
  return VERDICTS[v];
}
