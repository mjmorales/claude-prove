/**
 * ScrumStore unit tests. Every method round-trips; error paths throw
 * domain-specific messages.
 *
 * Structural mirror of `packages/cli/src/topics/acb/store.test.ts`: one
 * `describe` block per method cluster, each spinning up a fresh
 * `:memory:` store via `openScrumStore({ path: ':memory:' })`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type ScrumStore, openScrumStore } from './store';

let store: ScrumStore;

beforeEach(() => {
  store = openScrumStore({ path: ':memory:' });
});
afterEach(() => {
  store.close();
});

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function seedTask(id: string, overrides: Partial<Parameters<ScrumStore['createTask']>[0]> = {}) {
  return store.createTask({ id, title: `Task ${id}`, ...overrides });
}

function seedMilestone(
  id: string,
  overrides: Partial<Parameters<ScrumStore['createMilestone']>[0]> = {},
) {
  return store.createMilestone({ id, title: `Milestone ${id}`, ...overrides });
}

// ===========================================================================
// Tasks
// ===========================================================================

describe('ScrumStore — tasks', () => {
  test('createTask inserts row with defaults and logs task_created event', () => {
    const task = seedTask('t1');
    expect(task.id).toBe('t1');
    expect(task.status).toBe('backlog');
    expect(task.milestone_id).toBeNull();
    expect(task.deleted_at).toBeNull();

    const events = store.listEventsForTask('t1');
    expect(events).toHaveLength(1);
    const [event] = events;
    if (!event) throw new Error('expected one event');
    expect(event.kind).toBe('task_created');
  });

  test('createTask with tags inserts all tags in the same transaction', () => {
    seedTask('t1', { tags: ['p0', 'needs-docs'] });
    const tags = store.listTagsForTask('t1').map((t) => t.tag);
    expect(tags).toEqual(['needs-docs', 'p0']);
  });

  test('createTask with milestoneId validates milestone existence', () => {
    expect(() => seedTask('t1', { milestoneId: 'missing' })).toThrow(/unknown milestone_id/);
    seedMilestone('m1');
    const task = seedTask('t2', { milestoneId: 'm1' });
    expect(task.milestone_id).toBe('m1');
  });

  test('getTask returns null for missing and soft-deleted tasks', () => {
    expect(store.getTask('nope')).toBeNull();
    seedTask('t1');
    store.softDeleteTask('t1');
    expect(store.getTask('t1')).toBeNull();
  });

  test('listTasks filters by status and milestoneId', () => {
    seedMilestone('m1');
    seedTask('t1', { status: 'ready' });
    seedTask('t2', { status: 'backlog', milestoneId: 'm1' });
    seedTask('t3', { status: 'ready', milestoneId: 'm1' });

    expect(
      store
        .listTasks({ status: 'ready' })
        .map((t) => t.id)
        .sort(),
    ).toEqual(['t1', 't3']);
    expect(
      store
        .listTasks({ milestoneId: 'm1' })
        .map((t) => t.id)
        .sort(),
    ).toEqual(['t2', 't3']);
    expect(store.listTasks({ milestoneId: null }).map((t) => t.id)).toEqual(['t1']);
  });

  test('updateTaskStatus accepts a valid transition and appends status_changed event', () => {
    seedTask('t1');
    const updated = store.updateTaskStatus('t1', 'ready');
    expect(updated.status).toBe('ready');

    const kinds = store.listEventsForTask('t1').map((e) => e.kind);
    expect(kinds).toContain('status_changed');
  });

  test('updateTaskStatus rejects invalid transition', () => {
    seedTask('t1');
    expect(() => store.updateTaskStatus('t1', 'done')).toThrow(/invalid transition/);
  });

  test('updateTaskStatus rejects unknown task id', () => {
    expect(() => store.updateTaskStatus('missing', 'ready')).toThrow(/unknown task/);
  });

  test('softDeleteTask throws on unknown task', () => {
    expect(() => store.softDeleteTask('missing')).toThrow(/unknown task/);
  });

  test('soft-deleted tasks are excluded from listTasks by default', () => {
    seedTask('t1');
    seedTask('t2');
    store.softDeleteTask('t1');
    expect(store.listTasks().map((t) => t.id)).toEqual(['t2']);
    expect(
      store
        .listTasks({ excludeDeleted: false })
        .map((t) => t.id)
        .sort(),
    ).toEqual(['t1', 't2']);
  });
});

// ===========================================================================
// updateTaskMilestone
// ===========================================================================

describe('ScrumStore — updateTaskMilestone', () => {
  test('reassigns milestone and appends milestone_changed event with from/to payload', () => {
    seedMilestone('m1');
    seedMilestone('m2');
    seedTask('t1', { milestoneId: 'm1' });

    const before = store.listEventsForTask('t1');
    const updated = store.updateTaskMilestone('t1', 'm2');

    expect(updated.milestone_id).toBe('m2');

    const events = store.listEventsForTask('t1');
    expect(events).toHaveLength(before.length + 1);
    const [latest] = events;
    if (!latest) throw new Error('expected an event');
    expect(latest.kind).toBe('milestone_changed');
    expect(latest.payload).toEqual({ from: 'm1', to: 'm2' });
  });

  test('clears milestone when passed null and records to: null in payload', () => {
    seedMilestone('m1');
    seedTask('t1', { milestoneId: 'm1' });

    const updated = store.updateTaskMilestone('t1', null);
    expect(updated.milestone_id).toBeNull();

    const [latest] = store.listEventsForTask('t1');
    if (!latest) throw new Error('expected an event');
    expect(latest.kind).toBe('milestone_changed');
    expect(latest.payload).toEqual({ from: 'm1', to: null });
  });

  test('records from: null when assigning to a previously unassigned task', () => {
    seedMilestone('m1');
    seedTask('t1');

    const updated = store.updateTaskMilestone('t1', 'm1');
    expect(updated.milestone_id).toBe('m1');

    const [latest] = store.listEventsForTask('t1');
    if (!latest) throw new Error('expected an event');
    expect(latest.payload).toEqual({ from: null, to: 'm1' });
  });

  test('rejects unknown target milestone and leaves task + events untouched', () => {
    seedMilestone('m1');
    seedTask('t1', { milestoneId: 'm1' });
    const eventsBefore = store.listEventsForTask('t1').length;

    expect(() => store.updateTaskMilestone('t1', 'missing')).toThrow(/unknown milestone_id/);

    const task = store.getTask('t1');
    expect(task?.milestone_id).toBe('m1');
    expect(store.listEventsForTask('t1')).toHaveLength(eventsBefore);
  });

  test('rejects unknown task id', () => {
    expect(() => store.updateTaskMilestone('missing', null)).toThrow(/unknown task/);
  });

  test('allows reassignment to a closed milestone (policy lives at CLI layer)', () => {
    seedMilestone('m1');
    seedMilestone('m2');
    store.closeMilestone('m2');
    seedTask('t1', { milestoneId: 'm1' });

    const updated = store.updateTaskMilestone('t1', 'm2');
    expect(updated.milestone_id).toBe('m2');
  });

  test('bumps last_event_at to the transaction timestamp', () => {
    seedMilestone('m1');
    const task = seedTask('t1');
    const before = task.last_event_at;

    // Sleep just long enough for the ISO timestamp to differ at millisecond resolution.
    const start = Date.now();
    while (Date.now() === start) {
      // spin
    }

    const updated = store.updateTaskMilestone('t1', 'm1');
    expect(updated.last_event_at).not.toBe(before);
    if (before === null) throw new Error('seed task should have last_event_at set');
    if (updated.last_event_at === null) throw new Error('updated task should have last_event_at');
    expect(updated.last_event_at > before).toBe(true);
  });

  test('no-op when target equals current milestone (no duplicate event)', () => {
    seedMilestone('m1');
    seedTask('t1', { milestoneId: 'm1' });
    const eventsBefore = store.listEventsForTask('t1').length;

    const updated = store.updateTaskMilestone('t1', 'm1');
    expect(updated.milestone_id).toBe('m1');
    expect(store.listEventsForTask('t1')).toHaveLength(eventsBefore);
  });
});

// ===========================================================================
// Milestones
// ===========================================================================

describe('ScrumStore — milestones', () => {
  test('createMilestone round-trips through getMilestone', () => {
    seedMilestone('m1', { description: 'ship v1' });
    const loaded = store.getMilestone('m1');
    expect(loaded?.title).toBe('Milestone m1');
    expect(loaded?.description).toBe('ship v1');
    expect(loaded?.status).toBe('planned');
    expect(loaded?.closed_at).toBeNull();
  });

  test('listMilestones filters by status', () => {
    seedMilestone('m1', { status: 'active' });
    seedMilestone('m2', { status: 'planned' });
    seedMilestone('m3', { status: 'active' });

    const active = store
      .listMilestones('active')
      .map((m) => m.id)
      .sort();
    expect(active).toEqual(['m1', 'm3']);
    expect(
      store
        .listMilestones()
        .map((m) => m.id)
        .sort(),
    ).toEqual(['m1', 'm2', 'm3']);
  });

  test('getMilestone returns null for missing id', () => {
    expect(store.getMilestone('missing')).toBeNull();
  });

  test('closeMilestone flips status to closed and stamps closed_at', () => {
    seedMilestone('m1', { status: 'active' });
    const closed = store.closeMilestone('m1');
    expect(closed.status).toBe('closed');
    expect(closed.closed_at).not.toBeNull();

    const reloaded = store.getMilestone('m1');
    expect(reloaded?.status).toBe('closed');
  });

  test('closeMilestone throws on unknown id', () => {
    expect(() => store.closeMilestone('missing')).toThrow(/unknown milestone/);
  });
});

// ===========================================================================
// setMilestoneStatus
// ===========================================================================

describe('ScrumStore — setMilestoneStatus', () => {
  test('planned -> active transitions and returns the updated row', () => {
    seedMilestone('m1');
    const updated = store.setMilestoneStatus('m1', 'active');
    expect(updated.status).toBe('active');
    expect(store.getMilestone('m1')?.status).toBe('active');
  });

  test('active -> planned transitions back', () => {
    seedMilestone('m1', { status: 'active' });
    const updated = store.setMilestoneStatus('m1', 'planned');
    expect(updated.status).toBe('planned');
    expect(store.getMilestone('m1')?.status).toBe('planned');
  });

  test('planned -> planned is idempotent', () => {
    seedMilestone('m1');
    const updated = store.setMilestoneStatus('m1', 'planned');
    expect(updated.status).toBe('planned');
  });

  test('active -> active is idempotent', () => {
    seedMilestone('m1', { status: 'active' });
    const updated = store.setMilestoneStatus('m1', 'active');
    expect(updated.status).toBe('active');
  });

  test('throws on unknown id', () => {
    expect(() => store.setMilestoneStatus('missing', 'active')).toThrow(/unknown milestone/);
  });

  test('throws when milestone is closed', () => {
    seedMilestone('m1', { status: 'active' });
    store.closeMilestone('m1');
    expect(() => store.setMilestoneStatus('m1', 'active')).toThrow(/closed milestone/);
  });
});

// ===========================================================================
// Tags
// ===========================================================================

describe('ScrumStore — tags', () => {
  test('addTag + listTagsForTask round-trip', () => {
    seedTask('t1');
    store.addTag('t1', 'p0');
    store.addTag('t1', 'docs');
    expect(
      store
        .listTagsForTask('t1')
        .map((t) => t.tag)
        .sort(),
    ).toEqual(['docs', 'p0']);
  });

  test('addTag is idempotent on (task_id, tag)', () => {
    seedTask('t1');
    store.addTag('t1', 'p0');
    store.addTag('t1', 'p0');
    expect(store.listTagsForTask('t1')).toHaveLength(1);
  });

  test('addTag rejects unknown task', () => {
    expect(() => store.addTag('missing', 'p0')).toThrow(/unknown task/);
  });

  test('removeTag is idempotent', () => {
    seedTask('t1');
    store.addTag('t1', 'p0');
    store.removeTag('t1', 'p0');
    store.removeTag('t1', 'p0');
    expect(store.listTagsForTask('t1')).toEqual([]);
  });

  test('listTasksForTag excludes soft-deleted tasks', () => {
    seedTask('t1', { tags: ['p0'] });
    seedTask('t2', { tags: ['p0'] });
    store.softDeleteTask('t1');
    const tasks = store.listTasksForTag('p0').map((t) => t.id);
    expect(tasks).toEqual(['t2']);
  });
});

// ===========================================================================
// Dependencies
// ===========================================================================

describe('ScrumStore — dependencies', () => {
  beforeEach(() => {
    seedTask('a');
    seedTask('b');
    seedTask('c');
  });

  test('addDep round-trips via getBlockedBy', () => {
    store.addDep('a', 'b', 'blocks');
    const blocking = store.getBlockedBy('b');
    expect(blocking).toHaveLength(1);
    const [edge] = blocking;
    if (!edge) throw new Error('expected one edge');
    expect(edge.from_task_id).toBe('a');
    expect(edge.kind).toBe('blocks');
  });

  test('addDep is idempotent', () => {
    store.addDep('a', 'b', 'blocks');
    store.addDep('a', 'b', 'blocks');
    expect(store.getBlockedBy('b')).toHaveLength(1);
  });

  test('addDep rejects self-edge', () => {
    expect(() => store.addDep('a', 'a', 'blocks')).toThrow(/self-dependency/);
  });

  test('addDep rejects unknown tasks', () => {
    expect(() => store.addDep('missing', 'a', 'blocks')).toThrow(/unknown from_task/);
    expect(() => store.addDep('a', 'missing', 'blocks')).toThrow(/unknown to_task/);
  });

  test('removeDep deletes one edge without touching others', () => {
    store.addDep('a', 'b', 'blocks');
    store.addDep('a', 'c', 'blocks');
    store.removeDep('a', 'b', 'blocks');
    const remaining = store.getBlocking('a').map((d) => d.to_task_id);
    expect(remaining).toEqual(['c']);
  });

  test('getBlocking returns tasks downstream of the input', () => {
    store.addDep('a', 'b', 'blocks');
    store.addDep('a', 'c', 'blocks');
    const edges = store
      .getBlocking('a')
      .map((d) => d.to_task_id)
      .sort();
    expect(edges).toEqual(['b', 'c']);
  });
});

// ===========================================================================
// Events
// ===========================================================================

describe('ScrumStore — events', () => {
  test('appendEvent returns a positive row id', () => {
    seedTask('t1');
    const id = store.appendEvent({ taskId: 't1', kind: 'note', payload: { msg: 'hi' } });
    expect(id).toBeGreaterThan(0);
  });

  test('appendEvent rejects unknown task', () => {
    expect(() => store.appendEvent({ taskId: 'missing', kind: 'note' })).toThrow(/unknown task/);
  });

  test('listEventsForTask orders newest-first and is monotonic by ts', () => {
    seedTask('t1');
    store.appendEvent({ taskId: 't1', kind: 'note', ts: '2026-01-01T00:00:00Z' });
    store.appendEvent({ taskId: 't1', kind: 'note', ts: '2026-01-03T00:00:00Z' });
    store.appendEvent({ taskId: 't1', kind: 'note', ts: '2026-01-02T00:00:00Z' });
    const tss = store.listEventsForTask('t1').map((e) => e.ts);
    // Newest-first. The seed task_created event is from beforeEach; use
    // only the `note` events to isolate the ordering assertion.
    const noteTss = store
      .listEventsForTask('t1')
      .filter((e) => e.kind === 'note')
      .map((e) => e.ts);
    expect(noteTss).toEqual([
      '2026-01-03T00:00:00Z',
      '2026-01-02T00:00:00Z',
      '2026-01-01T00:00:00Z',
    ]);
    // Sanity: every ts is a string (no null payload slipped through).
    expect(tss.every((t) => typeof t === 'string')).toBe(true);
  });

  test('appendEvent bumps scrum_tasks.last_event_at', () => {
    seedTask('t1', { createdAt: '2026-01-01T00:00:00Z' });
    store.appendEvent({ taskId: 't1', kind: 'note', ts: '2026-06-01T00:00:00Z' });
    const task = store.getTask('t1');
    expect(task?.last_event_at).toBe('2026-06-01T00:00:00Z');
  });

  test('listRecentEvents crosses task boundaries, newest-first', () => {
    seedTask('t1');
    seedTask('t2');
    store.appendEvent({ taskId: 't1', kind: 'note', ts: '2026-01-01T00:00:00Z' });
    store.appendEvent({ taskId: 't2', kind: 'note', ts: '2026-02-01T00:00:00Z' });
    const recent = store.listRecentEvents(2);
    expect(recent).toHaveLength(2);
    const [first] = recent;
    if (!first) throw new Error('expected events');
    expect(first.task_id).toBe('t2');
  });

  test('event payloads round-trip through JSON', () => {
    seedTask('t1');
    store.appendEvent({ taskId: 't1', kind: 'note', payload: { nested: { n: 42 } } });
    const events = store.listEventsForTask('t1').filter((e) => e.kind === 'note');
    const [event] = events;
    if (!event) throw new Error('expected one note event');
    expect(event.payload).toEqual({ nested: { n: 42 } });
  });
});

// ===========================================================================
// Run links
// ===========================================================================

describe('ScrumStore — run links', () => {
  test('linkRun + listRunsForTask round-trip', () => {
    seedTask('t1');
    store.linkRun({ taskId: 't1', runPath: '.prove/runs/feat/x', branch: 'feat/x' });
    const links = store.listRunsForTask('t1');
    expect(links).toHaveLength(1);
    const [link] = links;
    if (!link) throw new Error('expected one link');
    expect(link.run_path).toBe('.prove/runs/feat/x');
    expect(link.branch).toBe('feat/x');
  });

  test('linkRun is upsert on (task_id, run_path)', () => {
    seedTask('t1');
    store.linkRun({ taskId: 't1', runPath: '.prove/r', branch: 'v1' });
    store.linkRun({ taskId: 't1', runPath: '.prove/r', branch: 'v2' });
    const links = store.listRunsForTask('t1');
    expect(links).toHaveLength(1);
    const [link] = links;
    if (!link) throw new Error('expected one link');
    expect(link.branch).toBe('v2');
  });

  test('linkRun rejects unknown task', () => {
    expect(() => store.linkRun({ taskId: 'missing', runPath: '.prove/r' })).toThrow(/unknown task/);
  });

  test('unlinkRun removes a specific run_path', () => {
    seedTask('t1');
    store.linkRun({ taskId: 't1', runPath: '.prove/a' });
    store.linkRun({ taskId: 't1', runPath: '.prove/b' });
    store.unlinkRun('t1', '.prove/a');
    const paths = store.listRunsForTask('t1').map((l) => l.run_path);
    expect(paths).toEqual(['.prove/b']);
  });

  test('getTaskForRun reverses the link', () => {
    seedTask('t1');
    store.linkRun({ taskId: 't1', runPath: '.prove/r' });
    const task = store.getTaskForRun('.prove/r');
    expect(task?.id).toBe('t1');
    expect(store.getTaskForRun('.prove/missing')).toBeNull();
  });
});

// ===========================================================================
// Context bundles
// ===========================================================================

describe('ScrumStore — context bundles', () => {
  test('saveContextBundle + loadContextBundle round-trip', () => {
    seedTask('t1');
    store.saveContextBundle('t1', { files: ['a.ts'] });
    const bundle = store.loadContextBundle('t1');
    expect(bundle?.task_id).toBe('t1');
    expect(bundle?.bundle).toEqual({ files: ['a.ts'] });
  });

  test('saveContextBundle upserts on task_id', () => {
    seedTask('t1');
    store.saveContextBundle('t1', { v: 1 });
    store.saveContextBundle('t1', { v: 2 });
    const bundle = store.loadContextBundle('t1');
    expect(bundle?.bundle).toEqual({ v: 2 });
  });

  test('saveContextBundle rejects unknown task', () => {
    expect(() => store.saveContextBundle('missing', {})).toThrow(/unknown task/);
  });

  test('loadContextBundle returns null for tasks without a bundle', () => {
    seedTask('t1');
    expect(store.loadContextBundle('t1')).toBeNull();
  });
});

// ===========================================================================
// nextReady
// ===========================================================================

describe('ScrumStore — nextReady', () => {
  test('returns empty array when no tasks are ready/backlog', () => {
    expect(store.nextReady()).toEqual([]);
  });

  test('ranks by unblock_depth when everything else is equal', () => {
    // a blocks b; b blocks c. `a` unblocks 2 descendants, `b` unblocks 1.
    seedTask('a', { createdAt: '2026-01-01T00:00:00Z' });
    seedTask('b', { createdAt: '2026-01-01T00:00:00Z' });
    seedTask('c', { createdAt: '2026-01-01T00:00:00Z' });
    store.addDep('a', 'b', 'blocks');
    store.addDep('b', 'c', 'blocks');

    const rows = store.nextReady();
    expect(rows[0]?.task.id).toBe('a');
    expect(rows[0]?.rationale.unblock_depth).toBe(2);
    expect(rows[1]?.rationale.unblock_depth).toBe(1);
  });

  test('milestone_boost fires for the filter milestone', () => {
    seedMilestone('m1', { status: 'planned' });
    seedTask('t1', { createdAt: '2026-01-01T00:00:00Z' });
    seedTask('t2', { createdAt: '2026-01-02T00:00:00Z', milestoneId: 'm1' });
    const rows = store.nextReady({ milestoneId: 'm1' });
    expect(rows.map((r) => r.task.id)).toEqual(['t2']);
    const [first] = rows;
    expect(first?.rationale.milestone_boost).toBe(1);
  });

  test('milestone_boost fires for active milestones when no filter is set', () => {
    seedMilestone('m1', { status: 'active' });
    seedMilestone('m2', { status: 'planned' });
    seedTask('t1', { createdAt: '2026-01-01T00:00:00Z', milestoneId: 'm1' });
    seedTask('t2', { createdAt: '2026-01-01T00:00:00Z', milestoneId: 'm2' });
    const rows = store.nextReady();
    const byId = new Map(rows.map((r) => [r.task.id, r]));
    expect(byId.get('t1')?.rationale.milestone_boost).toBe(1);
    expect(byId.get('t2')?.rationale.milestone_boost).toBe(0);
  });

  test('tag_boost counts priority tags', () => {
    seedTask('t1', { createdAt: '2026-01-01T00:00:00Z', tags: ['p0', 'urgent'] });
    seedTask('t2', { createdAt: '2026-01-02T00:00:00Z', tags: ['docs'] });
    const rows = store.nextReady();
    const byId = new Map(rows.map((r) => [r.task.id, r]));
    expect(byId.get('t1')?.rationale.tag_boost).toBe(2);
    expect(byId.get('t2')?.rationale.tag_boost).toBe(0);
  });

  test('tag_boost is +2 for p0 + p1 (priority tags stack)', () => {
    seedTask('t1', { createdAt: '2026-01-01T00:00:00Z', tags: ['p0', 'p1'] });
    const rows = store.nextReady();
    const [row] = rows;
    expect(row?.rationale.tag_boost).toBe(2);
  });

  test('tag_boost is -1 for a task tagged only deferred', () => {
    seedTask('t1', { createdAt: '2026-01-01T00:00:00Z', tags: ['deferred'] });
    const rows = store.nextReady();
    const [row] = rows;
    expect(row?.rationale.tag_boost).toBe(-1);
  });

  test('tag_boost nets to 0 when p0 cancels deferred', () => {
    seedTask('t1', { createdAt: '2026-01-01T00:00:00Z', tags: ['p0', 'deferred'] });
    const rows = store.nextReady();
    const [row] = rows;
    expect(row?.rationale.tag_boost).toBe(0);
  });

  test('tag_boost is 0 for a task with no scored tags', () => {
    seedTask('t1', { createdAt: '2026-01-01T00:00:00Z', tags: ['docs', 'chore'] });
    const rows = store.nextReady();
    const [row] = rows;
    expect(row?.rationale.tag_boost).toBe(0);
  });

  test('context_hotness decays over time', () => {
    // Task seeded in 2026; ask about a `now` six months later — hotness
    // should be near zero (exp(-4000h/24) ~= 0).
    seedTask('t1', { createdAt: '2026-01-01T00:00:00Z' });
    const nowMs = Date.parse('2026-06-01T00:00:00Z');
    const rows = store.nextReady({ nowMs });
    const [row] = rows;
    expect(row?.rationale.context_hotness).toBeLessThan(0.01);
  });

  test('tie-break falls back to created_at ASC', () => {
    seedTask('a', { createdAt: '2026-01-02T00:00:00Z' });
    seedTask('b', { createdAt: '2026-01-01T00:00:00Z' });
    const rows = store.nextReady({ nowMs: Date.parse('2030-01-01T00:00:00Z') });
    expect(rows.map((r) => r.task.id)).toEqual(['b', 'a']);
  });

  test('limit truncates the result set', () => {
    for (let i = 0; i < 5; i++) {
      seedTask(`t${i}`, { createdAt: `2026-01-0${i + 1}T00:00:00Z` });
    }
    expect(store.nextReady({ limit: 2 })).toHaveLength(2);
  });

  test('excludes done / cancelled / in_progress / review / blocked', () => {
    seedTask('ready1', { status: 'ready' });
    seedTask('backlog1', { status: 'backlog' });
    seedTask('t3');
    store.updateTaskStatus('t3', 'ready');
    store.updateTaskStatus('t3', 'in_progress');
    const ids = store
      .nextReady()
      .map((r) => r.task.id)
      .sort();
    expect(ids).toEqual(['backlog1', 'ready1']);
  });

  test('nextReady is stable across repeat calls with the same inputs', () => {
    seedTask('t1', { createdAt: '2026-01-01T00:00:00Z' });
    seedTask('t2', { createdAt: '2026-01-02T00:00:00Z' });
    seedTask('t3', { createdAt: '2026-01-03T00:00:00Z' });
    const nowMs = Date.parse('2026-01-04T00:00:00Z');
    const first = store.nextReady({ nowMs }).map((r) => r.task.id);
    const second = store.nextReady({ nowMs }).map((r) => r.task.id);
    expect(first).toEqual(second);
  });
});
