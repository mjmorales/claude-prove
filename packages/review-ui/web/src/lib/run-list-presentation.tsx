/**
 * Shared pure + presentational pieces for run-list surfaces. Both the ACB run
 * list and the project-scoped runs browser render the same status legend, the
 * same relative-time label, the same status-group filter set, and the same
 * filter chip — so those units live here once. Each list keeps its own query
 * wiring (which store, which query key) and imports these.
 */
import type { RunStatus } from "./api";
import { cn } from "./cn";

// Re-exported so the run-list panels keep importing the relative-time formatter
// from this presentation module while its single definition lives in lib/time.
export { relTime } from "./time";

export type StatusMeta = { label: string; dot: string; text: string };

/** Map a run status to its display label and the dot/text color tokens. */
export function statusMeta(s: RunStatus): StatusMeta {
  switch (s) {
    case "running":
      return { label: "Running", dot: "bg-phos", text: "text-phos" };
    case "pending":
      return { label: "Pending", dot: "bg-amber", text: "text-amber" };
    case "completed":
      return { label: "Done", dot: "bg-ok", text: "text-ok" };
    case "failed":
      return { label: "Failed", dot: "bg-anom", text: "text-anom" };
    case "halted":
      return { label: "Halted", dot: "bg-anom", text: "text-anom" };
    default:
      return { label: "Idle", dot: "bg-fg-faint", text: "text-fg-dim" };
  }
}

/** The status-group filter buttons every run list offers. */
export const FILTER_GROUPS: Array<{ id: string; label: string; statuses: RunStatus[] }> = [
  { id: "active", label: "Active", statuses: ["running", "pending"] },
  { id: "done", label: "Done", statuses: ["completed"] },
  { id: "issues", label: "Issues", statuses: ["failed", "halted"] },
];

/** A single status-group toggle chip in a run-list filter bar. */
export function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "h-6 px-2 rounded-md border text-[11.5px] transition-colors",
        active
          ? "border-phos bg-phos/15 text-phos"
          : "border-bg-line bg-transparent text-fg-dim hover:text-fg-base hover:border-fg-faint",
      )}
    >
      {label}
    </button>
  );
}
