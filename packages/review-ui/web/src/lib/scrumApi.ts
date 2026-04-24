/**
 * Scrum read-only API client. Mirrors the server route shapes in
 * `packages/review-ui/server/src/scrum.ts`.
 *
 * Intentionally GET-only — the server refuses mutating verbs, and the
 * `/scrum/*` UI surface is a read-only operator dashboard. Mutations happen
 * via the `prove scrum` CLI and the scrum-master agent.
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
import { getJSON } from "./fetch-utils";

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
};
