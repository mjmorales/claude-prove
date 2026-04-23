import type { GroupVerdict } from "../../lib/api";

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
  approved: {
    verdict: "approved",
    label: "Approve",
    glyph: "✓",
    keycap: "a",
    color: "#50fa7b",
    dim: "#2f9547",
    btnClass: "btn-success",
    cardClass: "card-approved",
  },
  rejected: {
    verdict: "rejected",
    label: "Reject",
    glyph: "✕",
    keycap: "r",
    color: "#ff5555",
    dim: "#a03a3a",
    btnClass: "btn-danger",
    cardClass: "card-rejected",
  },
  discuss: {
    verdict: "discuss",
    label: "Discuss",
    glyph: "?",
    keycap: "d",
    color: "#8be9fd",
    dim: "#4f8998",
    btnClass: "btn-info",
    cardClass: "card-discuss",
  },
  rework: {
    verdict: "rework",
    label: "Rework",
    glyph: "↻",
    keycap: "f",
    color: "#ffb86c",
    dim: "#8a5a2b",
    btnClass: "btn-warning",
    cardClass: "card-rework",
  },
};

export function tokenOf(v: GroupVerdict | null | undefined): VerdictToken | null {
  if (!v || v === "pending") return null;
  return VERDICTS[v];
}
