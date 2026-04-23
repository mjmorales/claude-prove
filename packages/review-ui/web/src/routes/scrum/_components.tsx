import { useNavigate } from "react-router-dom";
import type { ScrumTask, TaskStatus } from "@claude-prove/cli/scrum/types";
import { useScrumSelection } from "../../lib/scrumStore";
import { cn } from "../../lib/cn";

/**
 * Presentational bits shared across scrum views. Kept private to the scrum
 * route module (underscore prefix) — not part of the broader component lib.
 */

const STATUS_META: Record<TaskStatus, { label: string; color: string }> = {
  backlog: { label: "Backlog", color: "#6272a4" },
  ready: { label: "Ready", color: "#8be9fd" },
  in_progress: { label: "In Progress", color: "#bd93f9" },
  review: { label: "Review", color: "#ffb86c" },
  blocked: { label: "Blocked", color: "#ff5555" },
  done: { label: "Done", color: "#50fa7b" },
  cancelled: { label: "Cancelled", color: "#44475a" },
};

export const TASK_STATUSES: TaskStatus[] = [
  "backlog",
  "ready",
  "in_progress",
  "review",
  "blocked",
  "done",
  "cancelled",
];

export function statusMeta(status: TaskStatus) {
  return STATUS_META[status];
}

export function StatusPill({ status }: { status: TaskStatus }) {
  const meta = STATUS_META[status];
  return (
    <span
      className="inline-flex items-center px-1.5 h-5 rounded text-[10.5px] mono uppercase tracking-wider"
      style={{
        color: meta.color,
        background: `${meta.color}14`,
        border: `1px solid ${meta.color}55`,
      }}
    >
      {meta.label}
    </span>
  );
}

/**
 * Read-only, keyboard-navigable task card. Clicking or pressing Enter/Space
 * navigates to `/scrum/task/:id` and mirrors the id into the scrum selection
 * store so the URL reflects the selection.
 */
export function TaskCard({ task, compact = false }: { task: ScrumTask; compact?: boolean }) {
  const navigate = useNavigate();
  const setTaskId = useScrumSelection((s) => s.setTaskId);

  const open = () => {
    setTaskId(task.id);
    navigate(`/scrum/task/${encodeURIComponent(task.id)}`);
  };

  return (
    <article
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
      className={cn(
        "group block w-full text-left rounded-md border border-bg-line bg-bg-panel",
        "hover:bg-bg-raised hover:border-phos/40 focus:outline-none focus:ring-2 focus:ring-phos/60",
        "transition-colors cursor-pointer",
        compact ? "p-2.5" : "p-3",
      )}
    >
      <header className="flex items-start gap-2 min-w-0">
        <StatusPill status={task.status} />
        <span className="mono text-[11px] text-fg-faint shrink-0">{task.id.slice(0, 8)}</span>
      </header>
      <h3
        className={cn(
          "mt-1.5 text-fg-bright font-medium leading-snug",
          compact ? "text-[13px] line-clamp-2" : "text-[14px]",
        )}
      >
        {task.title}
      </h3>
      {!compact && task.description && (
        <p className="mt-1 text-[12.5px] text-fg-dim line-clamp-3">{task.description}</p>
      )}
      <footer className="mt-2 flex items-center gap-3 text-[11px] text-fg-faint mono">
        {task.milestone_id && (
          <span title="Milestone">◆ {task.milestone_id.slice(0, 10)}</span>
        )}
        {task.last_event_at && <span title="Last event">⏱ {relTime(task.last_event_at)}</span>}
      </footer>
    </article>
  );
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="p-6 text-center text-fg-faint text-[13px] border border-dashed border-bg-line rounded-md bg-bg-deep/40">
      {children}
    </div>
  );
}

export function Loading({ label }: { label?: string }) {
  return (
    <div className="p-6 text-center text-fg-faint text-[13px] mono">
      {label ?? "Loading…"}
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div className="p-4 rounded-md border border-anom/40 bg-anom/10 text-anom text-[13px] mono">
      Error: {msg}
    </div>
  );
}

/**
 * Relative time formatter for event timestamps. Keeps the dashboard compact
 * — exact timestamps live in the task detail timeline.
 */
export function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diff = Date.now() - t;
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}
