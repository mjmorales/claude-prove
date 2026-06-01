/**
 * ScrumStore unit tests. Every method round-trips; error paths throw
 * domain-specific messages.
 *
 * Structural mirror of `packages/cli/src/topics/acb/store.test.ts`: one
 * `describe` block per method cluster, each spinning up a fresh
 * `:memory:` store via `openScrumStore({ path: ':memory:' })`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEntry } from '../acb/reasoning-log-store';
import { type ScrumStore, openScrumStore } from './store';
import type { Acceptance, AcceptanceCriterion, TaskBounds } from './types';

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

  test('createTask defaults parent_id and layer to null (flat task)', () => {
    const task = seedTask('t1');
    expect(task.parent_id).toBeNull();
    expect(task.layer).toBeNull();
    // Round-trips through SELECT, not just the in-memory return value.
    expect(store.getTask('t1')?.parent_id).toBeNull();
    expect(store.getTask('t1')?.layer).toBeNull();
  });

  test('createTask with parentId persists the edge and validates parent existence', () => {
    expect(() => seedTask('child', { parentId: 'missing' })).toThrow(/unknown parent_id/);
    seedTask('epic', { layer: 'epic' });
    const child = seedTask('story', { parentId: 'epic', layer: 'story' });
    expect(child.parent_id).toBe('epic');
    expect(child.layer).toBe('story');
    expect(store.getTask('story')?.parent_id).toBe('epic');
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

  test('softDeleteTask appends a task_deleted event recording the prior status', () => {
    seedTask('t1', { status: 'ready' });
    store.softDeleteTask('t1');

    // The task is gone from the live read path...
    expect(store.getTask('t1')).toBeNull();
    // ...but the deletion is on the append-only audit log.
    const events = store.listEventsForTask('t1');
    const deleted = events.find((e) => e.kind === 'task_deleted');
    if (!deleted) throw new Error('expected a task_deleted event');
    expect(deleted.payload).toEqual({ status: 'ready' });
  });

  test('getTaskIncludingDeleted returns a soft-deleted row that getTask hides', () => {
    seedTask('t1');
    store.softDeleteTask('t1');
    expect(store.getTask('t1')).toBeNull();
    expect(store.getTaskIncludingDeleted('t1')?.id).toBe('t1');
    expect(store.getTaskIncludingDeleted('never')).toBeNull();
  });

  test('undeleteTask revives a soft-deleted task', () => {
    seedTask('t1');
    store.softDeleteTask('t1');
    store.undeleteTask('t1');
    expect(store.getTask('t1')?.id).toBe('t1');
  });

  test('decodeTask degrades a corrupt acceptance_json column to null instead of throwing', () => {
    seedTask('t1');
    // Simulate a poisoned column (manual DB edit / aborted migration) by
    // writing invalid JSON through raw SQL, bypassing the store's write guards.
    store
      .getStore()
      .getDb()
      .prepare('UPDATE scrum_tasks SET acceptance_json = ? WHERE id = ?')
      .run('{not json', 't1');

    const task = store.getTask('t1');
    expect(task?.id).toBe('t1');
    expect(task?.acceptance).toBeNull();
  });

  test('transaction rolls back every write when the body throws', () => {
    expect(() =>
      store.transaction(() => {
        seedTask('t1');
        seedTask('t2');
        throw new Error('boom mid-sequence');
      }),
    ).toThrow(/boom mid-sequence/);

    // Both inserts rolled back — the store is untouched.
    expect(store.listTasks()).toHaveLength(0);
  });

  test('transaction commits and returns the body value on success', () => {
    const count = store.transaction(() => {
      seedTask('t1');
      seedTask('t2');
      return store.listTasks().length;
    });
    expect(count).toBe(2);
    expect(store.listTasks()).toHaveLength(2);
  });
});

// ===========================================================================
// Containment tree — getChildren + derivedStatus (v3)
// ===========================================================================

describe('ScrumStore — containment tree', () => {
  test('getChildren returns direct children ordered by created_at, excluding deleted', () => {
    seedTask('epic', { layer: 'epic' });
    seedTask('s1', { parentId: 'epic', layer: 'story', createdAt: '2026-01-01T00:00:00Z' });
    seedTask('s2', { parentId: 'epic', layer: 'story', createdAt: '2026-01-02T00:00:00Z' });
    seedTask('s3', { parentId: 'epic', layer: 'story', createdAt: '2026-01-03T00:00:00Z' });
    seedTask('grandchild', { parentId: 's1' }); // not a direct child of epic
    store.softDeleteTask('s3');

    expect(store.getChildren('epic').map((t) => t.id)).toEqual(['s1', 's2']);
    expect(store.getChildren('s1').map((t) => t.id)).toEqual(['grandchild']);
    expect(store.getChildren('grandchild')).toEqual([]);
  });

  test('derivedStatus of a childless task is its authored status (flat behavior unchanged)', () => {
    seedTask('flat', { status: 'review' });
    expect(store.derivedStatus('flat')).toBe('review');
  });

  test('derivedStatus throws on unknown task', () => {
    expect(() => store.derivedStatus('missing')).toThrow(/unknown task/);
  });

  test('derivedStatus rolls up in_progress when any descendant is in_progress', () => {
    // 3-layer epic -> story -> task. One leaf in_progress dominates everything.
    seedTask('epic', { layer: 'epic' });
    seedTask('story', { parentId: 'epic', layer: 'story' });
    seedTask('task-a', { parentId: 'story', layer: 'task', status: 'in_progress' });
    seedTask('task-b', { parentId: 'story', layer: 'task', status: 'done' });
    seedTask('task-c', { parentId: 'story', layer: 'task', status: 'blocked' });

    expect(store.derivedStatus('story')).toBe('in_progress');
    expect(store.derivedStatus('epic')).toBe('in_progress');
  });

  test('derivedStatus rolls up blocked when any child blocked and none in_progress', () => {
    seedTask('story', { layer: 'story' });
    seedTask('t1', { parentId: 'story', status: 'blocked' });
    seedTask('t2', { parentId: 'story', status: 'ready' });
    expect(store.derivedStatus('story')).toBe('blocked');
  });

  test('derivedStatus rolls up done only when every non-cancelled child is done', () => {
    seedTask('story', { layer: 'story' });
    seedTask('t1', { parentId: 'story', status: 'done' });
    seedTask('t2', { parentId: 'story', status: 'done' });
    expect(store.derivedStatus('story')).toBe('done');

    // One non-done child demotes the rollup below done.
    seedTask('t3', { parentId: 'story', status: 'ready' });
    expect(store.derivedStatus('story')).toBe('ready');
  });

  test('derivedStatus excludes cancelled children from the done quorum', () => {
    seedTask('story', { layer: 'story' });
    seedTask('t1', { parentId: 'story', status: 'done' });
    seedTask('t2', { parentId: 'story', status: 'cancelled' });
    // The only non-cancelled child is done -> rolls up done.
    expect(store.derivedStatus('story')).toBe('done');

    // An all-cancelled subtree has no quorum -> backlog, never done.
    seedTask('empty', { layer: 'story' });
    seedTask('c1', { parentId: 'empty', status: 'cancelled' });
    expect(store.derivedStatus('empty')).toBe('backlog');
  });

  test('derivedStatus precedence: review over ready, ready over backlog', () => {
    seedTask('review-story', { layer: 'story' });
    seedTask('r1', { parentId: 'review-story', status: 'review' });
    seedTask('r2', { parentId: 'review-story', status: 'ready' });
    seedTask('r3', { parentId: 'review-story', status: 'backlog' });
    expect(store.derivedStatus('review-story')).toBe('review');

    seedTask('ready-story', { layer: 'story' });
    seedTask('y1', { parentId: 'ready-story', status: 'ready' });
    seedTask('y2', { parentId: 'ready-story', status: 'backlog' });
    expect(store.derivedStatus('ready-story')).toBe('ready');
  });

  test('derivedStatus folds DERIVED (not authored) child statuses post-order', () => {
    // epic's only child `story` authored backlog, but story's leaf is in_progress.
    // The fold must use story's DERIVED status, not its stored backlog.
    seedTask('epic', { layer: 'epic', status: 'backlog' });
    seedTask('story', { parentId: 'epic', layer: 'story', status: 'backlog' });
    seedTask('leaf', { parentId: 'story', layer: 'task', status: 'in_progress' });
    expect(store.derivedStatus('story')).toBe('in_progress');
    expect(store.derivedStatus('epic')).toBe('in_progress');
  });

  test('derivedStatus survives a malformed parent_id cycle via the visited guard', () => {
    // Create two flat tasks, then force a cycle directly at the SQL layer
    // (createTask validates parent existence so it cannot build a cycle).
    seedTask('a', { status: 'review' });
    seedTask('b', { status: 'ready' });
    const db = store.getStore().getDb();
    db.prepare('UPDATE scrum_tasks SET parent_id = ? WHERE id = ?').run('b', 'a');
    db.prepare('UPDATE scrum_tasks SET parent_id = ? WHERE id = ?').run('a', 'b');

    // a's child is b; b's child is a (re-entered -> short-circuits to authored).
    // Must terminate rather than recurse forever; assertion is liveness.
    expect(() => store.derivedStatus('a')).not.toThrow();
    expect(typeof store.derivedStatus('a')).toBe('string');
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

  // Regression: issue #22 — `blocked_by` must persist as the inverse
  // `blocks` edge so getBlockedBy/getBlocking/nextReady observe it.
  test('addDep --kind blocked_by normalizes to the inverse blocks edge', () => {
    // "a blocked_by b" === "b blocks a"
    store.addDep('a', 'b', 'blocked_by');

    const blockedByA = store.getBlockedBy('a');
    expect(blockedByA).toHaveLength(1);
    const [edge] = blockedByA;
    if (!edge) throw new Error('expected one edge');
    expect(edge.from_task_id).toBe('b');
    expect(edge.to_task_id).toBe('a');
    expect(edge.kind).toBe('blocks');

    expect(store.getBlocking('b').map((d) => d.to_task_id)).toEqual(['a']);
  });

  test('addDep --kind blocked_by coincides with the equivalent blocks edge', () => {
    store.addDep('a', 'b', 'blocked_by');
    store.addDep('b', 'a', 'blocks');
    // Both express "b blocks a" — idempotent on the canonical PK.
    expect(store.getBlockedBy('a')).toHaveLength(1);
  });

  test('removeDep --kind blocked_by deletes the inverse blocks edge', () => {
    store.addDep('b', 'a', 'blocks');
    store.removeDep('a', 'b', 'blocked_by');
    expect(store.getBlockedBy('a')).toHaveLength(0);
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

  test('milestone_boost is 1.0 for active, 0.5 for planned when no filter is set', () => {
    seedMilestone('m1', { status: 'active' });
    seedMilestone('m2', { status: 'planned' });
    seedTask('t1', { createdAt: '2026-01-01T00:00:00Z', milestoneId: 'm1' });
    seedTask('t2', { createdAt: '2026-01-01T00:00:00Z', milestoneId: 'm2' });
    const rows = store.nextReady();
    const byId = new Map(rows.map((r) => [r.task.id, r]));
    expect(byId.get('t1')?.rationale.milestone_boost).toBe(1);
    expect(byId.get('t2')?.rationale.milestone_boost).toBe(0.5);
  });

  test('milestone_boost is 0.5 for a planned milestone, no filter set', () => {
    seedMilestone('m1', { status: 'planned' });
    seedTask('t1', { createdAt: '2026-01-01T00:00:00Z', milestoneId: 'm1' });
    const rows = store.nextReady();
    const [first] = rows;
    expect(first?.rationale.milestone_boost).toBe(0.5);
  });

  test('milestone_boost is 0 for a closed milestone', () => {
    seedMilestone('m1', { status: 'planned' });
    seedTask('t1', { createdAt: '2026-01-01T00:00:00Z', milestoneId: 'm1' });
    store.closeMilestone('m1');
    const rows = store.nextReady();
    const [first] = rows;
    expect(first?.rationale.milestone_boost).toBe(0);
  });

  test('activating a planned milestone re-queries to milestone_boost === 1.0', () => {
    seedMilestone('m1', { status: 'planned' });
    seedTask('t1', { createdAt: '2026-01-01T00:00:00Z', milestoneId: 'm1' });

    const before = store.nextReady();
    expect(before[0]?.rationale.milestone_boost).toBe(0.5);

    store.setMilestoneStatus('m1', 'active');

    const after = store.nextReady();
    expect(after[0]?.rationale.milestone_boost).toBe(1);
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

// ===========================================================================
// Acceptance criteria (v5, audit §5.2)
// ===========================================================================

function ac(id: string, overrides: Partial<AcceptanceCriterion> = {}): AcceptanceCriterion {
  return {
    id,
    text: `criterion ${id}`,
    verifies_by: 'bash',
    check: 'exit 0',
    status: 'active',
    idempotent: false,
    superseded_by: null,
    reason: null,
    inherited_from: null,
    ...overrides,
  };
}

describe('ScrumStore — acceptance criteria', () => {
  test('createTask without acceptance stores NULL acceptance', () => {
    const task = seedTask('t1');
    expect(task.acceptance).toBeNull();
    expect(store.getTask('t1')?.acceptance).toBeNull();
  });

  test('createTask with acceptance round-trips through acceptance_json', () => {
    const acceptance: Acceptance = { criteria: [ac('c1'), ac('c2')] };
    seedTask('t1', { acceptance });
    const reloaded = store.getTask('t1');
    expect(reloaded?.acceptance).toEqual(acceptance);
  });

  test('setAcceptance replaces the whole acceptance object; null clears it', () => {
    seedTask('t1', { acceptance: { criteria: [ac('c1')] } });
    const updated = store.setAcceptance('t1', { criteria: [ac('c2'), ac('c3')] });
    expect(updated.acceptance?.criteria.map((c) => c.id)).toEqual(['c2', 'c3']);
    const cleared = store.setAcceptance('t1', null);
    expect(cleared.acceptance).toBeNull();
  });

  test('addCriterion appends; creates the acceptance object on a bare task', () => {
    seedTask('t1');
    store.addCriterion('t1', ac('c1'));
    const task = store.addCriterion('t1', ac('c2'));
    expect(task.acceptance?.criteria.map((c) => c.id)).toEqual(['c1', 'c2']);
  });

  test('addCriterion rejects a duplicate criterion id', () => {
    seedTask('t1', { acceptance: { criteria: [ac('c1')] } });
    expect(() => store.addCriterion('t1', ac('c1'))).toThrow(/duplicate criterion id 'c1'/);
  });

  test('supersedeCriterion is append-only — flips status, retains the row', () => {
    seedTask('t1', { acceptance: { criteria: [ac('c1'), ac('c2')] } });
    const task = store.supersedeCriterion('t1', 'c1', 'no longer needed', 'c2');
    expect(task.acceptance?.criteria).toHaveLength(2);
    const c1 = task.acceptance?.criteria.find((c) => c.id === 'c1');
    expect(c1?.status).toBe('superseded');
    expect(c1?.reason).toBe('no longer needed');
    expect(c1?.superseded_by).toBe('c2');
    // The other criterion is untouched.
    expect(task.acceptance?.criteria.find((c) => c.id === 'c2')?.status).toBe('active');
  });

  test('supersedeCriterion rejects unknown criterion and double-supersede', () => {
    seedTask('t1', { acceptance: { criteria: [ac('c1')] } });
    expect(() => store.supersedeCriterion('t1', 'nope', 'r')).toThrow(/unknown criterion 'nope'/);
    store.supersedeCriterion('t1', 'c1', 'first');
    expect(() => store.supersedeCriterion('t1', 'c1', 'again')).toThrow(/already superseded/);
  });

  test('shared_acceptance inheritance copies active parent criteria with inherited_from', () => {
    seedTask('parent', {
      acceptance: { criteria: [ac('c1'), ac('c2', { status: 'superseded' })] },
    });
    const child = store.createTask({ id: 'child', title: 'Child', parentId: 'parent' });
    // Only the active criterion is inherited.
    expect(child.acceptance?.criteria).toHaveLength(1);
    const inherited = child.acceptance?.criteria[0];
    expect(inherited?.id).toBe('c1');
    expect(inherited?.inherited_from).toBe('parent');
    expect(inherited?.status).toBe('active');
  });

  test('inherited copies are independent of later parent edits', () => {
    seedTask('parent', { acceptance: { criteria: [ac('c1')] } });
    store.createTask({ id: 'child', title: 'Child', parentId: 'parent' });
    // Mutate the parent after the child inherited.
    store.supersedeCriterion('parent', 'c1', 'parent moved on');
    const childCriterion = store.getTask('child')?.acceptance?.criteria[0];
    expect(childCriterion?.status).toBe('active');
    expect(childCriterion?.reason).toBeNull();
  });

  test('explicit child acceptance wins over parent inheritance', () => {
    seedTask('parent', { acceptance: { criteria: [ac('p1')] } });
    const child = store.createTask({
      id: 'child',
      title: 'Child',
      parentId: 'parent',
      acceptance: { criteria: [ac('own')] },
    });
    expect(child.acceptance?.criteria.map((c) => c.id)).toEqual(['own']);
  });

  test('policy validation rejects parallel/failed_only with a non-idempotent criterion', () => {
    const bad: Acceptance = {
      criteria: [ac('c1', { idempotent: false })],
      policy: { eval_order: 'parallel', rerun_policy: 'all' },
    };
    expect(() => store.createTask({ id: 't1', title: 'T1', acceptance: bad })).toThrow(
      /requires every criterion to be idempotent/,
    );
    // Same invariant on the in-place setter.
    seedTask('t2');
    expect(() => store.setAcceptance('t2', bad)).toThrow(
      /requires every criterion to be idempotent/,
    );
  });

  test('policy validation accepts parallel/failed_only when every criterion is idempotent', () => {
    const ok: Acceptance = {
      criteria: [ac('c1', { idempotent: true }), ac('c2', { idempotent: true })],
      policy: { eval_order: 'parallel', rerun_policy: 'failed_only' },
    };
    const task = store.createTask({ id: 't1', title: 'T1', acceptance: ok });
    expect(task.acceptance?.policy?.eval_order).toBe('parallel');
  });

  test('fifo/all policy passes regardless of idempotence', () => {
    const seq: Acceptance = {
      criteria: [ac('c1', { idempotent: false })],
      policy: { eval_order: 'fifo', rerun_policy: 'all' },
    };
    expect(() => store.createTask({ id: 't1', title: 'T1', acceptance: seq })).not.toThrow();
  });
});

// ===========================================================================
// Declared bounds (v6, declared-bounds decision §2)
// ===========================================================================

describe('ScrumStore — declared bounds', () => {
  const fullBounds: TaskBounds = {
    read: ['src/auth/**'],
    write: ['src/auth/**'],
    tools: { allow: ['Bash(go test *)'], deny: ['Bash(git push *)'] },
    budgets: { tokens: 200000, tool_calls: 100, wall_clock_s: 1800 },
  };

  test('createTask without bounds stores NULL bounds', () => {
    const task = seedTask('t1');
    expect(task.bounds).toBeNull();
    expect(store.getTask('t1')?.bounds).toBeNull();
  });

  test('createTask with bounds round-trips through bounds_json', () => {
    seedTask('t1', { bounds: fullBounds });
    expect(store.getTask('t1')?.bounds).toEqual(fullBounds);
  });

  test('createTask accepts a partial bounds object (all sub-fields optional)', () => {
    const partial: TaskBounds = { tools: { deny: ['Bash(rm *)'] } };
    seedTask('t1', { bounds: partial });
    expect(store.getTask('t1')?.bounds).toEqual(partial);
  });

  test('setBounds replaces the whole bounds object; null clears it', () => {
    seedTask('t1', { bounds: { read: ['a/**'] } });
    const updated = store.setBounds('t1', fullBounds);
    expect(updated.bounds).toEqual(fullBounds);
    const cleared = store.setBounds('t1', null);
    expect(cleared.bounds).toBeNull();
  });

  test('setBounds rejects an unknown task id', () => {
    expect(() => store.setBounds('nope', fullBounds)).toThrow(/unknown task 'nope'/);
  });

  test('createTask rejects bounds with an unknown top-level key', () => {
    const bad = { reads: ['oops'] } as unknown as TaskBounds;
    expect(() => store.createTask({ id: 't1', title: 'T1', bounds: bad })).toThrow(
      /unknown top-level key/,
    );
  });

  test('setBounds rejects bounds with an unknown top-level key', () => {
    seedTask('t1');
    const bad = { budget: { tokens: 1 } } as unknown as TaskBounds;
    expect(() => store.setBounds('t1', bad)).toThrow(/unknown top-level key/);
  });

  test('bounds are never inherited from a parent (unlike acceptance)', () => {
    seedTask('parent', { bounds: fullBounds });
    const child = store.createTask({ id: 'child', title: 'Child', parentId: 'parent' });
    expect(child.bounds).toBeNull();
  });
});

// ===========================================================================
// Cancellation + terminal provenance (v7, onleash §14.4–14.6)
// ===========================================================================

describe('ScrumStore — cancelTask + cancelTaskCascade', () => {
  test('cancelTask sets status cancelled with default terminal_reason and an event', () => {
    seedTask('t1');
    const task = store.cancelTask('t1');
    expect(task.status).toBe('cancelled');
    expect(task.terminal_reason).toBe('cancelled');
    expect(task.terminal_detail).toBeNull();
    const [event] = store.listEventsForTask('t1');
    expect(event?.kind).toBe('status_changed');
    expect((event?.payload as { terminal_reason?: string }).terminal_reason).toBe('cancelled');
  });

  test('cancelTask records a custom reason + detail', () => {
    seedTask('t1');
    const task = store.cancelTask('t1', { reason: 'descoped', detail: 'cut from v1' });
    expect(task.terminal_reason).toBe('descoped');
    expect(task.terminal_detail).toBe('cut from v1');
  });

  test('cancelTask rejects an unknown id and an already-terminal task', () => {
    expect(() => store.cancelTask('missing')).toThrow(/unknown task 'missing'/);
    seedTask('t1', { status: 'done' });
    expect(() => store.cancelTask('t1')).toThrow(/already terminal \('done'\)/);
  });

  test('cancelTaskCascade cancels the whole non-terminal subtree with provenance', () => {
    seedTask('epic', { layer: 'epic' });
    seedTask('story', { parentId: 'epic', layer: 'story' });
    seedTask('leaf-a', { parentId: 'story', layer: 'task' });
    seedTask('leaf-b', { parentId: 'story', layer: 'task' });

    const result = store.cancelTaskCascade('epic', { reason: 'pivot' });
    expect(result.cancelled.sort()).toEqual(['epic', 'leaf-a', 'leaf-b', 'story']);

    expect(store.getTask('epic')?.terminal_reason).toBe('pivot');
    const story = store.getTask('story');
    expect(story?.status).toBe('cancelled');
    expect(story?.terminal_reason).toBe('parent_cancelled');
    expect(story?.terminal_detail).toContain("parent 'epic' cancelled");
    expect(store.getTask('leaf-a')?.terminal_reason).toBe('parent_cancelled');
  });

  test('cascade leaves already-terminal nodes untouched but still sweeps their children', () => {
    seedTask('epic', { layer: 'epic' });
    seedTask('done-story', { parentId: 'epic', layer: 'story', status: 'done' });
    seedTask('grandchild', { parentId: 'done-story', layer: 'task' });

    const result = store.cancelTaskCascade('epic');
    // The done story is skipped; root + its unfinished grandchild are cancelled.
    expect(result.cancelled.sort()).toEqual(['epic', 'grandchild']);
    expect(store.getTask('done-story')?.status).toBe('done');
    expect(store.getTask('grandchild')?.status).toBe('cancelled');
  });

  test('cancelTaskCascade rejects an unknown root', () => {
    expect(() => store.cancelTaskCascade('missing')).toThrow(/unknown task 'missing'/);
  });
});

// ===========================================================================
// Acceptance freeze guard (v7, onleash §14.13)
// ===========================================================================

describe('ScrumStore — acceptance freeze guard', () => {
  test('addCriterion rejects while the task is in_progress', () => {
    seedTask('t1', { status: 'in_progress' });
    expect(() => store.addCriterion('t1', ac('c1'))).toThrow(
      /frozen while task 't1' is in_progress/,
    );
  });

  test('supersedeCriterion rejects while the task is in_progress', () => {
    seedTask('t1', { acceptance: { criteria: [ac('c1')] }, status: 'in_progress' });
    expect(() => store.supersedeCriterion('t1', 'c1', 'r')).toThrow(/frozen while task 't1'/);
  });

  test('criteria are amendable in non-in_progress statuses', () => {
    seedTask('t1', { status: 'ready' });
    expect(() => store.addCriterion('t1', ac('c1'))).not.toThrow();
    store.updateTaskStatus('t1', 'blocked');
    expect(() => store.addCriterion('t1', ac('c2'))).not.toThrow();
  });
});

// ===========================================================================
// Story-layer transition floors (v7, onleash §9.1 + §10.4/§3.3)
// ===========================================================================

describe('ScrumStore — story acceptance floor (≥1 active criterion)', () => {
  test('story with no criteria cannot transition to ready / in_progress / done', () => {
    seedTask('s', { layer: 'story' });
    expect(() => store.updateTaskStatus('s', 'ready')).toThrow(/no active acceptance criteria/);
    expect(() => store.updateTaskStatus('s', 'in_progress')).toThrow(
      /no active acceptance criteria/,
    );
  });

  test('story with all-superseded criteria is still blocked (only active count)', () => {
    seedTask('s', { layer: 'story', acceptance: { criteria: [ac('c1')] } });
    store.supersedeCriterion('s', 'c1', 'retired');
    expect(() => store.updateTaskStatus('s', 'ready')).toThrow(/no active acceptance criteria/);
  });

  test('story with ≥1 active criterion passes the floor', () => {
    seedTask('s', { layer: 'story', acceptance: { criteria: [ac('c1')] } });
    expect(() => store.updateTaskStatus('s', 'ready')).not.toThrow();
    expect(store.getTask('s')?.status).toBe('ready');
  });

  test('story may be cancelled / blocked without criteria (floor only gates forward edges)', () => {
    seedTask('s', { layer: 'story' });
    expect(() => store.updateTaskStatus('s', 'cancelled')).not.toThrow();
  });

  test('non-story layers are exempt from the acceptance floor', () => {
    seedTask('t', { layer: 'task' });
    seedTask('flat'); // layer null
    expect(() => store.updateTaskStatus('t', 'in_progress')).not.toThrow();
    expect(() => store.updateTaskStatus('flat', 'in_progress')).not.toThrow();
  });
});

describe('ScrumStore — story synthesis floor', () => {
  let runDir: string;

  beforeEach(() => {
    runDir = mkdtempSync(join(tmpdir(), 'scrum-synth-'));
  });
  afterEach(() => {
    rmSync(runDir, { recursive: true, force: true });
  });

  function seedStartedStory(id: string) {
    // Story with an active criterion (clears the acceptance floor) already
    // in_progress so the only remaining gate for `done` is the synthesis floor.
    seedTask(id, {
      layer: 'story',
      status: 'in_progress',
      acceptance: { criteria: [ac('c1')] },
    });
  }

  function writeSynthesis(dir: string, agent = 'worker') {
    appendEntry(dir, {
      id: `synth-${agent}`,
      ts: '2026-06-01T00:00:00Z',
      type: 'synthesis',
      agent,
      run_path: dir,
      body: 'episode wrapped',
      outcome: 'shipped',
    });
  }

  test('story with no linked run is exempt (no worker engaged)', () => {
    seedStartedStory('s');
    expect(() => store.updateTaskStatus('s', 'done')).not.toThrow();
  });

  test('story with a linked run but no synthesis entry is blocked', () => {
    seedStartedStory('s');
    store.linkRun({ taskId: 's', runPath: runDir });
    expect(() => store.updateTaskStatus('s', 'done')).toThrow(/no synthesis reasoning-log entry/);
  });

  test('story passes once its most-recent run carries a synthesis entry', () => {
    seedStartedStory('s');
    writeSynthesis(runDir);
    store.linkRun({ taskId: 's', runPath: runDir });
    expect(() => store.updateTaskStatus('s', 'done')).not.toThrow();
    expect(store.getTask('s')?.status).toBe('done');
  });

  test('only the most-recent linked run is consulted', () => {
    const olderRun = mkdtempSync(join(tmpdir(), 'scrum-synth-old-'));
    try {
      seedStartedStory('s');
      writeSynthesis(olderRun); // synthesis on the OLD run only
      store.linkRun({ taskId: 's', runPath: olderRun, linkedAt: '2026-01-01T00:00:00Z' });
      store.linkRun({ taskId: 's', runPath: runDir, linkedAt: '2026-02-01T00:00:00Z' });
      // The newest run (runDir) has no synthesis → blocked.
      expect(() => store.updateTaskStatus('s', 'done')).toThrow(/no synthesis/);
    } finally {
      rmSync(olderRun, { recursive: true, force: true });
    }
  });
});
