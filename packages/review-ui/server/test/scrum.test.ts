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

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '@claude-prove/store';
import { openScrumStore } from '@claude-prove/cli/scrum/store';
import Fastify, { type FastifyInstance } from 'fastify';
import { makeProjectResolver } from '../src/projects';
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
  const store = await openScrumStore({ override: dbFile });
  try {
    // Milestones (2)
    await store.createMilestone({ id: 'm-active', title: 'Active milestone', status: 'active' });
    await store.createMilestone({ id: 'm-planned', title: 'Planned milestone', status: 'planned' });

    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();

    // Stalled WIP — built first so we can stamp last_event_at last.
    await store.createTask({
      id: STALLED_TASK_ID,
      title: 'Stalled WIP task',
      status: 'backlog',
      milestoneId: 'm-active',
      createdAt: eightDaysAgo,
      tags: ['p0'],
    });
    await store.updateTaskStatus(STALLED_TASK_ID, 'ready');
    await store.updateTaskStatus(STALLED_TASK_ID, 'in_progress');
    // Provision a context bundle so this task is NOT a missing-context alert.
    await store.saveContextBundle(STALLED_TASK_ID, { hint: 'seeded' });

    // Broken dep: stalled task blocks a (subsequently soft-deleted) task.
    // Add deps BEFORE the date override so any incidental writes don't reset
    // last_event_at after we backdate it.
    await store.createTask({ id: ORPHAN_DEP_TARGET, title: 'Will be deleted' });
    await store.addDep(STALLED_TASK_ID, ORPHAN_DEP_TARGET, 'blocks');
    await store.softDeleteTask(ORPHAN_DEP_TARGET);

    // Orphaned run alert: append the event BEFORE we backdate last_event_at,
    // because appendEvent bumps last_event_at on the underlying task.
    await store.appendEvent({
      taskId: STALLED_TASK_ID,
      kind: 'unlinked_run_detected',
      payload: { runPath: '.prove/runs/main/orphaned' },
    });

    // Now stamp last_event_at into the stalled window — must be the final
    // write that touches scrum_tasks for this row.
    await store
      .getStore()
      .run('UPDATE scrum_tasks SET last_event_at = ? WHERE id = ?', [eightDaysAgo, STALLED_TASK_ID]);

    // Fresh in_progress task — appears in missing_context (no bundle).
    await store.createTask({
      id: FRESH_WIP_ID,
      title: 'Fresh WIP task',
      status: 'backlog',
      milestoneId: 'm-active',
    });
    await store.updateTaskStatus(FRESH_WIP_ID, 'ready');
    await store.updateTaskStatus(FRESH_WIP_ID, 'in_progress');
    // 1 run link belongs to the fresh WIP task.
    await store.linkRun({
      taskId: FRESH_WIP_ID,
      runPath: '.prove/runs/main/sample-run',
      branch: 'orchestrator/sample-run',
      slug: 'sample-run',
    });

    // Done task.
    await store.createTask({ id: DONE_TASK_ID, title: 'Done task' });
    await store.updateTaskStatus(DONE_TASK_ID, 'ready');
    await store.updateTaskStatus(DONE_TASK_ID, 'in_progress');
    await store.updateTaskStatus(DONE_TASK_ID, 'done');

    // One additional plain note event — gets us to >=5 events when combined
    // with auto-created `task_created` + `status_changed` rows.
    await store.appendEvent({ taskId: FRESH_WIP_ID, kind: 'note', payload: { body: 'hello' } });
  } finally {
    store.close();
  }

  app = Fastify({ logger: false });
  registerScrumRoutes(app, makeProjectResolver(repoRoot));
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
    registerScrumRoutes(emptyApp, makeProjectResolver(emptyRoot));
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

// ---------------------------------------------------------------------------
// Task status transition (the single WRITE route)
//
// The transition route delegates to the `@claude-prove/store` `updateTaskStatus`
// service. These tests assert the HTTP surface around that delegation: the
// success path (200 + exactly one `status_changed` event), the closed-table
// rejection (422), the behind-schema refusal (409, no mutation), and a
// story-layer floor rejection (422). Each test boots a private tmp-rooted app
// so the shared read-suite fixture is never mutated, and tears it down in
// `afterEach`.
// ---------------------------------------------------------------------------

