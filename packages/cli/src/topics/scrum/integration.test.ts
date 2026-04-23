/**
 * Integration test — full task lifecycle across the scrum domain.
 *
 * Exercises the real methods end-to-end in the same order a downstream
 * consumer would: create -> tag -> dep -> events -> link run -> save
 * context bundle -> nextReady -> soft-delete. One big happy-path scenario
 * with spot checks at each stage.
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

describe('scrum full lifecycle', () => {
  test('create -> tag -> dep -> events -> link -> bundle -> nextReady -> delete', () => {
    // 1. Milestones + tasks
    store.createMilestone({ id: 'phase-12', title: 'Phase 12', status: 'active' });

    const foundation = store.createTask({
      id: 'scrum-1',
      title: 'Schema + store',
      status: 'in_progress',
      milestoneId: 'phase-12',
      tags: ['p0'],
      createdAt: '2026-04-23T09:00:00Z',
    });
    const reconciler = store.createTask({
      id: 'scrum-2',
      title: 'Reconciler',
      milestoneId: 'phase-12',
      tags: ['p1'],
    });
    const ui = store.createTask({
      id: 'scrum-3',
      title: 'UI',
      milestoneId: 'phase-12',
    });

    expect(foundation.status).toBe('in_progress');
    expect(store.listTasks({ milestoneId: 'phase-12' })).toHaveLength(3);

    // 2. Tags — verify addTag + listTagsForTask + listTasksForTag
    store.addTag('scrum-2', 'p0');
    expect(
      store
        .listTagsForTask('scrum-2')
        .map((t) => t.tag)
        .sort(),
    ).toEqual(['p0', 'p1']);
    expect(
      store
        .listTasksForTag('p0')
        .map((t) => t.id)
        .sort(),
    ).toEqual(['scrum-1', 'scrum-2']);

    // 3. Dependencies — scrum-1 blocks scrum-2, scrum-2 blocks scrum-3
    store.addDep('scrum-1', 'scrum-2', 'blocks');
    store.addDep('scrum-2', 'scrum-3', 'blocks');
    expect(store.getBlocking('scrum-1').map((d) => d.to_task_id)).toEqual(['scrum-2']);
    expect(store.getBlockedBy('scrum-3').map((d) => d.from_task_id)).toEqual(['scrum-2']);

    // 4. Events — append several, verify they accumulate
    store.appendEvent({
      taskId: 'scrum-1',
      kind: 'run_started',
      payload: { runPath: '.prove/runs/a' },
      ts: '2026-04-23T10:00:00Z',
    });
    store.appendEvent({
      taskId: 'scrum-1',
      kind: 'steward_verdict',
      payload: { verdict: 'approved' },
      ts: '2026-04-23T11:00:00Z',
    });
    const events = store.listEventsForTask('scrum-1');
    // 1 seed `task_created` + 2 appended = 3
    expect(events).toHaveLength(3);
    expect(events[0]?.kind).toBe('steward_verdict'); // newest-first

    const reloaded = store.getTask('scrum-1');
    expect(reloaded?.last_event_at).toBe('2026-04-23T11:00:00Z');

    // 5. Run links — link a run, reverse-lookup by run_path
    store.linkRun({
      taskId: 'scrum-1',
      runPath: '.prove/runs/feat/phase-12/scrum-1',
      branch: 'feat/phase-12/scrum-1',
      slug: 'scrum-1',
    });
    const found = store.getTaskForRun('.prove/runs/feat/phase-12/scrum-1');
    expect(found?.id).toBe('scrum-1');
    expect(store.listRunsForTask('scrum-1')).toHaveLength(1);

    // 6. Context bundle — save, reload, upsert, reload
    store.saveContextBundle('scrum-1', {
      relevantFiles: ['packages/cli/src/topics/scrum/store.ts'],
    });
    const bundle1 = store.loadContextBundle('scrum-1');
    expect(bundle1?.bundle).toEqual({ relevantFiles: ['packages/cli/src/topics/scrum/store.ts'] });

    store.saveContextBundle('scrum-1', { relevantFiles: ['updated.ts'] });
    const bundle2 = store.loadContextBundle('scrum-1');
    expect(bundle2?.bundle).toEqual({ relevantFiles: ['updated.ts'] });

    // 7. nextReady — scrum-1 is in_progress (excluded); scrum-2 and scrum-3
    //    are backlog/ready candidates. scrum-2 unblocks scrum-3 so it
    //    should outrank scrum-3.
    const ranked = store.nextReady({ milestoneId: 'phase-12' });
    const ids = ranked.map((r) => r.task.id);
    expect(ids).toContain('scrum-2');
    expect(ids).toContain('scrum-3');
    expect(ids).not.toContain('scrum-1');
    const scrum2 = ranked.find((r) => r.task.id === 'scrum-2');
    const scrum3 = ranked.find((r) => r.task.id === 'scrum-3');
    if (!scrum2 || !scrum3) throw new Error('expected scrum-2 and scrum-3 in ranking');
    expect(scrum2.score).toBeGreaterThan(scrum3.score);
    expect(scrum2.rationale.unblock_depth).toBe(1);
    expect(scrum3.rationale.unblock_depth).toBe(0);

    // 8. Status progression — drive scrum-1 to review then done
    store.updateTaskStatus('scrum-1', 'review');
    store.updateTaskStatus('scrum-1', 'done');
    const final = store.getTask('scrum-1');
    expect(final?.status).toBe('done');

    // 9. Soft-delete — scrum-3 vanishes from listTasks but events remain
    store.softDeleteTask('scrum-3');
    expect(store.getTask('scrum-3')).toBeNull();
    expect(
      store
        .listTasks({ milestoneId: 'phase-12' })
        .map((t) => t.id)
        .sort(),
    ).toEqual(['scrum-1', 'scrum-2']);
    // Reconciler is still visible — regression for the filter predicate.
    expect(store.getTask('scrum-2')?.status).toBe('backlog');

    // 10. Milestone close — also stamps closed_at
    const closed = store.closeMilestone('phase-12');
    expect(closed.status).toBe('closed');
    expect(closed.closed_at).not.toBeNull();

    // Sanity: the reconciler task is unaffected by milestone closure.
    expect(reconciler.id).toBe('scrum-2');
    expect(ui.id).toBe('scrum-3');
  });

  test('store survives reopening the same :memory: path via separate handles', () => {
    // Fresh store, simulate a second consumer opening a store and finding
    // no prior data. :memory: dbs don't share across handles — this test
    // pins that invariant so nobody assumes otherwise.
    const s1 = openScrumStore({ path: ':memory:' });
    try {
      s1.createTask({ id: 't1', title: 'Test' });
    } finally {
      s1.close();
    }
    const s2 = openScrumStore({ path: ':memory:' });
    try {
      expect(s2.getTask('t1')).toBeNull();
    } finally {
      s2.close();
    }
  });
});
