/**
 * Review-UI scrum read-only API.
 *
 * Mirrors the structural pattern of `server/src/acb.ts`:
 *   - thin wrapper around `@claude-prove/cli`'s `ScrumStore`
 *   - opens a short-lived store per request (matches acb's open-on-each-call
 *     lifecycle so migrations stay idempotent and handles never leak)
 *   - exposes a `registerScrumRoutes(app, repoRoot)` function consumed by
 *     `server/src/index.ts` alongside the other route registrars
 *
 * **Read-only by contract.** No POST/PUT/DELETE/PATCH routes — operators
 * mutate scrum state via the CLI (`prove scrum task ...`) or the
 * scrum-master agent. Any mutation would bypass event sourcing + agent
 * provenance and is therefore rejected at the route registration boundary.
 */

import fs from 'node:fs';
import path from 'node:path';
import { type ScrumStore, openScrumStore } from '@claude-prove/cli/scrum/store';
import type {
  MilestoneStatus,
  ScrumEvent,
  ScrumMilestone,
  ScrumTask,
  TaskStatus,
} from '@claude-prove/cli/scrum/types';
import type { FastifyInstance, FastifyReply } from 'fastify';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STALL_MS = 7 * 24 * 60 * 60 * 1000;
const ORPHAN_RUN_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const RECENT_EVENTS_DEFAULT_LIMIT = 20;
const RECENT_EVENTS_MAX_LIMIT = 500;

// ---------------------------------------------------------------------------
// Store lifecycle
// ---------------------------------------------------------------------------

function dbPath(repoRoot: string): string {
  return path.join(repoRoot, '.prove/prove.db');
}

/**
 * Open a ScrumStore if `.prove/prove.db` exists, else null. Read-only routes
 * short-circuit when the file is absent rather than auto-creating it — keeps
 * GET handlers idempotent and matches acb's `openStoreIfExists` semantics.
 */
function openStoreIfExists(repoRoot: string): ScrumStore | null {
  const p = dbPath(repoRoot);
  if (!fs.existsSync(p)) return null;
  return openScrumStore({ override: p });
}

/**
 * Missing-db fallback policy:
 *   - `{ kind: 'default', value }` — return `value` verbatim (read-only empty).
 *   - `{ kind: 'not-found', message }` — respond 404 with `message` as the body.
 */
type StoreOrElse<T> =
  | { kind: 'default'; value: T }
  | { kind: 'not-found'; message: string };

/**
 * Run `fn` with a short-lived ScrumStore. Returns:
 *   - `fn(store)` when the db file exists
 *   - the `orElse` fallback when the db file is absent
 *   - the Fastify `reply` (already 500'd) when opening throws — the caller
 *     forwards this verbatim so Fastify doesn't double-serialize
 */
