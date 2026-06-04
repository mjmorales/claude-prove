/**
 * Scrum API client. Mirrors the server route shapes in
 * `packages/review-ui/server/src/scrum.ts`.
 *
 * Reads are GET-only. The single mutating verb is `transitionTask`, which POSTs
 * a target status to the server's one write route; the server delegates to the
 * `@claude-prove/store` `updateTaskStatus` service so the CLI and the UI share
 * one write path. All other scrum mutations still happen via the
 * `claude-prove scrum` CLI and the scrum-master agent.
 */

import type {
  ScrumContextBundle,
  ScrumDep,
  ScrumEvent,
  ScrumMilestone,
  ScrumRunLink,
  ScrumTask,
  TaskStatus,
} from "@claude-prove/cli/scrum/types";
import { getJSON, postJSON } from "./fetch-utils";

// ---------------------------------------------------------------------------
// Response envelope types — one per server route.
// ---------------------------------------------------------------------------

export type TasksResponse = { tasks: ScrumTask[] };

export type TaskDetailResponse = {
  task: ScrumTask;
  tags: string[];
  events: ScrumEvent[];
  runs: ScrumRunLink[];
  /** Decision-linked events projected as decision refs. */
  decisions: Array<{ id: number; ts: string; payload: unknown }>;
  blocked_by: ScrumDep[];
  blocking: ScrumDep[];
};

export type MilestonesResponse = { milestones: ScrumMilestone[] };

export type MilestoneRollupResponse = {
  milestone: ScrumMilestone;
  tasks: ScrumTask[];
  rollup: Record<TaskStatus, number>;
};

export type BrokenDep = {
  task_id: string;
  missing_to_task_id: string;
  kind: string;
};

export type AlertsResponse = {
  stalled_wip: ScrumTask[];
  broken_deps: BrokenDep[];
  missing_context: ScrumTask[];
  orphaned_runs: ScrumEvent[];
};

export type RecentEventsResponse = { events: ScrumEvent[] };

/** Post-write task view the transition route returns. */
export type TransitionResponse = { task: ScrumTask };

// ---------------------------------------------------------------------------
// Closed forward-transition table (mirror of the canonical store table)
//
// The web bundle cannot import `@claude-prove/store`, so the allowed-edge table
// is duplicated here. The CANONICAL copy is `ALLOWED_TRANSITIONS` in
// `packages/store/src/services/scrum-writes.ts`; the server's `updateTaskStatus`
// is the enforcing authority and rejects any edge this table gets wrong with a
// 422. This client copy only drives which buttons render — it never gates the
// write, so a drift here at worst offers a button the server then refuses.
// ---------------------------------------------------------------------------

const ALLOWED_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  backlog: ["proposed", "ready", "in_progress", "cancelled"],
  proposed: ["accepted", "backlog", "cancelled"],
  accepted: ["ready", "in_progress", "backlog", "cancelled"],
  ready: ["in_progress", "blocked", "cancelled", "backlog"],
  in_progress: ["review", "blocked", "done", "cancelled", "ready"],
  review: ["in_progress", "done", "cancelled"],
  blocked: ["ready", "in_progress", "cancelled"],
  done: [],
  cancelled: [],
};

/** The target statuses a task in `from` may transition to. */
export function allowedTransitions(from: TaskStatus): TaskStatus[] {
  return ALLOWED_TRANSITIONS[from] ?? [];
}

// ---------------------------------------------------------------------------
// URL helper
// ---------------------------------------------------------------------------

function enc(v: string): string {
  return encodeURIComponent(v);
}

// ---------------------------------------------------------------------------
// Filter shapes
// ---------------------------------------------------------------------------

export type TaskFilters = {
  status?: TaskStatus;
  milestone?: string;
  tag?: string;
};

function buildTaskQuery(filters: TaskFilters | undefined): string {
  if (!filters) return "";
  const p = new URLSearchParams();
  if (filters.status) p.set("status", filters.status);
  if (filters.milestone) p.set("milestone", filters.milestone);
  if (filters.tag) p.set("tag", filters.tag);
  const s = p.toString();
  return s ? `?${s}` : "";
}

// ---------------------------------------------------------------------------
// Public client
// ---------------------------------------------------------------------------

export const scrumApi = {
  tasks: (filters?: TaskFilters) =>
    getJSON<TasksResponse>(`/api/scrum/tasks${buildTaskQuery(filters)}`),
  task: (id: string) => getJSON<TaskDetailResponse>(`/api/scrum/tasks/${enc(id)}`),
  milestones: (status?: "planned" | "active" | "closed") =>
    getJSON<MilestonesResponse>(
      `/api/scrum/milestones${status ? `?status=${enc(status)}` : ""}`,
    ),
  milestone: (id: string) =>
    getJSON<MilestoneRollupResponse>(`/api/scrum/milestones/${enc(id)}`),
  alerts: () => getJSON<AlertsResponse>("/api/scrum/alerts"),
  contextBundle: (taskId: string) =>
    getJSON<ScrumContextBundle>(`/api/scrum/context-bundles/${enc(taskId)}`),
  recentEvents: (limit = 20) =>
    getJSON<RecentEventsResponse>(`/api/scrum/events/recent?limit=${limit}`),
  transitionTask: (id: string, status: TaskStatus) =>
    postJSON<TransitionResponse>(`/api/scrum/tasks/${enc(id)}/status`, { status }),
};
