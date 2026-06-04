import { useNavigate } from "react-router-dom";
import type {
  AcceptanceCriterion,
  ScrumTask,
  TaskLayer,
  TaskStatus,
} from "@claude-prove/cli/scrum/types";
import { useScrumSelection } from "../../lib/scrumStore";
import { cn } from "../../lib/cn";

/**
 * Presentational bits shared across scrum views. Kept private to the scrum
 * route module (underscore prefix) — not part of the broader component lib.
 */

const STATUS_META: Record<TaskStatus, { label: string; color: string }> = {
  backlog: { label: "Backlog", color: "#6272a4" },
  proposed: { label: "Proposed", color: "#f1fa8c" },
  accepted: { label: "Accepted", color: "#8be9fd" },
  ready: { label: "Ready", color: "#8be9fd" },
  in_progress: { label: "In Progress", color: "#bd93f9" },
  review: { label: "Review", color: "#ffb86c" },
  blocked: { label: "Blocked", color: "#ff5555" },
  done: { label: "Done", color: "#50fa7b" },
  cancelled: { label: "Cancelled", color: "#44475a" },
};

// Canonical lifecycle order: backlog → proposed → accepted → ready →
// in_progress → review → done, with blocked/cancelled as off-path terminals.
export const TASK_STATUSES: TaskStatus[] = [
  "backlog",
  "proposed",
  "accepted",
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

const LAYER_META: Record<TaskLayer, { label: string; color: string }> = {
  epic: { label: "Epic", color: "#bd93f9" },
  story: { label: "Story", color: "#8be9fd" },
  task: { label: "Task", color: "#6272a4" },
};

/**
 * Containment-tier badge for a task. A null layer (flat/untiered task) renders
 * nothing — the absence of a badge is itself the signal that the task sits
 * outside the epic→story→task ladder.
 */
export function LayerBadge({ layer }: { layer: TaskLayer | null }) {
  if (layer === null) return null;
  const meta = LAYER_META[layer];
  if (!meta) return null;
  return (
    <span
      className="inline-flex items-center px-1.5 h-5 rounded text-[10px] mono uppercase tracking-wider"
      style={{ color: meta.color, background: `${meta.color}14`, border: `1px solid ${meta.color}55` }}
    >
      {meta.label}
    </span>
  );
}

const VERIFIES_BY_GLYPH: Record<AcceptanceCriterion["verifies_by"], string> = {
  bash: "$",
  assert: "≡",
  gate: "⌘",
  agent: "✦",
};

/**
 * Render a task's authored acceptance criteria. Only `active` criteria are
 * shown — a superseded criterion is retained in the store for audit but is not
 * a live goalpost, so it stays out of the operator view. Each row surfaces the
 * criterion text, its `verifies_by` kind glyph, and the recorded verification /
 * gate verdict (the standing state the story-close floor reads), never a live
 * evaluation.
 */
export function AcceptanceCriteria({ criteria }: { criteria: AcceptanceCriterion[] }) {
  const active = criteria.filter((c) => c.status === "active");
  if (active.length === 0) {
    return <p className="text-fg-faint text-[11.5px] mono">No acceptance criteria.</p>;
  }
  return (
    <ul className="space-y-1.5">
      {active.map((c) => (
        <li key={c.id} className="flex items-start gap-2 text-[12px]">
          <span
            className="mono text-fg-faint shrink-0 w-4 text-center"
            title={`verifies by ${c.verifies_by}`}
            aria-label={`verifies by ${c.verifies_by}`}
          >
            {VERIFIES_BY_GLYPH[c.verifies_by] ?? "•"}
          </span>
          <span className="flex-1 min-w-0 text-fg-base">{c.text}</span>
          <CriterionVerdict criterion={c} />
        </li>
      ))}
    </ul>
  );
}

/**
 * The standing verdict pill for one criterion. A `gate`-kind criterion reads
 * its decision from `gate.verdict`; every other kind reads the orchestrator
 * gate's recorded `verification.verdict`. Both default to a pending tone when
 * no verdict is on record yet — never an evaluation triggered here.
 */
function CriterionVerdict({ criterion }: { criterion: AcceptanceCriterion }) {
  const { label, color } = criterionVerdictTone(criterion);
  return (
    <span
      className="shrink-0 mono text-[10px] uppercase tracking-wider px-1 h-4 inline-flex items-center rounded"
      style={{ color, background: `${color}14`, border: `1px solid ${color}44` }}
    >
      {label}
    </span>
  );
}

function criterionVerdictTone(criterion: AcceptanceCriterion): { label: string; color: string } {
  if (criterion.verifies_by === "gate") {
    const verdict = criterion.gate?.verdict ?? "gate_pending";
    if (verdict === "approved") return { label: "approved", color: "#50fa7b" };
    if (verdict === "rejected") return { label: "rejected", color: "#ff5555" };
    return { label: "pending", color: "#6272a4" };
  }
  const verdict = criterion.verification?.verdict ?? "pending";
  if (verdict === "verified") return { label: "verified", color: "#50fa7b" };
  if (verdict === "failed") return { label: "failed", color: "#ff5555" };
  return { label: "pending", color: "#6272a4" };
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