describe('POST /api/scrum/tasks/:id/status', () => {
  // Each case registers its own app + tmp root here so teardown is uniform and
  // the read-suite's shared `repoRoot` is never touched by a write.
  let txApp: FastifyInstance | null = null;
  let txRoot: string | null = null;

  afterEach(async () => {
    if (txApp) await txApp.close();
    if (txRoot) rmSync(txRoot, { recursive: true, force: true });
    txApp = null;
    txRoot = null;
  });

  // Resolved ScrumStore type — `openScrumStore` now returns a Promise.
  type Store = Awaited<ReturnType<typeof openScrumStore>>;

  /** Boot a migrated scrum store at a fresh tmp root and an app bound to it. */
  async function bootMigrated(seed: (store: Store) => Promise<void>) {
    const root = mkdtempSync(join(tmpdir(), 'prove-scrum-tx-'));
    mkdirSync(join(root, '.prove'), { recursive: true });
    const store = await openScrumStore({ override: join(root, '.prove/prove.db') });
    try {
      await seed(store);
    } finally {
      store.close();
    }
    const app = Fastify({ logger: false });
    registerScrumRoutes(app, makeProjectResolver(root));
    await app.ready();
    txApp = app;
    txRoot = root;
    return { app, root };
  }

  /** Count `status_changed` events for one task by reading the db read-only. */
  async function statusChangedCount(root: string, taskId: string): Promise<number> {
    const db = await openStore({ path: join(root, '.prove/prove.db'), readonly: true });
    try {
      const rows = await db.all<{ n: number }>(
        "SELECT COUNT(*) AS n FROM scrum_events WHERE task_id = ? AND kind = 'status_changed'",
        [taskId],
      );
      return rows[0]?.n ?? 0;
    } finally {
      db.close();
    }
  }

  test('valid transition → 200 with the post-write task + exactly one status_changed event', async () => {
    const { app, root } = await bootMigrated(async (store) => {
      await store.createTask({ id: 'tx-task', title: 'Flat task', status: 'backlog' });
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/scrum/tasks/tx-task/status',
      payload: { status: 'ready' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { task: { id: string; status: string } };
    expect(body.task.id).toBe('tx-task');
    expect(body.task.status).toBe('ready');
    // The service emits the transition event exactly once.
    expect(await statusChangedCount(root, 'tx-task')).toBe(1);
  });

  test('invalid transition → 422 with the service message', async () => {
    const { app } = await bootMigrated(async (store) => {
      // `done` is terminal: every outgoing edge is rejected by the service.
      await store.createTask({ id: 'tx-done', title: 'Done task', status: 'backlog' });
      await store.updateTaskStatus('tx-done', 'ready');
      await store.updateTaskStatus('tx-done', 'in_progress');
      await store.updateTaskStatus('tx-done', 'done');
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/scrum/tasks/tx-done/status',
      payload: { status: 'ready' },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json() as { error: string };
    expect(body.error).toContain('invalid transition');
  });

  test('story-layer floor rejection → 422', async () => {
    const { app } = await bootMigrated(async (store) => {
      // A `layer=story` task with zero acceptance criteria cannot enter `ready`:
      // the story acceptance floor rejects it from the service.
      await store.createTask({
        id: 'tx-story',
        title: 'Story without criteria',
        status: 'backlog',
        layer: 'story',
      });
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/scrum/tasks/tx-story/status',
      payload: { status: 'ready' },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json() as { error: string };
    expect(body.error).toContain('no active acceptance criteria');
  });

  test('behind-schema project → 409 with the structured body, no mutation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'prove-scrum-behind-'));
    mkdirSync(join(root, '.prove'), { recursive: true });
    // Re-land the live scrum domain so the guard's expected-version lookup sees
    // scrum's real head — a prior test file's `clearRegistry()` may have wiped
    // it. Opening an in-memory scrum store calls `ensureScrumSchemaRegistered`.
    (await openScrumStore({ path: ':memory:' })).close();
    // Seed a `_migrations_log` at scrum@1 (below the live scrum head) so the db
    // reads as behind. The guard refuses before opening the writable store, so
    // no scrum tables are needed for the refusal.
    await seedBehindScrumDb(root);

    const app = Fastify({ logger: false });
    registerScrumRoutes(app, makeProjectResolver(root));
    await app.ready();
    txApp = app;
    txRoot = root;

    const res = await app.inject({
      method: 'POST',
      url: '/api/scrum/tasks/whatever/status',
      payload: { status: 'ready' },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json() as { error: string; project: string; store: { behind: boolean } };
    expect(body.error).toBe('store schema behind');
    expect(body.project).toBe(root);
    expect(body.store.behind).toBe(true);
    // The refusal never opened the writable (migrating) store, so the db keeps
    // its sole seeded `_migrations_log` row and grows no scrum tables.
    expect(await scrumTablesExist(root)).toBe(false);
  });
});

/**
 * Seed `<root>/.prove/prove.db` with only a `_migrations_log` row at scrum@1.
 * That sits below the live scrum head, so the guard reports the project behind
 * without the db carrying any scrum domain tables.
 */
async function seedBehindScrumDb(root: string): Promise<void> {
  const db = await openStore({ path: join(root, '.prove/prove.db') });
  try {
    await db.exec(`
      CREATE TABLE _migrations_log (
        domain TEXT NOT NULL,
        version INTEGER NOT NULL,
        description TEXT NOT NULL,
        applied_at TEXT NOT NULL,
        PRIMARY KEY (domain, version)
      );
      INSERT INTO _migrations_log (domain, version, description, applied_at)
        VALUES ('scrum', 1, 'create scrum domain tables', '2026-01-01T00:00:00Z');
    `);
  } finally {
    db.close();
  }
}

/** Whether the db grew any `scrum_`-prefixed table (proof a write opened it). */
async function scrumTablesExist(root: string): Promise<boolean> {
  const db = await openStore({ path: join(root, '.prove/prove.db'), readonly: true });
  try {
    const rows = await db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'scrum_%'",
    );
    return rows.length > 0;
  } finally {
    db.close();
  }
}
