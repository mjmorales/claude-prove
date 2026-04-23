/**
 * Integration tests for review-ui server's read-only scrum API.
 *
 * Each test boots a fresh Fastify instance bound to a tmpdir-rooted scrum
 * store, seeds it via `ScrumStore` methods, then exercises every route via
 * `app.inject` and asserts response shape + status code.
 *
 * Coverage matrix:
 *   - 3 tasks (1 per status: backlog / in_progress / done)
 *   - 2 milestones
 *   - 5 events (task_created auto + manual notes)
 *   - 1 run link
 *   - 1 context bundle
 *   - all 4 alert categories populated (stalled WIP, broken deps,
 *     missing context, orphaned runs)
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openScrumStore } from '@claude-prove/cli/scrum/store';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerScrumRoutes } from '../src/scrum';

let repoRoot: string;
let app: FastifyInstance;

const STALLED_TASK_ID = 'task-stalled';
const FRESH_WIP_ID = 'task-wip';
const DONE_TASK_ID = 'task-done';
const ORPHAN_DEP_TARGET = 'task-deleted-target';

beforeAll(async () => {
  repoRoot = mkdtempSync(join(tmpdir(), 'prove-scrum-server-'));
  mkdirSync(join(repoRoot, '.prove'), { recursive: true });

  // Seed fixtures via ScrumStore directly.
  const dbFile = join(repoRoot, '.prove/prove.db');
  const store = openScrumStore({ override: dbFile });
  try {
    // Milestones (2)
    store.createMilestone({ id: 'm-active', title: 'Active milestone', status: 'active' });
    store.createMilestone({ id: 'm-planned', title: 'Planned milestone', status: 'planned' });

    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();

    // Stalled WIP — built first so we can stamp last_event_at last.
    store.createTask({
      id: STALLED_TASK_ID,
      title: 'Stalled WIP task',
      status: 'backlog',
      milestoneId: 'm-active',
      createdAt: eightDaysAgo,
      tags: ['p0'],
    });
    store.updateTaskStatus(STALLED_TASK_ID, 'ready');
    store.updateTaskStatus(STALLED_TASK_ID, 'in_progress');
    // Provision a context bundle so this task is NOT a missing-context alert.
    store.saveContextBundle(STALLED_TASK_ID, { hint: 'seeded' });

    // Broken dep: stalled task blocks a (subsequently soft-deleted) task.
    // Add deps BEFORE the date override so any incidental writes don't reset
    // last_event_at after we backdate it.
    store.createTask({ id: ORPHAN_DEP_TARGET, title: 'Will be deleted' });
    store.addDep(STALLED_TASK_ID, ORPHAN_DEP_TARGET, 'blocks');
    store.softDeleteTask(ORPHAN_DEP_TARGET);

    // Orphaned run alert: append the event BEFORE we backdate last_event_at,
    // because appendEvent bumps last_event_at on the underlying task.
    store.appendEvent({
      taskId: STALLED_TASK_ID,
      kind: 'unlinked_run_detected',
      payload: { runPath: '.prove/runs/main/orphaned' },
    });

    // Now stamp last_event_at into the stalled window — must be the final
    // write that touches scrum_tasks for this row.
    store
      .getStore()
      .getDb()
      .prepare('UPDATE scrum_tasks SET last_event_at = ? WHERE id = ?')
      .run(eightDaysAgo, STALLED_TASK_ID);

    // Fresh in_progress task — appears in missing_context (no bundle).
    store.createTask({
      id: FRESH_WIP_ID,
      title: 'Fresh WIP task',
      status: 'backlog',
      milestoneId: 'm-active',
    });
    store.updateTaskStatus(FRESH_WIP_ID, 'ready');
    store.updateTaskStatus(FRESH_WIP_ID, 'in_progress');
    // 1 run link belongs to the fresh WIP task.
    store.linkRun({
      taskId: FRESH_WIP_ID,
      runPath: '.prove/runs/main/sample-run',
      branch: 'orchestrator/sample-run',
      slug: 'sample-run',
    });

    // Done task.
    store.createTask({ id: DONE_TASK_ID, title: 'Done task' });
    store.updateTaskStatus(DONE_TASK_ID, 'ready');
    store.updateTaskStatus(DONE_TASK_ID, 'in_progress');
    store.updateTaskStatus(DONE_TASK_ID, 'done');

    // One additional plain note event — gets us to >=5 events when combined
    // with auto-created `task_created` + `status_changed` rows.
    store.appendEvent({ taskId: FRESH_WIP_ID, kind: 'note', payload: { body: 'hello' } });
  } finally {
    store.close();
  }

  app = Fastify({ logger: false });
  registerScrumRoutes(app, repoRoot);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  rmSync(repoRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

describe('GET /api/scrum/tasks', () => {
  test('returns all non-deleted tasks', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/scrum/tasks' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { tasks: Array<{ id: string; status: string }> };
    const ids = body.tasks.map((t) => t.id).sort();
    expect(ids).toEqual([DONE_TASK_ID, FRESH_WIP_ID, STALLED_TASK_ID].sort());
  });

  test('filters by status', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/scrum/tasks?status=in_progress' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { tasks: Array<{ id: string }> };
    const ids = body.tasks.map((t) => t.id).sort();
    expect(ids).toEqual([FRESH_WIP_ID, STALLED_TASK_ID].sort());
  });

  test('filters by milestone', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/scrum/tasks?milestone=m-active' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { tasks: Array<{ id: string }> };
    const ids = body.tasks.map((t) => t.id).sort();
    expect(ids).toEqual([FRESH_WIP_ID, STALLED_TASK_ID].sort());
  });

  test('filters by tag', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/scrum/tasks?tag=p0' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { tasks: Array<{ id: string }> };
    expect(body.tasks.map((t) => t.id)).toEqual([STALLED_TASK_ID]);
  });
});

describe('GET /api/scrum/tasks/:id', () => {
  test('returns task detail with timeline + runs + decisions', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/scrum/tasks/${FRESH_WIP_ID}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      task: { id: string };
      events: unknown[];
      runs: Array<{ run_path: string }>;
      decisions: unknown[];
      tags: string[];
      blocked_by: unknown[];
      blocking: unknown[];
    };
    expect(body.task.id).toBe(FRESH_WIP_ID);
    expect(body.events.length).toBeGreaterThan(0);
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0]?.run_path).toBe('.prove/runs/main/sample-run');
    expect(Array.isArray(body.decisions)).toBe(true);
  });

  test('404 with { error } when missing', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/scrum/tasks/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'task not found' });
  });
});

describe('GET /api/scrum/tasks/:id/events', () => {
  test('returns timeline for one task', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/scrum/tasks/${STALLED_TASK_ID}/events`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { task_id: string; events: Array<{ kind: string }> };
    expect(body.task_id).toBe(STALLED_TASK_ID);
    expect(body.events.length).toBeGreaterThanOrEqual(3);
    expect(body.events.some((e) => e.kind === 'task_created')).toBe(true);
  });

  test('404 when task missing', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/scrum/tasks/nope/events' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'task not found' });
  });
});

// ---------------------------------------------------------------------------
// Milestones
// ---------------------------------------------------------------------------

describe('GET /api/scrum/milestones', () => {
  test('returns all milestones', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/scrum/milestones' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { milestones: Array<{ id: string }> };
    const ids = body.milestones.map((m) => m.id).sort();
    expect(ids).toEqual(['m-active', 'm-planned']);
  });
});

describe('GET /api/scrum/milestones/:id', () => {
  test('returns milestone + tasks + status rollup', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/scrum/milestones/m-active' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      milestone: { id: string };
      tasks: Array<{ id: string }>;
      rollup: Record<string, number>;
    };
    expect(body.milestone.id).toBe('m-active');
    const taskIds = body.tasks.map((t) => t.id).sort();
    expect(taskIds).toEqual([FRESH_WIP_ID, STALLED_TASK_ID].sort());
    expect(body.rollup.in_progress).toBe(2);
  });

  test('404 when missing', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/scrum/milestones/missing' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'milestone not found' });
  });
});

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

describe('GET /api/scrum/alerts', () => {
  test('aggregates all 4 categories from seeded fixtures', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/scrum/alerts' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      stalled_wip: Array<{ id: string }>;
      broken_deps: Array<{ task_id: string; missing_to_task_id: string }>;
      missing_context: Array<{ id: string }>;
      orphaned_runs: Array<{ kind: string }>;
    };
    expect(body.stalled_wip.map((t) => t.id)).toContain(STALLED_TASK_ID);
    expect(body.broken_deps.some((d) => d.missing_to_task_id === ORPHAN_DEP_TARGET)).toBe(true);
    expect(body.missing_context.map((t) => t.id)).toContain(FRESH_WIP_ID);
    expect(body.orphaned_runs.length).toBeGreaterThanOrEqual(1);
    expect(body.orphaned_runs[0]?.kind).toBe('unlinked_run_detected');
  });
});

// ---------------------------------------------------------------------------
// Context bundles
// ---------------------------------------------------------------------------

describe('GET /api/scrum/context-bundles/:task_id', () => {
  test('returns the bundle JSON', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/scrum/context-bundles/${STALLED_TASK_ID}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { task_id: string; bundle: { hint: string } };
    expect(body.task_id).toBe(STALLED_TASK_ID);
    expect(body.bundle).toEqual({ hint: 'seeded' });
  });

  test('404 when no bundle exists', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/scrum/context-bundles/${FRESH_WIP_ID}`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'context bundle not found' });
  });
});

// ---------------------------------------------------------------------------
// Recent events feed
// ---------------------------------------------------------------------------

describe('GET /api/scrum/events/recent', () => {
  test('returns event feed with default limit', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/scrum/events/recent' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { events: Array<{ kind: string }> };
    expect(body.events.length).toBeGreaterThanOrEqual(5);
  });

  test('respects ?limit=', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/scrum/events/recent?limit=2' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { events: Array<unknown> };
    expect(body.events).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Empty-store fallback
// ---------------------------------------------------------------------------

describe('missing .prove/prove.db', () => {
  test('list endpoints return empty payloads instead of 500', async () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), 'prove-scrum-empty-'));
    const emptyApp = Fastify({ logger: false });
    registerScrumRoutes(emptyApp, emptyRoot);
    await emptyApp.ready();
    try {
      const tasks = await emptyApp.inject({ method: 'GET', url: '/api/scrum/tasks' });
      expect(tasks.statusCode).toBe(200);
      expect(tasks.json()).toEqual({ tasks: [] });

      const ms = await emptyApp.inject({ method: 'GET', url: '/api/scrum/milestones' });
      expect(ms.statusCode).toBe(200);
      expect(ms.json()).toEqual({ milestones: [] });
    } finally {
      await emptyApp.close();
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });
});