function withStore<T>(
  repoRoot: string,
  reply: FastifyReply,
  orElse: StoreOrElse<T>,
  fn: (store: ScrumStore) => T | FastifyReply,
): T | FastifyReply {
  let store: ScrumStore | null;
  try {
    store = openStoreIfExists(repoRoot);
  } catch {
    return reply.code(500).send({ error: 'scrum store unavailable' });
  }
  if (store === null) {
    return orElse.kind === 'default'
      ? orElse.value
      : reply.code(404).send({ error: orElse.message });
  }
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerScrumRoutes(app: FastifyInstance, repoRoot: string) {
  // List tasks with optional filters.
  app.get<{
    Querystring: { status?: string; milestone?: string; tag?: string };
  }>('/api/scrum/tasks', async (req, reply) => {
    const { status, milestone, tag } = req.query;
    return withStore<{ tasks: ScrumTask[] }>(
      repoRoot,
      reply,
      { kind: 'default', value: { tasks: [] } },
      (store) => {
        let tasks: ScrumTask[];
        if (tag) {
          tasks = store.listTasksForTag(tag);
          if (status) tasks = tasks.filter((t) => t.status === (status as TaskStatus));
          if (milestone) tasks = tasks.filter((t) => t.milestone_id === milestone);
        } else {
          tasks = store.listTasks({
            status: status as TaskStatus | undefined,
            milestoneId: milestone,
          });
        }
        return { tasks };
      },
    );
  });

  // Task detail + embedded timeline + linked runs + linked decisions.
  app.get<{ Params: { id: string } }>('/api/scrum/tasks/:id', async (req, reply) => {
    const { id } = req.params;
    return withStore(repoRoot, reply, { kind: 'not-found', message: 'task not found' }, (store) =>
      buildTaskDetail(store, id, reply),
    );
  });

  // Event timeline for one task.
  app.get<{ Params: { id: string } }>('/api/scrum/tasks/:id/events', async (req, reply) => {
    const { id } = req.params;
    return withStore(repoRoot, reply, { kind: 'not-found', message: 'task not found' }, (store) =>
      buildTaskEvents(store, id, reply),
    );
  });

  // List milestones (optionally filtered by status).
  app.get<{ Querystring: { status?: string } }>('/api/scrum/milestones', async (req, reply) => {
    const { status } = req.query;
    return withStore<{ milestones: ScrumMilestone[] }>(
      repoRoot,
      reply,
      { kind: 'default', value: { milestones: [] } },
      (store) => ({
        milestones: store.listMilestones(status as MilestoneStatus | undefined),
      }),
    );
  });

  // Milestone rollup: tasks belonging to milestone + status counts.
  app.get<{ Params: { id: string } }>('/api/scrum/milestones/:id', async (req, reply) => {
    const { id } = req.params;
    return withStore(
      repoRoot,
      reply,
      { kind: 'not-found', message: 'milestone not found' },
      (store) => buildMilestoneRollup(store, id, reply),
    );
  });

  // Aggregated alerts across the 4 documented categories.
  app.get('/api/scrum/alerts', async (_req, reply) => {
    return withStore(
      repoRoot,
      reply,
      {
        kind: 'default',
        value: { stalled_wip: [], broken_deps: [], missing_context: [], orphaned_runs: [] },
      },
      (store) => buildAlerts(store),
    );
  });

  // Context bundle for a single task.
  app.get<{ Params: { task_id: string } }>(
    '/api/scrum/context-bundles/:task_id',
    async (req, reply) => {
      const { task_id: taskId } = req.params;
      return withStore(
        repoRoot,
        reply,
        { kind: 'not-found', message: 'context bundle not found' },
        (store) => {
          const bundle = store.loadContextBundle(taskId);
          if (!bundle) return reply.code(404).send({ error: 'context bundle not found' });
          return bundle;
        },
      );
    },
  );

  // Cross-task recent event feed for the Now-view.
  app.get<{ Querystring: { limit?: string } }>('/api/scrum/events/recent', async (req, reply) => {
    const limit = parseLimit(req.query.limit, RECENT_EVENTS_DEFAULT_LIMIT);
    return withStore<{ events: ScrumEvent[] }>(
      repoRoot,
      reply,
      { kind: 'default', value: { events: [] } },
      (store) => ({ events: store.listRecentEvents(limit) }),
    );
  });
}

// ---------------------------------------------------------------------------
// Per-route assemblers
// ---------------------------------------------------------------------------

function buildTaskDetail(store: ScrumStore, id: string, reply: FastifyReply) {
  const task = store.getTask(id);
  if (!task) return reply.code(404).send({ error: 'task not found' });
  const events = store.listEventsForTask(id);
  const runs = store.listRunsForTask(id);
  const tags = store.listTagsForTask(id).map((row) => row.tag);
  const blockedBy = store.getBlockedBy(id);
  const blocking = store.getBlocking(id);
  const decisions = events
    .filter((e) => e.kind === 'decision_linked')
    .map((e) => ({ id: e.id, ts: e.ts, payload: e.payload }));
  return { task, tags, events, runs, decisions, blocked_by: blockedBy, blocking };
}

function buildTaskEvents(store: ScrumStore, id: string, reply: FastifyReply) {
  const task = store.getTask(id);
  if (!task) return reply.code(404).send({ error: 'task not found' });
  return { task_id: id, events: store.listEventsForTask(id) };
}

function buildMilestoneRollup(store: ScrumStore, id: string, reply: FastifyReply) {
  const milestone = store.getMilestone(id);
  if (!milestone) return reply.code(404).send({ error: 'milestone not found' });
  const tasks = store.listTasks({ milestoneId: id });
  const rollup = computeStatusRollup(tasks);
  return { milestone, tasks, rollup };
}

interface AlertsPayload {
  stalled_wip: ScrumTask[];
  broken_deps: BrokenDep[];
  missing_context: ScrumTask[];
  orphaned_runs: ScrumEvent[];
}

function buildAlerts(store: ScrumStore): AlertsPayload {
  // Fetch the full task set once and derive both views in-memory — avoids a
  // second round-trip through `listTasks` just to filter by status.
  const allTasks = store.listTasks({});
  const inProgress = allTasks.filter((t) => t.status === 'in_progress');

  const stalledCutoff = Date.now() - STALL_MS;
  const stalledWip = inProgress.filter((t) => isStalled(t, stalledCutoff));

  const knownIds = new Set(allTasks.map((t) => t.id));
  const brokenDeps = collectBrokenDeps(store, allTasks, knownIds);

  const missingContext = inProgress.filter((t) => store.loadContextBundle(t.id) === null);

  const orphanCutoff = Date.now() - ORPHAN_RUN_LOOKBACK_MS;
  const orphanedRuns = store
    .listRecentEvents(RECENT_EVENTS_MAX_LIMIT)
    .filter((e) => e.kind === 'unlinked_run_detected')
    .filter((e) => Date.parse(e.ts) >= orphanCutoff);

  return {
    stalled_wip: stalledWip,
    broken_deps: brokenDeps,
    missing_context: missingContext,
    orphaned_runs: orphanedRuns,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeStatusRollup(tasks: ScrumTask[]): Record<TaskStatus, number> {
  const counts: Record<TaskStatus, number> = {
    backlog: 0,
    ready: 0,
    in_progress: 0,
    review: 0,
    blocked: 0,
    done: 0,
    cancelled: 0,
  };
  for (const t of tasks) counts[t.status] += 1;
  return counts;
}

function isStalled(task: ScrumTask, cutoffMs: number): boolean {
  if (!task.last_event_at) return true;
  const ts = Date.parse(task.last_event_at);
  if (Number.isNaN(ts)) return false;
  return ts < cutoffMs;
}

interface BrokenDep {
  task_id: string;
  missing_to_task_id: string;
  kind: string;
}

/**
 * Collect deps whose `to_task_id` is no longer present in `scrum_tasks`
 * (soft-deleted or never existed). Walks each task's outgoing `blocks`
 * edges; the reverse direction is implied by referential symmetry on the
 * deps table.
 */
function collectBrokenDeps(
  store: ScrumStore,
  tasks: ScrumTask[],
  knownIds: Set<string>,
): BrokenDep[] {
  const broken: BrokenDep[] = [];
  for (const t of tasks) {
    const out = store.getBlocking(t.id);
    for (const dep of out) {
      if (!knownIds.has(dep.to_task_id)) {
        broken.push({
          task_id: t.id,
          missing_to_task_id: dep.to_task_id,
          kind: dep.kind,
        });
      }
    }
  }
  return broken;
}

function parseLimit(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, RECENT_EVENTS_MAX_LIMIT);
}
