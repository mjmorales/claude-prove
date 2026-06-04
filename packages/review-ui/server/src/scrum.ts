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
 * **Reads are read-only by contract; exactly ONE write route exists.** Every
 * GET handler opens the store read-style and never mutates. The single write
 * route — `POST /api/scrum/tasks/:id/status` — drives a task status transition
 * through the SAME write path the `claude-prove scrum` CLI uses: the
 * `@claude-prove/store` `updateTaskStatus` service (closed transition table,
 * story-layer floors, one `status_changed` event). It is NOT a reimplementation
 * — it imports and delegates to that service so the event log and provenance
 * stay single-sourced.
 *
 * The write route MUST call `refuseIfBehindSchema(repoRoot, reply)` FIRST: a
 * project whose `.prove/prove.db` sits behind the registered expected schema is
 * refused with HTTP 409 (the structured `SchemaGuardError` body), exactly as
 * the acb verdict write paths do — writing through an unmigrated foreign db
 * assumes a table shape that may not yet exist there. Reads stay unguarded so a
 * behind project is still inspectable. Any FURTHER server-side scrum write added
 * here must route through the same guard before touching the store.
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
import { updateTaskStatus } from '@claude-prove/store';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ProjectResolver } from './projects.js';
import { storeBehindSchema } from './schema-guard.js';

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
 * Open a writable ScrumStore for the single transition route, creating the
 * `.prove` dir + db on first write (mirrors acb's writable opener). `openScrumStore`
 * runs every pending scrum migration on open, so a fail-open uninitialized project
 * is brought to the current shape the transition service assumes before it writes.
 */
function openWritableStore(repoRoot: string): ScrumStore {
  const p = dbPath(repoRoot);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return openScrumStore({ override: p });
}

/**
 * Refuse a write to a project whose store schema is behind the registered
 * expected versions: reply HTTP 409 with the structured `SchemaGuardError` body
 * and return true (the handler must then `return reply`). Returns false when the
 * write may proceed. Mirrors the acb verdict write paths — every scrum write
 * routes through here first so the listing's "needs migration" badge and the
 * write refusal can never disagree.
 */
function refuseIfBehindSchema(repoRoot: string, reply: FastifyReply): boolean {
  const behind = storeBehindSchema(repoRoot);
  if (behind === null) return false;
  reply.code(409).send(behind);
  return true;
}

/**
 * Closed set of valid target statuses for the transition route. Mirrors the
 * `TaskStatus` enum; the request body is rejected with 400 before the store
 * opens when `status` is outside this set. The transition LEGALITY (which
 * from→to edges are allowed) is the `updateTaskStatus` service's call, surfaced
 * as 422 — this set only screens malformed input.
 */
const VALID_TARGET_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'backlog',
  'proposed',
  'accepted',
  'ready',
  'in_progress',
  'review',
  'blocked',
  'done',
  'cancelled',
]);

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

export function registerScrumRoutes(app: FastifyInstance, resolveProject: ProjectResolver) {
  // List tasks with optional filters.
  app.get<{
    Querystring: { status?: string; milestone?: string; tag?: string };
  }>('/api/scrum/tasks', async (req, reply) => {
    const repoRoot = resolveProject(req, reply);
    if (repoRoot === null) return reply;
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
    const repoRoot = resolveProject(req, reply);
    if (repoRoot === null) return reply;
    const { id } = req.params;
    return withStore(repoRoot, reply, { kind: 'not-found', message: 'task not found' }, (store) =>
      buildTaskDetail(store, id, reply),
    );
  });

  // Event timeline for one task.
  app.get<{ Params: { id: string } }>('/api/scrum/tasks/:id/events', async (req, reply) => {
    const repoRoot = resolveProject(req, reply);
    if (repoRoot === null) return reply;
    const { id } = req.params;
    return withStore(repoRoot, reply, { kind: 'not-found', message: 'task not found' }, (store) =>
      buildTaskEvents(store, id, reply),
    );
  });

  // List milestones (optionally filtered by status).
  app.get<{ Querystring: { status?: string } }>('/api/scrum/milestones', async (req, reply) => {
    const repoRoot = resolveProject(req, reply);
    if (repoRoot === null) return reply;
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
    const repoRoot = resolveProject(req, reply);
    if (repoRoot === null) return reply;
    const { id } = req.params;
    return withStore(
      repoRoot,
      reply,
      { kind: 'not-found', message: 'milestone not found' },
      (store) => buildMilestoneRollup(store, id, reply),
    );
  });

  // Aggregated alerts across the 4 documented categories.
  app.get('/api/scrum/alerts', async (req, reply) => {
    const repoRoot = resolveProject(req, reply);
    if (repoRoot === null) return reply;
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
      const repoRoot = resolveProject(req, reply);
      if (repoRoot === null) return reply;
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
    const repoRoot = resolveProject(req, reply);
    if (repoRoot === null) return reply;
    const limit = parseLimit(req.query.limit, RECENT_EVENTS_DEFAULT_LIMIT);
    return withStore<{ events: ScrumEvent[] }>(
      repoRoot,
      reply,
      { kind: 'default', value: { events: [] } },
      (store) => ({ events: store.listRecentEvents(limit) }),
    );
  });

  // The single scrum WRITE route: transition a task's status through the shared
  // `@claude-prove/store` `updateTaskStatus` service. Guard fires FIRST, then
  // the service decides transition legality + story floors; its throws surface
  // as 422 so the client can show the message inline.
  app.post<{ Params: { id: string }; Body: { status?: unknown } }>(
    '/api/scrum/tasks/:id/status',
    async (req, reply) => {
      const repoRoot = resolveProject(req, reply);
      if (repoRoot === null) return reply;
      if (refuseIfBehindSchema(repoRoot, reply)) return reply;

      const { id } = req.params;
      const status = req.body?.status;
      if (typeof status !== 'string' || !VALID_TARGET_STATUSES.has(status as TaskStatus)) {
        return reply.code(400).send({ error: 'bad status' });
      }

      const store = openWritableStore(repoRoot);
      try {
        // Delegate to the canonical write service (NOT a reimplementation):
        // closed transition table, story-layer floors, one `status_changed`
        // event. Pass the raw Store handle the read routes' wrapper exposes.
        const task = updateTaskStatus(store.getStore(), id, status as TaskStatus);
        return { task };
      } catch (err) {
        // Service throws on unknown id, illegal transition, and unmet story
        // floors — all client-correctable, so surface the message as 422 rather
        // than a 500. The message names the offending task/transition/criteria.
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(422).send({ error: message });
      } finally {
        store.close();
      }
    },
  );
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
    proposed: 0,
    accepted: 0,
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
