/**
 * reconcile.ts unit tests.
 *
 * Covers:
 *   - happy path: plan.json has task_id -> run_completed event, status
 *     transition on completed runs, context bundle rebuild, run link.
 *   - orphan path: plan.json lacks task_id -> unlinked_run_detected event
 *     under the `__orphan__` sentinel task.
 *   - buildContextBundle: aggregates files, decisions, run summaries.
 *   - sweepUnreconciled: idempotence via mtime cursor; errors collected.
 *
 * Tests use an in-memory scrum store per `openScrumStore({ path: ':memory:' })`
 * and write run fixtures under a fresh tmpdir. Several tests chdir into
 * the tmpdir so `reconcileRunCompleted`'s relative-path computation lines
 * up with the standard `.prove/runs/<branch>/<slug>` layout.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ORPHAN_TASK_ID,
  buildContextBundle,
  reconcileRunCompleted,
  sweepUnreconciled,
} from './reconcile';
import { type ScrumStore, openScrumStore } from './store';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let store: ScrumStore;
let project: string;
let prevCwd: string;

beforeEach(() => {
  store = openScrumStore({ path: ':memory:' });
  project = mkdtempSync(join(tmpdir(), 'scrum-reconcile-'));
  prevCwd = process.cwd();
  process.chdir(project);
});

afterEach(() => {
  process.chdir(prevCwd);
  store.close();
  rmSync(project, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

interface RunFixtureOptions {
  branch?: string;
  slug?: string;
  taskId?: string | null;
  runStatus?: string;
  stewardVerdict?: string;
  commitShas?: string[];
}

function writeRun(opts: RunFixtureOptions = {}): string {
  const branch = opts.branch ?? 'feature';
  const slug = opts.slug ?? 'demo';
  const runDir = join(project, '.prove', 'runs', branch, slug);
  mkdirSync(runDir, { recursive: true });

  const plan: Record<string, unknown> = {
    schema_version: '5',
    kind: 'plan',
    mode: 'full',
    tasks: [{ id: '1', title: 'step', steps: [] }],
  };
  if (opts.taskId !== null && opts.taskId !== undefined) {
    plan.task_id = opts.taskId;
  }
  writeFileSync(join(runDir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);

  const steps = (opts.commitShas ?? ['abc123']).map((sha, i) => ({
    id: `1.${i + 1}`,
    status: 'completed',
    started_at: '2026-04-23T10:00:00Z',
    ended_at: '2026-04-23T11:00:00Z',
    commit_sha: sha,
    validator_summary: {
      build: 'pass',
      lint: 'pass',
      test: 'pass',
      custom: 'skipped',
      llm: 'skipped',
    },
    halt_reason: '',
  }));
  const state: Record<string, unknown> = {
    schema_version: '5',
    kind: 'state',
    run_status: opts.runStatus ?? 'completed',
    slug,
    branch,
    current_task: '1',
    current_step: '',
    started_at: '2026-04-23T09:00:00Z',
    updated_at: '2026-04-23T12:00:00Z',
    ended_at: '2026-04-23T12:00:00Z',
    tasks: [
      {
        id: '1',
        status: 'completed',
        started_at: '2026-04-23T10:00:00Z',
        ended_at: '2026-04-23T12:00:00Z',
        review: { verdict: 'pending', notes: '', reviewer: '', reviewed_at: '' },
        steps,
      },
    ],
    dispatch: { dispatched: [] },
  };
  if (opts.stewardVerdict) state.steward_verdict = opts.stewardVerdict;
  writeFileSync(join(runDir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);

  return join(runDir, 'state.json');
}

// ===========================================================================
// reconcileRunCompleted — happy path
// ===========================================================================

describe('reconcileRunCompleted — tracked run', () => {
  test('appends run_completed event and links run to task', () => {
    store.createTask({ id: 'scrum-10', title: 'Demo task' });
    const statePath = writeRun({ taskId: 'scrum-10' });

    const result = reconcileRunCompleted(statePath, store);
    expect(result.kind).toBe('reconciled');
    expect(result.taskId).toBe('scrum-10');

    const events = store.listEventsForTask('scrum-10');
    const kinds = events.map((e) => e.kind);
    // newest-first: status_changed (from done transition) + run_completed + task_created
    expect(kinds).toContain('run_completed');

    const runs = store.listRunsForTask('scrum-10');
    expect(runs).toHaveLength(1);
    expect(runs[0]?.branch).toBe('feature');
    expect(runs[0]?.slug).toBe('demo');
  });

  test('transitions task to done when run_status === completed', () => {
    store.createTask({ id: 'scrum-11', title: 'Demo', status: 'in_progress' });
    const statePath = writeRun({ taskId: 'scrum-11', runStatus: 'completed' });

    reconcileRunCompleted(statePath, store);
    expect(store.getTask('scrum-11')?.status).toBe('done');
  });

  test('does NOT transition task on halted or failed runs', () => {
    store.createTask({ id: 'scrum-12', title: 'Demo', status: 'in_progress' });
    const statePath = writeRun({ taskId: 'scrum-12', runStatus: 'halted' });

    reconcileRunCompleted(statePath, store);
    expect(store.getTask('scrum-12')?.status).toBe('in_progress');
  });

  test('appends steward_verdict event when present in state.json', () => {
    store.createTask({ id: 'scrum-13', title: 'Demo' });
    const statePath = writeRun({ taskId: 'scrum-13', stewardVerdict: 'approved' });

    reconcileRunCompleted(statePath, store);
    const events = store.listEventsForTask('scrum-13');
    expect(events.some((e) => e.kind === 'steward_verdict')).toBe(true);
  });

  test('rebuilds context bundle after reconcile', () => {
    store.createTask({ id: 'scrum-14', title: 'Demo' });
    const statePath = writeRun({ taskId: 'scrum-14', commitShas: ['sha-a', 'sha-b'] });

    reconcileRunCompleted(statePath, store);
    const bundle = store.loadContextBundle('scrum-14');
    expect(bundle).not.toBeNull();
    const payload = bundle?.bundle as { files: string[]; runs: unknown[] };
    expect(payload.files).toContain('commit:sha-a');
    expect(payload.files).toContain('commit:sha-b');
    expect(payload.runs).toHaveLength(1);
  });
});

// ===========================================================================
// reconcileRunCompleted — orphan path
// ===========================================================================

describe('reconcileRunCompleted — orphan run', () => {
  test('emits unlinked_run_detected under sentinel when task_id missing', () => {
    const statePath = writeRun({ taskId: null });

    const result = reconcileRunCompleted(statePath, store);
    expect(result.kind).toBe('orphan');
    expect(result.taskId).toBeNull();

    const sentinel = store.getTask(ORPHAN_TASK_ID);
    expect(sentinel).not.toBeNull();
    expect(sentinel?.title).toBe('Unlinked run detections');

    const events = store.listEventsForTask(ORPHAN_TASK_ID);
    expect(events.some((e) => e.kind === 'unlinked_run_detected')).toBe(true);
  });

  test('emits orphan event when plan.json references a missing task_id', () => {
    const statePath = writeRun({ taskId: 'does-not-exist' });

    const result = reconcileRunCompleted(statePath, store);
    expect(result.kind).toBe('orphan');
    expect(result.taskId).toBe('does-not-exist');
    expect(
      store.listEventsForTask(ORPHAN_TASK_ID).some((e) => e.kind === 'unlinked_run_detected'),
    ).toBe(true);
  });

  test('returns skipped on malformed state.json without throwing', () => {
    const runDir = join(project, '.prove', 'runs', 'feat-bad', 'run-1');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'state.json'), '{ not json');
    const result = reconcileRunCompleted(join(runDir, 'state.json'), store);
    expect(result.kind).toBe('skipped');
  });

  test('reuses existing orphan sentinel task across multiple calls', () => {
    const s1 = writeRun({ branch: 'feat-a', slug: 'one', taskId: null });
    const s2 = writeRun({ branch: 'feat-b', slug: 'two', taskId: null });

    reconcileRunCompleted(s1, store);
    reconcileRunCompleted(s2, store);

    const events = store.listEventsForTask(ORPHAN_TASK_ID);
    const orphanEvents = events.filter((e) => e.kind === 'unlinked_run_detected');
    expect(orphanEvents).toHaveLength(2);
  });
});

// ===========================================================================
// buildContextBundle
// ===========================================================================

describe('buildContextBundle', () => {
  test('aggregates decisions from decision_linked events (legacy {path, title} payload)', () => {
    store.createTask({ id: 'scrum-20', title: 'Demo' });
    store.appendEvent({
      taskId: 'scrum-20',
      kind: 'decision_linked',
      payload: { path: '.prove/decisions/x.md', title: 'Use SQLite' },
    });
    store.appendEvent({
      taskId: 'scrum-20',
      kind: 'decision_linked',
      payload: { path: '.prove/decisions/y.md', title: 'Use Bun' },
    });

    const bundle = buildContextBundle('scrum-20', store);
    expect(bundle.decisions).toHaveLength(2);
    expect(bundle.decisions.map((d) => d.title).sort()).toEqual(['Use Bun', 'Use SQLite']);
  });

  test('aggregates decisions from new-shape payload {decision_id, decision_path}', () => {
    store.createTask({ id: 'scrum-20b', title: 'Demo' });
    // Seed a scrum_decisions row so the title can be looked up by id.
    store.recordDecision({
      id: '2026-04-24-adr',
      title: 'Adopt ACB',
      content: '# Adopt ACB\n',
    });
    store.appendEvent({
      taskId: 'scrum-20b',
      kind: 'decision_linked',
      payload: {
        decision_id: '2026-04-24-adr',
        decision_path: '.prove/decisions/2026-04-24-adr.md',
      },
    });

    const bundle = buildContextBundle('scrum-20b', store);
    expect(bundle.decisions).toHaveLength(1);
    expect(bundle.decisions[0]?.path).toBe('.prove/decisions/2026-04-24-adr.md');
    expect(bundle.decisions[0]?.title).toBe('Adopt ACB');
  });

  test('mixed fixture: legacy and new-shape payloads coexist on one task', () => {
    store.createTask({ id: 'scrum-20c', title: 'Demo' });
    store.recordDecision({
      id: '2026-04-24-mixed',
      title: 'Mixed decision',
      content: '# Mixed decision\n',
    });
    // Legacy payload.
    store.appendEvent({
      taskId: 'scrum-20c',
      kind: 'decision_linked',
      payload: { path: '.prove/decisions/legacy.md', title: 'Legacy title' },
    });
    // New-shape payload.
    store.appendEvent({
      taskId: 'scrum-20c',
      kind: 'decision_linked',
      payload: {
        decision_id: '2026-04-24-mixed',
        decision_path: '.prove/decisions/2026-04-24-mixed.md',
      },
    });

    const bundle = buildContextBundle('scrum-20c', store);
    expect(bundle.decisions).toHaveLength(2);
    const paths = bundle.decisions.map((d) => d.path).sort();
    expect(paths).toEqual(['.prove/decisions/2026-04-24-mixed.md', '.prove/decisions/legacy.md']);
    const titles = bundle.decisions.map((d) => d.title).sort();
    expect(titles).toEqual(['Legacy title', 'Mixed decision']);
  });

  test('caps run summaries at 5 (last-5 most recent)', () => {
    store.createTask({ id: 'scrum-21', title: 'Demo' });
    for (let i = 0; i < 7; i++) {
      store.linkRun({
        taskId: 'scrum-21',
        runPath: `.prove/runs/feat/x/run-${i}`,
        branch: 'feat/x',
        slug: `run-${i}`,
        linkedAt: `2026-04-${String(10 + i).padStart(2, '0')}T00:00:00Z`,
      });
    }
    const bundle = buildContextBundle('scrum-21', store);
    expect(bundle.runs).toHaveLength(5);
  });

  test('summary_text concatenates recent event titles', () => {
    store.createTask({ id: 'scrum-22', title: 'Demo' });
    store.appendEvent({ taskId: 'scrum-22', kind: 'note', payload: { text: 'a' } });
    store.appendEvent({ taskId: 'scrum-22', kind: 'note', payload: { text: 'b' } });

    const bundle = buildContextBundle('scrum-22', store);
    expect(bundle.summary_text).toContain('note');
    expect(bundle.summary_text.split('\n').length).toBeGreaterThanOrEqual(2);
  });

  test('returns empty arrays for a task with no events or runs', () => {
    store.createTask({ id: 'scrum-23', title: 'Demo' });
    const bundle = buildContextBundle('scrum-23', store);
    expect(bundle.decisions).toEqual([]);
    expect(bundle.runs).toEqual([]);
    expect(bundle.files).toEqual([]);
  });
});

// ===========================================================================
// sweepUnreconciled
// ===========================================================================

describe('sweepUnreconciled', () => {
  test('scans runs and reconciles each one', () => {
    store.createTask({ id: 'scrum-30', title: 'A' });
    store.createTask({ id: 'scrum-31', title: 'B' });
    writeRun({ branch: 'feat-a', slug: 'one', taskId: 'scrum-30' });
    writeRun({ branch: 'feat-b', slug: 'two', taskId: 'scrum-31' });

    const result = sweepUnreconciled(store, 0);
    expect(result.scanned).toBe(2);
    expect(result.reconciled).toBe(2);
    expect(result.errors).toHaveLength(0);
  });

  test('is idempotent when called with a cursor newer than every mtime', () => {
    store.createTask({ id: 'scrum-32', title: 'A' });
    writeRun({ branch: 'feat-a', slug: 'one', taskId: 'scrum-32' });

    // First sweep processes it.
    const r1 = sweepUnreconciled(store, 0);
    expect(r1.reconciled).toBe(1);

    // Second sweep with cursor in the future sees 0 reconciles.
    const future = Date.now() + 60_000;
    const r2 = sweepUnreconciled(store, future);
    expect(r2.scanned).toBe(1);
    expect(r2.reconciled).toBe(0);
  });

  test('skips state.json files with mtime below the cursor', () => {
    store.createTask({ id: 'scrum-33', title: 'A' });
    const statePath = writeRun({ branch: 'feat-c', slug: 'old', taskId: 'scrum-33' });

    // Backdate the file by 1 hour.
    const oldMs = Date.now() - 3600_000;
    const asSec = oldMs / 1000;
    utimesSync(statePath, asSec, asSec);

    // Cursor is "now" — file is older, must be skipped.
    const result = sweepUnreconciled(store, Date.now());
    expect(result.scanned).toBe(1);
    expect(result.reconciled).toBe(0);
  });

  test('returns empty result when .prove/runs is absent', () => {
    const result = sweepUnreconciled(store, 0);
    expect(result).toEqual({ scanned: 0, reconciled: 0, errors: [] });
  });
});
