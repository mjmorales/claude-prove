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
import { appendEntry } from '../acb/reasoning-log-store';
import {
  type CollisionLike,
  type CurationProposedPayload,
  ORPHAN_TASK_ID,
  type SurfacedAnomaly,
  type TriggerBinding,
  bubbleStaleEscalations,
  buildContextBundle,
  computeBoundActions,
  detectContributionMiss,
  detectMergeAnomalies,
  isRunOrphan,
  parseTeamAgentName,
  reconcileMilestoneClosed,
  reconcileRunCompleted,
  sweepUnreconciled,
  triggerBindingsForStatus,
} from './reconcile';
import { type ScrumStore, openScrumStore } from './store';
import { STALENESS_THRESHOLD_HOURS } from './types';

/** Narrow an optional value to its defined type, throwing when absent. */
function req<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('req: expected a defined value');
  return value;
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let store: ScrumStore;
let project: string;
let prevCwd: string;

beforeEach(async () => {
  store = await openScrumStore({ path: ':memory:' });
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
  /** When set, writes the scrum id nested at tasks[0].task_id instead of top-level. */
  nestedTaskId?: string;
  runStatus?: string;
  stewardVerdict?: string;
  commitShas?: string[];
}

function writeRun(opts: RunFixtureOptions = {}): string {
  const branch = opts.branch ?? 'feature';
  const slug = opts.slug ?? 'demo';
  const runDir = join(project, '.prove', 'runs', branch, slug);
  mkdirSync(runDir, { recursive: true });

  const planTask: Record<string, unknown> = { id: '1', title: 'step', steps: [] };
  if (opts.nestedTaskId !== undefined) planTask.task_id = opts.nestedTaskId;
  const plan: Record<string, unknown> = {
    schema_version: '5',
    kind: 'plan',
    mode: 'full',
    tasks: [planTask],
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
  test('appends run_completed event and links run to task', async () => {
    await store.createTask({ id: 'scrum-10', title: 'Demo task' });
    const statePath = writeRun({ taskId: 'scrum-10' });

    const result = await reconcileRunCompleted(statePath, store);
    expect(result.kind).toBe('reconciled');
    expect(result.taskId).toBe('scrum-10');

    const events = await store.listEventsForTask('scrum-10');
    const kinds = events.map((e) => e.kind);
    // newest-first: status_changed (from done transition) + run_completed + task_created
    expect(kinds).toContain('run_completed');

    const runs = await store.listRunsForTask('scrum-10');
    expect(runs).toHaveLength(1);
    expect(runs[0]?.branch).toBe('feature');
    expect(runs[0]?.slug).toBe('demo');
  });

  test('transitions task to done when run_status === completed', async () => {
    await store.createTask({ id: 'scrum-11', title: 'Demo', status: 'in_progress' });
    const statePath = writeRun({ taskId: 'scrum-11', runStatus: 'completed' });

    await reconcileRunCompleted(statePath, store);
    expect((await store.getTask('scrum-11'))?.status).toBe('done');
  });

  test('does NOT transition task on halted or failed runs', async () => {
    await store.createTask({ id: 'scrum-12', title: 'Demo', status: 'in_progress' });
    const statePath = writeRun({ taskId: 'scrum-12', runStatus: 'halted' });

    await reconcileRunCompleted(statePath, store);
    expect((await store.getTask('scrum-12'))?.status).toBe('in_progress');
  });

  test('appends steward_verdict event when present in state.json', async () => {
    await store.createTask({ id: 'scrum-13', title: 'Demo' });
    const statePath = writeRun({ taskId: 'scrum-13', stewardVerdict: 'approved' });

    await reconcileRunCompleted(statePath, store);
    const events = await store.listEventsForTask('scrum-13');
    expect(events.some((e) => e.kind === 'steward_verdict')).toBe(true);
  });

  test('rebuilds context bundle after reconcile', async () => {
    await store.createTask({ id: 'scrum-14', title: 'Demo' });
    const statePath = writeRun({ taskId: 'scrum-14', commitShas: ['sha-a', 'sha-b'] });

    await reconcileRunCompleted(statePath, store);
    const bundle = await store.loadContextBundle('scrum-14');
    expect(bundle).not.toBeNull();
    const payload = bundle?.bundle as { files: string[]; runs: unknown[] };
    expect(payload.files).toContain('commit:sha-a');
    expect(payload.files).toContain('commit:sha-b');
    expect(payload.runs).toHaveLength(1);
  });
});

// ===========================================================================
// reconcileRunCompleted — projectRoot anchoring (cwd != projectRoot)
// ===========================================================================

describe('reconcileRunCompleted — run_path is anchored on projectRoot, not cwd', () => {
  test('stores a projectRoot-relative run_path that round-trips when cwd differs', async () => {
    // A linked worktree / subdirectory invocation: cwd is the harness `project`,
    // but the run lives under a DIFFERENT projectRoot. The stored run_path must
    // be relative to projectRoot (so the read path resolves it correctly), never
    // to cwd.
    const altRoot = mkdtempSync(join(tmpdir(), 'scrum-altroot-'));
    try {
      const branch = 'feature-anchor';
      const slug = 'demo';
      const runDir = join(altRoot, '.prove', 'runs', branch, slug);
      mkdirSync(runDir, { recursive: true });

      const plan = {
        schema_version: '5',
        kind: 'plan',
        mode: 'full',
        task_id: 'anchor-1',
        tasks: [{ id: '1', title: 'step', steps: [] }],
      };
      writeFileSync(join(runDir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);

      const state = {
        schema_version: '5',
        kind: 'state',
        run_status: 'completed',
        slug,
        branch,
        current_task: '1',
        current_step: '',
        started_at: '2026-04-23T09:00:00Z',
        updated_at: '2026-04-23T12:00:00Z',
        ended_at: '2026-04-23T12:00:00Z',
        tasks: [],
        dispatch: { dispatched: [] },
      };
      const statePath = join(runDir, 'state.json');
      writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);

      await store.createTask({ id: 'anchor-1', title: 'Anchor task' });

      // cwd is the harness `project` (set in beforeEach), distinct from altRoot.
      expect(process.cwd()).not.toBe(altRoot);
      const result = await reconcileRunCompleted(statePath, store, altRoot);
      expect(result.kind).toBe('reconciled');

      // Stored path is projectRoot-relative — NOT an absolute path and NOT a
      // `../`-laden traversal that a cwd anchor would have produced.
      const expectedRel = join('.prove', 'runs', branch, slug);
      const runs = await store.listRunsForTask('anchor-1');
      expect(runs).toHaveLength(1);
      expect(runs[0]?.run_path).toBe(expectedRel);

      // The run_completed event payload carries the same anchored path.
      const events = await store.listEventsForTask('anchor-1');
      const completed = events.find((e) => e.kind === 'run_completed');
      expect((completed?.payload as Record<string, unknown>)?.run_path).toBe(expectedRel);

      // Round-trip: the reverse lookup keyed on the stored path resolves back to
      // the task, and join(projectRoot, run_path) reaches the run dir on disk.
      expect((await store.getTaskForRun(expectedRel))?.id).toBe('anchor-1');
      expect(join(altRoot, expectedRel)).toBe(runDir);
    } finally {
      rmSync(altRoot, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// reconcileRunCompleted — orphan path
// ===========================================================================

describe('reconcileRunCompleted — orphan run', () => {
  test('emits unlinked_run_detected under sentinel when task_id missing', async () => {
    const statePath = writeRun({ taskId: null });

    const result = await reconcileRunCompleted(statePath, store);
    expect(result.kind).toBe('orphan');
    expect(result.taskId).toBeNull();

    const sentinel = await store.getTask(ORPHAN_TASK_ID);
    expect(sentinel).not.toBeNull();
    expect(sentinel?.title).toBe('Unlinked run detections');

    const events = await store.listEventsForTask(ORPHAN_TASK_ID);
    expect(events.some((e) => e.kind === 'unlinked_run_detected')).toBe(true);
  });

  test('emits orphan event when plan.json references a missing task_id', async () => {
    const statePath = writeRun({ taskId: 'does-not-exist' });

    const result = await reconcileRunCompleted(statePath, store);
    expect(result.kind).toBe('orphan');
    expect(result.taskId).toBe('does-not-exist');
    expect(
      (await store.listEventsForTask(ORPHAN_TASK_ID)).some(
        (e) => e.kind === 'unlinked_run_detected',
      ),
    ).toBe(true);
  });

  test('returns skipped on malformed state.json without throwing', async () => {
    const runDir = join(project, '.prove', 'runs', 'feat-bad', 'run-1');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'state.json'), '{ not json');
    const result = await reconcileRunCompleted(join(runDir, 'state.json'), store);
    expect(result.kind).toBe('skipped');
  });

  test('reuses existing orphan sentinel task across multiple calls', async () => {
    const s1 = writeRun({ branch: 'feat-a', slug: 'one', taskId: null });
    const s2 = writeRun({ branch: 'feat-b', slug: 'two', taskId: null });

    await reconcileRunCompleted(s1, store);
    await reconcileRunCompleted(s2, store);

    const events = await store.listEventsForTask(ORPHAN_TASK_ID);
    const orphanEvents = events.filter((e) => e.kind === 'unlinked_run_detected');
    expect(orphanEvents).toHaveLength(2);
  });

  test('revives a soft-deleted orphan sentinel instead of hitting a PK conflict', async () => {
    // First orphan run creates the sentinel; an operator then soft-deletes it.
    await reconcileRunCompleted(writeRun({ branch: 'feat-a', slug: 'one', taskId: null }), store);
    await store.softDeleteTask(ORPHAN_TASK_ID);
    expect(await store.getTask(ORPHAN_TASK_ID)).toBeNull();

    // A later orphan run must revive the sentinel, not throw a UNIQUE conflict.
    const result = await reconcileRunCompleted(
      writeRun({ branch: 'feat-b', slug: 'two', taskId: null }),
      store,
    );
    expect(result.kind).toBe('orphan');
    expect(await store.getTask(ORPHAN_TASK_ID)).not.toBeNull();
    expect(
      (await store.listEventsForTask(ORPHAN_TASK_ID)).some(
        (e) => e.kind === 'unlinked_run_detected',
      ),
    ).toBe(true);
  });
});

// ===========================================================================
// unlinked_run_detected dedup — repeated sweeps over an unchanged orphan
// ===========================================================================

describe('reconcileRunCompleted — unlinked_run_detected dedup', () => {
  test('repeated reconcile calls for the same orphan run emit exactly one event', async () => {
    const statePath = writeRun({ branch: 'feat', slug: 'orphan-once', taskId: null });

    await reconcileRunCompleted(statePath, store);
    await reconcileRunCompleted(statePath, store);
    await reconcileRunCompleted(statePath, store);

    const events = await store.listEventsForTask(ORPHAN_TASK_ID, 1000);
    const orphanEvents = events.filter((e) => e.kind === 'unlinked_run_detected');
    expect(orphanEvents).toHaveLength(1);
  });

  test('two distinct orphan runs each emit exactly one event (dedup is per run_path)', async () => {
    const s1 = writeRun({ branch: 'feat-a', slug: 'dup-one', taskId: null });
    const s2 = writeRun({ branch: 'feat-b', slug: 'dup-two', taskId: null });

    // Two sweeps over both runs.
    await reconcileRunCompleted(s1, store);
    await reconcileRunCompleted(s2, store);
    await reconcileRunCompleted(s1, store);
    await reconcileRunCompleted(s2, store);

    const events = await store.listEventsForTask(ORPHAN_TASK_ID, 1000);
    const orphanEvents = events.filter((e) => e.kind === 'unlinked_run_detected');
    expect(orphanEvents).toHaveLength(2);
  });

  test('sweepUnreconciled repeated over an unchanged orphan emits one event total', async () => {
    writeRun({ branch: 'feat', slug: 'sweep-orphan', taskId: null });

    await sweepUnreconciled(store, 0);
    await sweepUnreconciled(store, 0);
    await sweepUnreconciled(store, 0);

    const events = await store.listEventsForTask(ORPHAN_TASK_ID, 1000);
    const orphanEvents = events.filter((e) => e.kind === 'unlinked_run_detected');
    expect(orphanEvents).toHaveLength(1);
  });

  test('dedup is not window-bounded — suppresses after >1000 prior orphan events', async () => {
    // After first reconcile the target event is in the store.
    const statePath = writeRun({ branch: 'feat', slug: 'many-orphans', taskId: null });
    await reconcileRunCompleted(statePath, store);

    // Push 1001 noise events for unrelated paths so the old scan-based
    // listEventsForTask(…, 1000) window would push the target off the bottom.
    for (let i = 0; i < 1001; i++) {
      await store.appendEvent({
        taskId: ORPHAN_TASK_ID,
        kind: 'unlinked_run_detected',
        payload: { run_path: `noise/runs/branch/slug-${i}`, reason: 'plan.json missing task_id' },
      });
    }

    // The targeted SQL query must still suppress the second emit.
    await reconcileRunCompleted(statePath, store);

    // Exactly one event for the target run_path regardless of ordering.
    const targetPath = '.prove/runs/feat/many-orphans';
    expect(await store.hasOrphanEventForRunPath(targetPath, 'plan.json missing task_id')).toBe(
      true,
    );
    const events = (await store.listEventsForTask(ORPHAN_TASK_ID, 2000)).filter(
      (e) =>
        e.kind === 'unlinked_run_detected' &&
        (e.payload as Record<string, unknown>)?.run_path === targetPath,
    );
    expect(events).toHaveLength(1);
  });

  test('same run path with a different reason emits a second event', async () => {
    // First reconcile: default reason 'plan.json missing task_id'.
    const statePath = writeRun({ branch: 'feat', slug: 'two-reasons', taskId: null });
    await reconcileRunCompleted(statePath, store);

    const runPath = '.prove/runs/feat/two-reasons';
    const secondReason = "task 'some-id' not found in scrum store";

    // Directly append a second orphan event for the same path but a different reason,
    // matching the second callsite in reconcileRunCompleted.
    await store.appendEvent({
      taskId: ORPHAN_TASK_ID,
      kind: 'unlinked_run_detected',
      payload: {
        run_path: runPath,
        run_status: 'completed',
        branch: 'feat',
        slug: 'two-reasons',
        reason: secondReason,
      },
    });

    // Both (run_path, reason) pairs must be present.
    expect(await store.hasOrphanEventForRunPath(runPath, 'plan.json missing task_id')).toBe(true);
    expect(await store.hasOrphanEventForRunPath(runPath, secondReason)).toBe(true);

    const events = (await store.listEventsForTask(ORPHAN_TASK_ID, 1000)).filter(
      (e) => e.kind === 'unlinked_run_detected',
    );
    expect(events).toHaveLength(2);
  });

  test('same run path same reason is still suppressed on repeat reconcile', async () => {
    const statePath = writeRun({ branch: 'feat', slug: 'same-reason', taskId: null });

    await reconcileRunCompleted(statePath, store);
    await reconcileRunCompleted(statePath, store);

    const events = (await store.listEventsForTask(ORPHAN_TASK_ID, 1000)).filter(
      (e) => e.kind === 'unlinked_run_detected',
    );
    expect(events).toHaveLength(1);
  });
});

// ===========================================================================
// isRunOrphan — shared orphan predicate (gh#33)
// ===========================================================================

describe('isRunOrphan', () => {
  test('returns true when no layer knows the link', async () => {
    const statePath = writeRun({ branch: 'feat', slug: 'truly-orphan', taskId: null });
    const runDir = statePath.replace('/state.json', '');
    expect(await isRunOrphan(runDir, store)).toBe(true);
  });

  test('returns false when plan.task_id is set and the task exists', async () => {
    await store.createTask({ id: 'scrum-iso-1', title: 'Linked' });
    const statePath = writeRun({ branch: 'feat', slug: 'iso-linked', taskId: 'scrum-iso-1' });
    const runDir = statePath.replace('/state.json', '');
    expect(await isRunOrphan(runDir, store)).toBe(false);
  });

  test('returns false when nested tasks[n].task_id provides the link', async () => {
    await store.createTask({ id: 'scrum-iso-2', title: 'Nested link' });
    const statePath = writeRun({
      branch: 'feat',
      slug: 'iso-nested',
      taskId: null,
      nestedTaskId: 'scrum-iso-2',
    });
    const runDir = statePath.replace('/state.json', '');
    expect(await isRunOrphan(runDir, store)).toBe(false);
  });

  test('returns false when store run-link resolves the run (no plan.task_id)', async () => {
    await store.createTask({ id: 'scrum-iso-3', title: 'Store-linked' });
    const statePath = writeRun({ branch: 'feat', slug: 'iso-store', taskId: null });
    const runDir = statePath.replace('/state.json', '');
    await store.linkRun({
      taskId: 'scrum-iso-3',
      runPath: join('.prove', 'runs', 'feat', 'iso-store'),
    });
    expect(await isRunOrphan(runDir, store)).toBe(false);
  });
});

// ===========================================================================
// reconcileRunCompleted — link resolution layers (gh#32 orphan split-brain)
// ===========================================================================

describe('reconcileRunCompleted — link resolution beyond top-level plan.task_id', () => {
  test('store run-link is authoritative when plan.json carries no task_id', async () => {
    // The split-brain case: a run linked in the store (e.g. via `scrum
    // link-run`) whose plan.json was never updated must reconcile instead of
    // re-emitting unlinked_run_detected on every sweep.
    await store.createTask({ id: 'scrum-40', title: 'Store-linked' });
    const statePath = writeRun({ branch: 'feat', slug: 'linked', taskId: null });
    await store.linkRun({ taskId: 'scrum-40', runPath: join('.prove', 'runs', 'feat', 'linked') });

    const result = await reconcileRunCompleted(statePath, store);
    expect(result.kind).toBe('reconciled');
    expect(result.taskId).toBe('scrum-40');

    // No orphan event was emitted under the sentinel.
    const sentinel = await store.getTask(ORPHAN_TASK_ID);
    if (sentinel) {
      expect(
        (await store.listEventsForTask(ORPHAN_TASK_ID)).some(
          (e) => e.kind === 'unlinked_run_detected',
        ),
      ).toBe(false);
    }
    expect(
      (await store.listEventsForTask('scrum-40')).some((e) => e.kind === 'run_completed'),
    ).toBe(true);
  });

  test('a store-linked run sweeps clean — no unlinked_run_detected on repeated sweeps', async () => {
    await store.createTask({ id: 'scrum-41', title: 'Swept' });
    writeRun({ branch: 'feat', slug: 'swept', taskId: null });
    await store.linkRun({ taskId: 'scrum-41', runPath: join('.prove', 'runs', 'feat', 'swept') });

    const r1 = await sweepUnreconciled(store, 0);
    expect(r1.reconciled).toBe(1);
    expect(r1.errors).toHaveLength(0);

    const orphanEvents = (await store.listEventsForTask(ORPHAN_TASK_ID)).filter(
      (e) => e.kind === 'unlinked_run_detected',
    );
    expect(orphanEvents).toHaveLength(0);
  });

  test('nested tasks[n].task_id is recognized as the link', async () => {
    await store.createTask({ id: 'scrum-42', title: 'Nested' });
    const statePath = writeRun({
      branch: 'feat',
      slug: 'nested',
      taskId: null,
      nestedTaskId: 'scrum-42',
    });

    const result = await reconcileRunCompleted(statePath, store);
    expect(result.kind).toBe('reconciled');
    expect(result.taskId).toBe('scrum-42');
  });

  test('top-level plan.task_id wins over a store link to a different task', async () => {
    await store.createTask({ id: 'scrum-43', title: 'Plan-side' });
    await store.createTask({ id: 'scrum-44', title: 'Store-side' });
    const statePath = writeRun({ branch: 'feat', slug: 'precedence', taskId: 'scrum-43' });
    await store.linkRun({
      taskId: 'scrum-44',
      runPath: join('.prove', 'runs', 'feat', 'precedence'),
    });

    const result = await reconcileRunCompleted(statePath, store);
    expect(result.taskId).toBe('scrum-43');
  });

  test('still orphans when no layer knows the link', async () => {
    const statePath = writeRun({ branch: 'feat', slug: 'truly-orphan', taskId: null });
    const result = await reconcileRunCompleted(statePath, store);
    expect(result.kind).toBe('orphan');
  });
});

// ===========================================================================
// buildContextBundle
// ===========================================================================

describe('buildContextBundle', () => {
  test('aggregates decisions from decision_linked events (legacy {path, title} payload)', async () => {
    await store.createTask({ id: 'scrum-20', title: 'Demo' });
    await store.appendEvent({
      taskId: 'scrum-20',
      kind: 'decision_linked',
      payload: { path: '.prove/decisions/x.md', title: 'Use SQLite' },
    });
    await store.appendEvent({
      taskId: 'scrum-20',
      kind: 'decision_linked',
      payload: { path: '.prove/decisions/y.md', title: 'Use Bun' },
    });

    const bundle = await buildContextBundle('scrum-20', store);
    expect(bundle.decisions).toHaveLength(2);
    expect(bundle.decisions.map((d) => d.title).sort()).toEqual(['Use Bun', 'Use SQLite']);
  });

  test('aggregates decisions from new-shape payload {decision_id, decision_path}', async () => {
    await store.createTask({ id: 'scrum-20b', title: 'Demo' });
    // Seed a scrum_decisions row so the title can be looked up by id.
    await store.recordDecision({
      id: '2026-04-24-adr',
      title: 'Adopt ACB',
      content: '# Adopt ACB\n',
    });
    await store.appendEvent({
      taskId: 'scrum-20b',
      kind: 'decision_linked',
      payload: {
        decision_id: '2026-04-24-adr',
        decision_path: '.prove/decisions/2026-04-24-adr.md',
      },
    });

    const bundle = await buildContextBundle('scrum-20b', store);
    expect(bundle.decisions).toHaveLength(1);
    expect(bundle.decisions[0]?.path).toBe('.prove/decisions/2026-04-24-adr.md');
    expect(bundle.decisions[0]?.title).toBe('Adopt ACB');
  });

  test('mixed fixture: legacy and new-shape payloads coexist on one task', async () => {
    await store.createTask({ id: 'scrum-20c', title: 'Demo' });
    await store.recordDecision({
      id: '2026-04-24-mixed',
      title: 'Mixed decision',
      content: '# Mixed decision\n',
    });
    // Legacy payload.
    await store.appendEvent({
      taskId: 'scrum-20c',
      kind: 'decision_linked',
      payload: { path: '.prove/decisions/legacy.md', title: 'Legacy title' },
    });
    // New-shape payload.
    await store.appendEvent({
      taskId: 'scrum-20c',
      kind: 'decision_linked',
      payload: {
        decision_id: '2026-04-24-mixed',
        decision_path: '.prove/decisions/2026-04-24-mixed.md',
      },
    });

    const bundle = await buildContextBundle('scrum-20c', store);
    expect(bundle.decisions).toHaveLength(2);
    const paths = bundle.decisions.map((d) => d.path).sort();
    expect(paths).toEqual(['.prove/decisions/2026-04-24-mixed.md', '.prove/decisions/legacy.md']);
    const titles = bundle.decisions.map((d) => d.title).sort();
    expect(titles).toEqual(['Legacy title', 'Mixed decision']);
  });

  test('caps run summaries at 5 (last-5 most recent)', async () => {
    await store.createTask({ id: 'scrum-21', title: 'Demo' });
    for (let i = 0; i < 7; i++) {
      await store.linkRun({
        taskId: 'scrum-21',
        runPath: `.prove/runs/feat/x/run-${i}`,
        branch: 'feat/x',
        slug: `run-${i}`,
        linkedAt: `2026-04-${String(10 + i).padStart(2, '0')}T00:00:00Z`,
      });
    }
    const bundle = await buildContextBundle('scrum-21', store);
    expect(bundle.runs).toHaveLength(5);
  });

  test('summary_text concatenates recent event titles', async () => {
    await store.createTask({ id: 'scrum-22', title: 'Demo' });
    await store.appendEvent({ taskId: 'scrum-22', kind: 'note', payload: { text: 'a' } });
    await store.appendEvent({ taskId: 'scrum-22', kind: 'note', payload: { text: 'b' } });

    const bundle = await buildContextBundle('scrum-22', store);
    expect(bundle.summary_text).toContain('note');
    expect(bundle.summary_text.split('\n').length).toBeGreaterThanOrEqual(2);
  });

  test('returns empty arrays for a task with no events or runs', async () => {
    await store.createTask({ id: 'scrum-23', title: 'Demo' });
    const bundle = await buildContextBundle('scrum-23', store);
    expect(bundle.decisions).toEqual([]);
    expect(bundle.runs).toEqual([]);
    expect(bundle.files).toEqual([]);
  });
});

// ===========================================================================
// sweepUnreconciled
// ===========================================================================

describe('sweepUnreconciled', () => {
  test('scans runs and reconciles each one', async () => {
    await store.createTask({ id: 'scrum-30', title: 'A' });
    await store.createTask({ id: 'scrum-31', title: 'B' });
    writeRun({ branch: 'feat-a', slug: 'one', taskId: 'scrum-30' });
    writeRun({ branch: 'feat-b', slug: 'two', taskId: 'scrum-31' });

    const result = await sweepUnreconciled(store, 0);
    expect(result.scanned).toBe(2);
    expect(result.reconciled).toBe(2);
    expect(result.errors).toHaveLength(0);
  });

  test('is idempotent when called with a cursor newer than every mtime', async () => {
    await store.createTask({ id: 'scrum-32', title: 'A' });
    writeRun({ branch: 'feat-a', slug: 'one', taskId: 'scrum-32' });

    // First sweep processes it.
    const r1 = await sweepUnreconciled(store, 0);
    expect(r1.reconciled).toBe(1);

    // Second sweep with cursor in the future sees 0 reconciles.
    const future = Date.now() + 60_000;
    const r2 = await sweepUnreconciled(store, future);
    expect(r2.scanned).toBe(1);
    expect(r2.reconciled).toBe(0);
  });

  test('skips state.json files with mtime below the cursor', async () => {
    await store.createTask({ id: 'scrum-33', title: 'A' });
    const statePath = writeRun({ branch: 'feat-c', slug: 'old', taskId: 'scrum-33' });

    // Backdate the file by 1 hour.
    const oldMs = Date.now() - 3600_000;
    const asSec = oldMs / 1000;
    utimesSync(statePath, asSec, asSec);

    // Cursor is "now" — file is older, must be skipped.
    const result = await sweepUnreconciled(store, Date.now());
    expect(result.scanned).toBe(1);
    expect(result.reconciled).toBe(0);
  });

  test('returns empty result when .prove/runs is absent', async () => {
    const result = await sweepUnreconciled(store, 0);
    expect(result).toEqual({ scanned: 0, reconciled: 0, errors: [] });
  });
});

// ===========================================================================
// reconcileMilestoneClosed — curation candidate bubble-up
// ===========================================================================

// Per-type required fields beyond the envelope (mirrors reasoning-log.ts).
const TYPE_EXTRA: Record<string, Record<string, unknown>> = {
  decision: { alternatives: ['a', 'b'], selected_rationale: 'a won' },
  hack: { file_refs: ['x.ts'], cleanup_condition: 'when stable' },
  risk: { severity: 'high', mitigation: 'monitor it' },
  assumption: { resolved: false, resolution_ref: null },
  bailout: { attempted: 'x', reason_abandoned: 'y' },
  synthesis: { outcome: 'shipped' },
  discovery: {},
  context: {},
  review_feedback: {},
  verification: {},
};

/** Write a valid reasoning-log entry of `type` under `runDir`. */
function writeLogEntry(runDir: string, id: string, type: string, agent = 'engineer'): void {
  appendEntry(runDir, {
    id,
    ts: `2026-06-01T10:00:00Z#${id}`,
    type,
    agent,
    run_path: runDir,
    body: `${type} body for ${id}`,
    ...TYPE_EXTRA[type],
  });
}

/** Link `taskId` to a run dir under `project` and return the absolute run dir. */
async function linkRunDir(taskId: string, slug: string, branch = 'feat'): Promise<string> {
  const runRel = join('.prove', 'runs', branch, slug);
  await store.linkRun({ taskId, runPath: runRel, branch, slug });
  return join(project, runRel);
}

/** The decoded payload of the single curation_proposed event on `taskId`. */
async function curationPayload(taskId: string): Promise<CurationProposedPayload | null> {
  const event = (await store.listEventsForTask(taskId)).find((e) => e.kind === 'curation_proposed');
  return event ? (event.payload as CurationProposedPayload) : null;
}

describe('reconcileMilestoneClosed', () => {
  test('emits one curation_proposed per task with findings, keeping only the four curation types', async () => {
    await store.createMilestone({ id: 'm1', title: 'M1' });
    await store.createTask({ id: 'task-a', title: 'A', milestoneId: 'm1' });

    const runDir = await linkRunDir('task-a', 'a');
    writeLogEntry(runDir, 'd1', 'decision');
    writeLogEntry(runDir, 'h1', 'hack');
    writeLogEntry(runDir, 'r1', 'risk');
    writeLogEntry(runDir, 'as1', 'assumption');
    // Non-curation entries must be excluded from candidates.
    writeLogEntry(runDir, 'disc1', 'discovery');
    writeLogEntry(runDir, 'syn1', 'synthesis');
    writeLogEntry(runDir, 'bail1', 'bailout');

    const result = await reconcileMilestoneClosed('m1', store);

    expect(result.emitted).toEqual([{ taskId: 'task-a', candidateCount: 4 }]);
    const payload = await curationPayload('task-a');
    expect(payload?.milestone_id).toBe('m1');
    expect(payload?.candidates.map((c) => c.type).sort()).toEqual([
      'assumption',
      'decision',
      'hack',
      'risk',
    ]);
    expect(
      payload?.candidates.every((c) => c.run_path === join('.prove', 'runs', 'feat', 'a')),
    ).toBe(true);
  });

  test('no-op for a task whose runs carry no curation-relevant findings', async () => {
    await store.createMilestone({ id: 'm2', title: 'M2' });
    await store.createTask({ id: 'task-clean', title: 'Clean', milestoneId: 'm2' });
    const runDir = await linkRunDir('task-clean', 'clean');
    writeLogEntry(runDir, 'disc', 'discovery');
    writeLogEntry(runDir, 'syn', 'synthesis');

    const result = await reconcileMilestoneClosed('m2', store);

    expect(result.emitted).toHaveLength(0);
    expect(result.skippedNoFindings).toBe(1);
    expect(await curationPayload('task-clean')).toBeNull();
  });

  test('no-op for a task with no linked runs at all', async () => {
    await store.createMilestone({ id: 'm3', title: 'M3' });
    await store.createTask({ id: 'task-norun', title: 'NoRun', milestoneId: 'm3' });

    const result = await reconcileMilestoneClosed('m3', store);
    expect(result.emitted).toHaveLength(0);
    expect(result.skippedNoFindings).toBe(1);
  });

  test('idempotent: a second close does not re-emit and reports already-emitted', async () => {
    await store.createMilestone({ id: 'm4', title: 'M4' });
    await store.createTask({ id: 'task-i', title: 'I', milestoneId: 'm4' });
    const runDir = await linkRunDir('task-i', 'i');
    writeLogEntry(runDir, 'h', 'hack');

    const first = await reconcileMilestoneClosed('m4', store);
    expect(first.emitted).toHaveLength(1);

    const second = await reconcileMilestoneClosed('m4', store);
    expect(second.emitted).toHaveLength(0);
    expect(second.skippedAlreadyEmitted).toBe(1);

    const count = (await store.listEventsForTask('task-i')).filter(
      (e) => e.kind === 'curation_proposed',
    ).length;
    expect(count).toBe(1);
  });

  test('aggregates and dedupes candidates across multiple linked runs', async () => {
    await store.createMilestone({ id: 'm5', title: 'M5' });
    await store.createTask({ id: 'task-multi', title: 'Multi', milestoneId: 'm5' });
    const run1 = await linkRunDir('task-multi', 'one');
    const run2 = await linkRunDir('task-multi', 'two');
    writeLogEntry(run1, 'h-one', 'hack');
    writeLogEntry(run2, 'r-two', 'risk');
    // Same entry id surfacing through both runs is collapsed to one candidate.
    writeLogEntry(run1, 'dup', 'decision');
    writeLogEntry(run2, 'dup', 'decision');

    const result = await reconcileMilestoneClosed('m5', store);
    expect(result.emitted[0]?.candidateCount).toBe(3);
    const ids = (await curationPayload('task-multi'))?.candidates.map((c) => c.entry_id).sort();
    expect(ids).toEqual(['dup', 'h-one', 'r-two']);
  });

  test('emits per-task: only milestone members with findings get an event', async () => {
    await store.createMilestone({ id: 'm6', title: 'M6' });
    await store.createTask({ id: 'm6-a', title: 'A', milestoneId: 'm6' });
    await store.createTask({ id: 'm6-b', title: 'B', milestoneId: 'm6' });
    // A task in a different milestone must be untouched.
    await store.createMilestone({ id: 'other', title: 'Other' });
    await store.createTask({ id: 'other-a', title: 'Other A', milestoneId: 'other' });

    writeLogEntry(await linkRunDir('m6-a', 'a6'), 'h', 'hack');
    writeLogEntry(await linkRunDir('other-a', 'oa'), 'h', 'hack');

    const result = await reconcileMilestoneClosed('m6', store);
    expect(result.emitted.map((e) => e.taskId)).toEqual(['m6-a']);
    expect(result.skippedNoFindings).toBe(1); // m6-b
    expect(await curationPayload('other-a')).toBeNull();
  });

  test('skips a malformed log dir without aborting the milestone curation', async () => {
    await store.createMilestone({ id: 'm7', title: 'M7' });
    await store.createTask({ id: 'm7-bad', title: 'Bad', milestoneId: 'm7' });
    await store.createTask({ id: 'm7-ok', title: 'Ok', milestoneId: 'm7' });

    const badDir = await linkRunDir('m7-bad', 'bad');
    mkdirSync(join(badDir, 'log', 'engineer'), { recursive: true });
    writeFileSync(join(badDir, 'log', 'engineer', 'broken.json'), '{ not json');

    writeLogEntry(await linkRunDir('m7-ok', 'ok'), 'h', 'hack');

    const result = await reconcileMilestoneClosed('m7', store);
    // The corrupt run contributes nothing; the good task still curates.
    expect(result.emitted.map((e) => e.taskId)).toEqual(['m7-ok']);
    expect(result.skippedNoFindings).toBe(1); // m7-bad yielded zero candidates
  });
});

// ===========================================================================
// reconcileMilestoneClosed — milestone-close journal compaction (v22)
//
// On a milestone close, the milestone journal is rolled up into one Lore summary
// per team TERMINATING on that milestone. These tests create the terminating team
// WITHOUT a seated tech_lead, mirroring the real flow where closeMilestone vacates
// the roster before reconcile runs — so the engine-authored compaction Lore lands
// via recordLore's warn-allow (no-tech_lead) branch.
// ===========================================================================

describe('reconcileMilestoneClosed — journal compaction', () => {
  test('rolls the journal into one Lore per terminating team', async () => {
    await store.createMilestone({ id: 'm1', title: 'M1' });
    await store.createTeam({
      slug: 'squad',
      teamType: 'enabling',
      lifetime: 'terminates_on_milestone',
      terminatesOnMilestone: 'm1',
    });
    await store.createTask({ id: 'task-a', title: 'A', milestoneId: 'm1' });
    const runDir = await linkRunDir('task-a', 'a');
    writeLogEntry(runDir, 'h1', 'hack');
    writeLogEntry(runDir, 'r1', 'risk');

    const result = await reconcileMilestoneClosed('m1', store);

    expect(result.compactedTeams).toHaveLength(1);
    expect(result.compactedTeams[0]?.teamSlug).toBe('squad');
    expect(result.compactedTeams[0]?.candidateCount).toBe(2);

    const lores = await store.listLores('squad');
    expect(lores).toHaveLength(1);
    // The summary opens with the idempotency marker and folds in each finding.
    expect(lores[0]?.body).toContain('[milestone-close-summary:m1]');
    expect(lores[0]?.body).toContain('[hack]');
    expect(lores[0]?.body).toContain('[risk]');
  });

  test('no terminating team is a no-op (per-task curation unchanged)', async () => {
    await store.createMilestone({ id: 'm2', title: 'M2' });
    // A persistent team and a team pinned to a DIFFERENT milestone — neither terminates here.
    await store.createTeam({ slug: 'core', teamType: 'platform' });
    await store.createTeam({
      slug: 'elsewhere',
      teamType: 'enabling',
      lifetime: 'terminates_on_milestone',
      terminatesOnMilestone: 'other',
    });
    await store.createTask({ id: 'task-b', title: 'B', milestoneId: 'm2' });
    writeLogEntry(await linkRunDir('task-b', 'b'), 'h1', 'hack');

    const result = await reconcileMilestoneClosed('m2', store);

    // No compaction; the per-task curation still fired.
    expect(result.compactedTeams).toHaveLength(0);
    expect(result.emitted.map((e) => e.taskId)).toEqual(['task-b']);
    expect(await store.listLores('core')).toHaveLength(0);
    expect(await store.listLores('elsewhere')).toHaveLength(0);
  });

  test('idempotent: a re-close does not double-write the compaction Lore', async () => {
    await store.createMilestone({ id: 'm3', title: 'M3' });
    await store.createTeam({
      slug: 'squad',
      teamType: 'enabling',
      lifetime: 'terminates_on_milestone',
      terminatesOnMilestone: 'm3',
    });
    await store.createTask({ id: 'task-c', title: 'C', milestoneId: 'm3' });
    writeLogEntry(await linkRunDir('task-c', 'c'), 'h1', 'hack');

    const first = await reconcileMilestoneClosed('m3', store);
    expect(first.compactedTeams).toHaveLength(1);

    const second = await reconcileMilestoneClosed('m3', store);
    expect(second.compactedTeams).toHaveLength(0);
    expect(second.skippedAlreadyCompacted).toBe(1);
    // Exactly one compaction Lore exists.
    expect(await store.listLores('squad')).toHaveLength(1);
  });

  test('an empty journal still records a compaction Lore for the terminating team', async () => {
    await store.createMilestone({ id: 'm4', title: 'M4' });
    await store.createTeam({
      slug: 'squad',
      teamType: 'enabling',
      lifetime: 'terminates_on_milestone',
      terminatesOnMilestone: 'm4',
    });
    // A task with only non-curation findings — the journal is empty.
    await store.createTask({ id: 'task-d', title: 'D', milestoneId: 'm4' });
    writeLogEntry(await linkRunDir('task-d', 'd'), 'disc', 'discovery');

    const result = await reconcileMilestoneClosed('m4', store);

    expect(result.compactedTeams).toHaveLength(1);
    const lores = await store.listLores('squad');
    expect(lores).toHaveLength(1);
    expect(lores[0]?.body).toContain('[milestone-close-summary:m4]');
    expect(lores[0]?.body).toContain('no curation-relevant findings');
  });

  test('two terminating teams each get the same milestone journal rolled up', async () => {
    await store.createMilestone({ id: 'm5', title: 'M5' });
    for (const slug of ['squad-a', 'squad-b']) {
      await store.createTeam({
        slug,
        teamType: 'enabling',
        lifetime: 'terminates_on_milestone',
        terminatesOnMilestone: 'm5',
      });
    }
    await store.createTask({ id: 'task-e', title: 'E', milestoneId: 'm5' });
    writeLogEntry(await linkRunDir('task-e', 'e'), 'd1', 'decision');

    const result = await reconcileMilestoneClosed('m5', store);

    expect(result.compactedTeams.map((c) => c.teamSlug).sort()).toEqual(['squad-a', 'squad-b']);
    expect((await store.listLores('squad-a'))[0]?.body).toContain('[decision]');
    expect((await store.listLores('squad-b'))[0]?.body).toContain('[decision]');
  });
});

// ---------------------------------------------------------------------------
// bubbleStaleEscalations — staleness auto-bubble (injected clock)
// ---------------------------------------------------------------------------

describe('bubbleStaleEscalations', () => {
  // A fixed evaluation instant. All escalations are seeded with a `created_at`
  // relative to this so the threshold is crossed deterministically — no wall
  // clock, no setTimeout.
  const NOW_MS = Date.parse('2026-06-02T00:00:00Z');
  const HOUR_MS = 60 * 60 * 1000;

  /** ISO timestamp `hours` before the fixed evaluation instant. */
  function hoursAgo(hours: number): string {
    return new Date(NOW_MS - hours * HOUR_MS).toISOString();
  }

  test('auto-bubbles an escalation older than the threshold one rung up and flips the original to auto_bubbled', async () => {
    const stale = await store.raiseEscalation({
      taskId: 't1',
      escalationType: 'blocked',
      summary: 'aged out, no receiver',
      createdAt: hoursAgo(STALENESS_THRESHOLD_HOURS + 1),
    });

    const result = await bubbleStaleEscalations(store, NOW_MS);

    expect(result.threshold_hours).toBe(STALENESS_THRESHOLD_HOURS);
    expect(result.inspected).toBe(1);
    expect(result.bubbled).toHaveLength(1);
    expect(result.bubbled[0]).toMatchObject({
      from_id: stale.id,
      task_id: 't1',
      from_layer: 'implementer',
      to_layer: 'engineer',
    });

    // The original flips to auto_bubbled with the marker + forward pointer.
    const closed = await store.getEscalation(stale.id);
    expect(closed?.state).toBe('auto_bubbled');
    expect(closed?.attributes?.auto_bubbled).toBe(true);
    expect(closed?.attributes?.linked_escalation).toBe(result.bubbled[0]?.to_id);

    // A fresh open row exists exactly one rung up, back-pointing at the original.
    const fresh = await store.getEscalation(req(result.bubbled[0]?.to_id));
    expect(fresh?.state).toBe('open');
    expect(fresh?.layer).toBe('engineer');
    expect(fresh?.walked_up_from).toBe(stale.id);
  });

  test('leaves an under-threshold escalation untouched', async () => {
    const fresh = await store.raiseEscalation({
      taskId: 't1',
      escalationType: 'ambiguous',
      summary: 'raised recently',
      createdAt: hoursAgo(STALENESS_THRESHOLD_HOURS - 1),
    });

    const result = await bubbleStaleEscalations(store, NOW_MS);

    expect(result.inspected).toBe(1);
    expect(result.bubbled).toHaveLength(0);
    expect((await store.getEscalation(fresh.id))?.state).toBe('open');
    expect((await store.getEscalation(fresh.id))?.attributes).toBeNull();
    // No successor row was appended.
    expect(await store.listOpenEscalationRows()).toHaveLength(1);
  });

  test('an escalation exactly at the threshold is not yet stale (strict greater-than)', async () => {
    const boundary = await store.raiseEscalation({
      taskId: 't1',
      escalationType: 'conflict',
      summary: 'right at the line',
      createdAt: hoursAgo(STALENESS_THRESHOLD_HOURS),
    });

    const result = await bubbleStaleEscalations(store, NOW_MS);

    expect(result.bubbled).toHaveLength(0);
    expect((await store.getEscalation(boundary.id))?.state).toBe('open');
  });

  test('reports a stale escalation already at the top of the chain (human) without mutating it', async () => {
    const atTop = await store.raiseEscalation({
      taskId: 't1',
      escalationType: 'blocked',
      summary: 'human-rung, aged',
      layer: 'human',
      createdAt: hoursAgo(STALENESS_THRESHOLD_HOURS + 100),
    });

    const result = await bubbleStaleEscalations(store, NOW_MS);

    expect(result.atTopOfChain).toBe(1);
    expect(result.bubbled).toHaveLength(0);
    // The human-rung row stays open and unmarked — nowhere higher to walk.
    expect((await store.getEscalation(atTop.id))?.state).toBe('open');
    expect((await store.getEscalation(atTop.id))?.attributes).toBeNull();
  });

  test('advances each stale escalation only one rung in a single pass (does not re-evaluate the fresh successor)', async () => {
    const stale = await store.raiseEscalation({
      taskId: 't1',
      escalationType: 'blocked',
      summary: 'aged out',
      createdAt: hoursAgo(STALENESS_THRESHOLD_HOURS + 48),
    });

    const result = await bubbleStaleEscalations(store, NOW_MS);

    // Exactly one bubble: the successor row is created with created_at = NOW_MS,
    // so it is not stale within the same pass and is not re-bubbled.
    expect(result.bubbled).toHaveLength(1);
    const fresh = await store.getEscalation(req(result.bubbled[0]?.to_id));
    expect(fresh?.layer).toBe('engineer');
    expect(fresh?.state).toBe('open');
    // The chain back-link is intact for a future pass to continue from.
    expect((await store.getEscalationChain(req(fresh?.id))).map((e) => e.layer)).toEqual([
      'implementer',
      'engineer',
    ]);
    void stale;
  });

  test('a custom threshold overrides the default staleness window', async () => {
    const aged = await store.raiseEscalation({
      taskId: 't1',
      escalationType: 'blocked',
      summary: 'three hours old',
      createdAt: hoursAgo(3),
    });

    // Default (24h) leaves it alone; a 2h threshold bubbles it.
    expect((await bubbleStaleEscalations(store, NOW_MS)).bubbled).toHaveLength(0);
    const result = await bubbleStaleEscalations(store, NOW_MS, 2);
    expect(result.threshold_hours).toBe(2);
    expect(result.bubbled).toHaveLength(1);
    expect((await store.getEscalation(aged.id))?.state).toBe('auto_bubbled');
  });

  test('surfaces a stale auto-bubble into next-ready ranking and alerts via the blocker_raised bridge', async () => {
    // The owning task must exist for the event-surface bridge to fire.
    await store.createTask({ id: 'ranked-task', title: 'Ranked', status: 'ready' });
    await store.createTask({ id: 'plain-task', title: 'Plain', status: 'ready' });
    await store.raiseEscalation({
      taskId: 'ranked-task',
      escalationType: 'blocked',
      summary: 'no receiver acted',
      createdAt: hoursAgo(STALENESS_THRESHOLD_HOURS + 5),
    });

    await bubbleStaleEscalations(store, NOW_MS);

    // Alerts surface: listOpenEscalations reads the blocker_raised event the
    // bubble emitted.
    const alertTaskIds = (await store.listOpenEscalations()).map((e) => e.task_id);
    expect(alertTaskIds).toContain('ranked-task');

    // Next-ready ranking: the escalated task carries a positive escalation_boost
    // and outranks the un-escalated peer.
    const ranked = await store.nextReady({ limit: 10, nowMs: NOW_MS });
    const escalated = ranked.find((r) => r.task.id === 'ranked-task');
    const plain = ranked.find((r) => r.task.id === 'plain-task');
    expect(escalated?.rationale.escalation_boost).toBeGreaterThan(0);
    expect(escalated?.rationale.escalation_type).toBe('blocked');
    expect(escalated?.score ?? 0).toBeGreaterThan(plain?.score ?? 0);
  });
});

// ---------------------------------------------------------------------------
// Trigger bindings — declared status-transition -> bound next-action (1.4)
// ---------------------------------------------------------------------------

describe('triggerBindingsForStatus', () => {
  const triggers: TriggerBinding[] = [
    { on: 'accepted', workflow: 'decompose', description: 'fire next layer' },
    { on: 'accepted', workflow: 'notify' },
    { on: 'ready', workflow: 'orchestrate' },
  ];

  test('returns every binding whose `on` matches the status', async () => {
    expect(triggerBindingsForStatus(triggers, 'accepted').map((t) => t.workflow)).toEqual([
      'decompose',
      'notify',
    ]);
  });

  test('returns [] when no binding fires for the status', async () => {
    expect(triggerBindingsForStatus(triggers, 'done')).toEqual([]);
    expect(triggerBindingsForStatus([], 'accepted')).toEqual([]);
  });
});

describe('computeBoundActions', () => {
  const triggers: TriggerBinding[] = [
    { on: 'accepted', workflow: 'decompose', description: 'fire next layer' },
    { on: 'ready', workflow: 'orchestrate' },
  ];

  test('surfaces one bound action per task sitting in a triggering status', async () => {
    await store.createTask({ id: 'a1', title: 'Accepted one', status: 'accepted' });
    await store.createTask({ id: 'r1', title: 'Ready one', status: 'ready' });
    await store.createTask({ id: 'b1', title: 'Backlog one', status: 'backlog' });

    const actions = await computeBoundActions(store, triggers, 10);
    expect(actions).toEqual([
      {
        task_id: 'a1',
        title: 'Accepted one',
        status: 'accepted',
        workflow: 'decompose',
        description: 'fire next layer',
      },
      {
        task_id: 'r1',
        title: 'Ready one',
        status: 'ready',
        workflow: 'orchestrate',
        description: '',
      },
    ]);
  });

  test('an empty trigger table yields no actions', async () => {
    await store.createTask({ id: 'a1', title: 'Accepted', status: 'accepted' });
    expect(await computeBoundActions(store, [], 10)).toEqual([]);
  });

  test('honors the cap', async () => {
    await store.createTask({ id: 'a1', title: 'A1', status: 'accepted' });
    await store.createTask({ id: 'a2', title: 'A2', status: 'accepted' });
    await store.createTask({ id: 'a3', title: 'A3', status: 'accepted' });
    expect(await computeBoundActions(store, triggers, 2)).toHaveLength(2);
  });
});

describe('parseTeamAgentName', () => {
  test('parses a simple team-role seat', async () => {
    expect(parseTeamAgentName('team-auth-engineer')).toEqual({
      slug: 'auth',
      role: 'engineer',
    });
  });

  test('anchors on the role suffix so a hyphenated slug survives', async () => {
    expect(parseTeamAgentName('team-data-platform-tech_lead')).toEqual({
      slug: 'data-platform',
      role: 'tech_lead',
    });
  });

  test('returns null for a non-team agent name', async () => {
    expect(parseTeamAgentName('general-purpose')).toBeNull();
    expect(parseTeamAgentName('task-planner')).toBeNull();
  });

  test('returns null when the name has the prefix but no role suffix', async () => {
    expect(parseTeamAgentName('team-auth')).toBeNull();
  });

  test('returns null when the slug is empty', async () => {
    expect(parseTeamAgentName('team-engineer')).toBeNull();
  });
});

describe('detectContributionMiss', () => {
  const WINDOW_START = '2024-01-01T00:00:00.000Z';
  const WINDOW_END = '2024-01-01T01:00:00.000Z';

  test('in-window contribution from the seat is not a miss', async () => {
    await store.createTask({ id: 'team-task-1', title: 'Work' });
    await store.appendEvent({
      taskId: 'team-task-1',
      kind: 'note',
      agent: 'team-auth-engineer',
      ts: '2024-01-01T00:30:00.000Z',
      payload: { text: 'did the work' },
    });

    const result = await detectContributionMiss(
      store,
      'team-auth-engineer',
      'team-task-1',
      WINDOW_START,
      WINDOW_END,
    );
    expect(result).toEqual({
      isTeamRoleAgent: true,
      missed: false,
      role: 'engineer',
      slug: 'auth',
    });
  });

  test('seat with no in-window event is a miss', async () => {
    await store.createTask({ id: 'team-task-2', title: 'Work' });

    const result = await detectContributionMiss(
      store,
      'team-auth-engineer',
      'team-task-2',
      WINDOW_START,
      WINDOW_END,
    );
    expect(result).toEqual({
      isTeamRoleAgent: true,
      missed: true,
      role: 'engineer',
      slug: 'auth',
    });
  });

  test('a non-team agent is a no-op (isTeamRoleAgent false, not missed)', async () => {
    await store.createTask({ id: 'team-task-3', title: 'Work' });

    const result = await detectContributionMiss(
      store,
      'general-purpose',
      'team-task-3',
      WINDOW_START,
      WINDOW_END,
    );
    expect(result).toEqual({ isTeamRoleAgent: false, missed: false });
  });

  test('window is half-open: the end instant is out of window, the start instant is in', async () => {
    await store.createTask({ id: 'team-task-4', title: 'Work' });
    // Stamped exactly at the end instant — excluded by the half-open `[start, end)`.
    await store.appendEvent({
      taskId: 'team-task-4',
      kind: 'note',
      agent: 'team-auth-engineer',
      ts: WINDOW_END,
      payload: { text: 'too late' },
    });

    const atEnd = await detectContributionMiss(
      store,
      'team-auth-engineer',
      'team-task-4',
      WINDOW_START,
      WINDOW_END,
    );
    expect(atEnd.missed).toBe(true);

    // Stamped exactly at the start instant — included.
    await store.appendEvent({
      taskId: 'team-task-4',
      kind: 'note',
      agent: 'team-auth-engineer',
      ts: WINDOW_START,
      payload: { text: 'right on time' },
    });
    const atStart = await detectContributionMiss(
      store,
      'team-auth-engineer',
      'team-task-4',
      WINDOW_START,
      WINDOW_END,
    );
    expect(atStart.missed).toBe(false);
  });

  test("an event stamped by a different seat does not count as this seat's contribution", async () => {
    await store.createTask({ id: 'team-task-5', title: 'Work' });
    await store.appendEvent({
      taskId: 'team-task-5',
      kind: 'note',
      agent: 'team-auth-tech_lead',
      ts: '2024-01-01T00:30:00.000Z',
      payload: { text: 'lead stamped it' },
    });

    const result = await detectContributionMiss(
      store,
      'team-auth-engineer',
      'team-task-5',
      WINDOW_START,
      WINDOW_END,
    );
    expect(result.missed).toBe(true);
  });

  test('a vacant-slot dispatch is still evaluated — never short-circuited to no-miss', async () => {
    // No team is created and no holder is ever seated for the role; the detector
    // reads presence off the event log alone, so a seat name with zero in-window
    // contributions is still a miss rather than an auto-pass.
    await store.createTask({ id: 'team-task-6', title: 'Work' });

    const result = await detectContributionMiss(
      store,
      'team-vacant-implementer',
      'team-task-6',
      WINDOW_START,
      WINDOW_END,
    );
    expect(result).toEqual({
      isTeamRoleAgent: true,
      missed: true,
      role: 'implementer',
      slug: 'vacant',
    });
  });
});

// ---------------------------------------------------------------------------
// detectMergeAnomalies — post-pull anomaly surfacing (detection-only)
// ---------------------------------------------------------------------------

/** A watermark before every event timestamp in these tests (scan-all). */
const SINCE_EPOCH = '1970-01-01T00:00:00.000Z';

/** Group surfaced anomalies by kind for compact per-source assertions. */
function byKind(anomalies: SurfacedAnomaly[]): Record<string, SurfacedAnomaly[]> {
  const out: Record<string, SurfacedAnomaly[]> = {};
  for (const a of anomalies) {
    const bucket = out[a.kind] ?? [];
    bucket.push(a);
    out[a.kind] = bucket;
  }
  return out;
}

describe('detectMergeAnomalies — collisions drain', () => {
  test('each surfaced sync collision becomes a collision anomaly', async () => {
    const collisions: CollisionLike[] = [
      { table: 'scrum_contributors', key: { slug: 'jane' }, skipped: { id: 'ct-x', slug: 'jane' } },
      {
        table: 'scrum_acceptance_criteria',
        key: { task_id: 't1', criterion_id: 'c1' },
        skipped: { task_id: 't1', criterion_id: 'c1' },
      },
    ];
    const result = await detectMergeAnomalies(store, collisions, SINCE_EPOCH);
    expect(result.collisions).toHaveLength(2);
    expect(result.collisions.every((a) => a.kind === 'collision')).toBe(true);
    expect(result.collisions[0]?.summary).toContain('slug=jane');
    expect(result.collisions[1]?.summary).toContain('task_id=t1, criterion_id=c1');
    // No other source fired on a clean store.
    expect(result.all).toHaveLength(2);
  });

  test('an empty collision list surfaces no collision anomalies', async () => {
    const result = await detectMergeAnomalies(store, [], SINCE_EPOCH);
    expect(result.collisions).toHaveLength(0);
    expect(result.all).toHaveLength(0);
  });
});

describe('detectMergeAnomalies — LWW intent-loss across head columns', () => {
  test('concurrent cross-writer status writes surface (status column)', async () => {
    await store.createTask({ id: 'lww-1', title: 'Contended' });
    // Two DISTINCT authors each move status since the watermark: the head folded
    // to one winner, the other intent survives only in the log.
    await store.appendEvent({
      taskId: 'lww-1',
      kind: 'status_changed',
      agent: 'ct-alice',
      payload: { from: 'backlog', to: 'done' },
    });
    await store.appendEvent({
      taskId: 'lww-1',
      kind: 'status_changed',
      agent: 'ct-bob',
      payload: { from: 'backlog', to: 'blocked' },
    });

    const result = await detectMergeAnomalies(store, [], SINCE_EPOCH);
    expect(result.intent_loss).toHaveLength(1);
    const anomaly = result.intent_loss[0] as SurfacedAnomaly;
    expect(anomaly.kind).toBe('intent_loss');
    expect(anomaly.subject).toBe('lww-1');
    expect(anomaly.summary).toContain('ct-alice');
    expect(anomaly.summary).toContain('ct-bob');
    expect(anomaly.summary).toContain('status=');
  });

  test('covers milestone, team, and deleted head columns — not just status', async () => {
    await store.createMilestone({ id: 'm-1', title: 'M1' });
    await store.createMilestone({ id: 'm-2', title: 'M2' });
    await store.createTeam({ slug: 'alpha', teamType: 'stream_aligned' });
    await store.createTeam({ slug: 'beta', teamType: 'platform' });
    await store.createTask({ id: 'lww-ms', title: 'Milestone contend' });
    await store.createTask({ id: 'lww-tm', title: 'Team contend' });
    await store.createTask({ id: 'lww-del', title: 'Delete contend' });

    // milestone_id column: two writers.
    await store.appendEvent({
      taskId: 'lww-ms',
      kind: 'milestone_changed',
      agent: 'ct-alice',
      payload: { from: null, to: 'm-1' },
    });
    await store.appendEvent({
      taskId: 'lww-ms',
      kind: 'milestone_changed',
      agent: 'ct-bob',
      payload: { from: null, to: 'm-2' },
    });
    // team_slug column: two writers.
    await store.appendEvent({
      taskId: 'lww-tm',
      kind: 'team_changed',
      agent: 'ct-alice',
      payload: { from: null, to: 'alpha' },
    });
    await store.appendEvent({
      taskId: 'lww-tm',
      kind: 'team_changed',
      agent: 'ct-bob',
      payload: { from: null, to: 'beta' },
    });
    // deleted_at column rides task_deleted: two writers.
    await store.appendEvent({ taskId: 'lww-del', kind: 'task_deleted', agent: 'ct-alice' });
    await store.appendEvent({ taskId: 'lww-del', kind: 'task_deleted', agent: 'ct-bob' });

    const result = await detectMergeAnomalies(store, [], SINCE_EPOCH);
    const subjects = result.intent_loss.map((a) => a.subject).sort();
    expect(subjects).toEqual(['lww-del', 'lww-ms', 'lww-tm']);
    const columns = result.intent_loss.map(
      (a) => (a.summary.match(/ (status|milestone_id|team_slug|deleted_at)=/) ?? [])[1],
    );
    expect(columns.sort()).toEqual(['deleted_at', 'milestone_id', 'team_slug']);
  });

  test('a single author re-writing its own column is NOT an anomaly', async () => {
    await store.createTask({ id: 'lww-solo', title: 'Solo writer' });
    await store.appendEvent({
      taskId: 'lww-solo',
      kind: 'status_changed',
      agent: 'ct-alice',
      payload: { from: 'backlog', to: 'ready' },
    });
    await store.appendEvent({
      taskId: 'lww-solo',
      kind: 'status_changed',
      agent: 'ct-alice',
      payload: { from: 'ready', to: 'in_progress' },
    });
    const result = await detectMergeAnomalies(store, [], SINCE_EPOCH);
    expect(result.intent_loss).toHaveLength(0);
  });

  test('"since last sync" watermark excludes pre-watermark concurrent writes', async () => {
    await store.createTask({ id: 'lww-old', title: 'Pre-sync contend' });
    // Both concurrent writes landed BEFORE the watermark — already reconciled in
    // a prior sync, so they must NOT re-surface.
    await store.appendEvent({
      taskId: 'lww-old',
      kind: 'status_changed',
      agent: 'ct-alice',
      ts: '2020-01-01T00:00:00.000Z',
      payload: { from: 'backlog', to: 'done' },
    });
    await store.appendEvent({
      taskId: 'lww-old',
      kind: 'status_changed',
      agent: 'ct-bob',
      ts: '2020-01-01T00:00:01.000Z',
      payload: { from: 'backlog', to: 'blocked' },
    });

    const watermark = '2021-01-01T00:00:00.000Z';
    const result = await detectMergeAnomalies(store, [], watermark);
    expect(result.intent_loss).toHaveLength(0);

    // The same fixture scanned from the epoch DOES surface — proves the
    // watermark, not the events, is what suppressed it above.
    const scanAll = await detectMergeAnomalies(store, [], SINCE_EPOCH);
    expect(scanAll.intent_loss).toHaveLength(1);
  });

  test('a null author counts as a distinct unattributed writer', async () => {
    await store.createTask({ id: 'lww-null', title: 'Null author' });
    await store.appendEvent({
      taskId: 'lww-null',
      kind: 'status_changed',
      agent: 'ct-alice',
      payload: { from: 'backlog', to: 'done' },
    });
    await store.appendEvent({
      taskId: 'lww-null',
      kind: 'status_changed',
      agent: null,
      payload: { from: 'backlog', to: 'blocked' },
    });
    const result = await detectMergeAnomalies(store, [], SINCE_EPOCH);
    expect(result.intent_loss).toHaveLength(1);
    expect(result.intent_loss[0]?.summary).toContain('<unattributed>');
  });
});

describe('detectMergeAnomalies — cross-row invariants (C2/C3)', () => {
  test('cross-team write-scope overlap surfaces', async () => {
    await store.createTeam({ slug: 'alpha', teamType: 'stream_aligned' });
    await store.createTeam({ slug: 'beta', teamType: 'platform' });
    await store.setTeamScopes('alpha', { read: [], write: ['src/auth/**'] });
    // beta's write set overlaps alpha's — but setTeamScopes rejects an overlap at
    // write time, so simulate the MERGED post-pull state by inserting the
    // conflicting scope row directly (what a concurrent offline scope-add lands).
    const raw = store.getStore();
    await raw.run('INSERT INTO scrum_team_scopes (team_slug, kind, glob) VALUES (?, ?, ?)', [
      'beta',
      'write',
      'src/auth/login.ts',
    ]);

    const result = await detectMergeAnomalies(store, [], SINCE_EPOCH);
    expect(result.scope_overlap).toHaveLength(1);
    const anomaly = result.scope_overlap[0] as SurfacedAnomaly;
    expect(anomaly.kind).toBe('scope_overlap');
    expect(anomaly.summary).toContain('alpha');
    expect(anomaly.summary).toContain('beta');
  });

  test('a dependency cycle formed by the merged edge set surfaces', async () => {
    await store.createTask({ id: 'dep-a', title: 'A' });
    await store.createTask({ id: 'dep-b', title: 'B' });
    await store.createTask({ id: 'dep-c', title: 'C' });
    // a blocks b, b blocks c, c blocks a — a cycle each edge alone did not form.
    await store.addDep('dep-a', 'dep-b', 'blocks');
    await store.addDep('dep-b', 'dep-c', 'blocks');
    await store.addDep('dep-c', 'dep-a', 'blocks');

    const result = await detectMergeAnomalies(store, [], SINCE_EPOCH);
    expect(result.graph_cycle.map((a) => a.subject).sort()).toEqual(['dep-a', 'dep-b', 'dep-c']);
    expect(result.graph_cycle.every((a) => a.kind === 'graph_cycle')).toBe(true);
  });

  test('a parent_id containment cycle surfaces', async () => {
    await store.createTask({ id: 'par-a', title: 'A' });
    await store.createTask({ id: 'par-b', title: 'B' });
    // Form a parent_id cycle directly (createTask would reject a self/forward
    // parent), simulating the merged state of two concurrent re-parents.
    const raw = store.getStore();
    await raw.run('UPDATE scrum_tasks SET parent_id = ? WHERE id = ?', ['par-b', 'par-a']);
    await raw.run('UPDATE scrum_tasks SET parent_id = ? WHERE id = ?', ['par-a', 'par-b']);

    const result = await detectMergeAnomalies(store, [], SINCE_EPOCH);
    expect(result.graph_cycle.map((a) => a.subject).sort()).toEqual(['par-a', 'par-b']);
  });

  test('an acyclic graph surfaces no cycle anomaly', async () => {
    await store.createTask({ id: 'lin-a', title: 'A' });
    await store.createTask({ id: 'lin-b', title: 'B' });
    await store.createTask({ id: 'lin-c', title: 'C' });
    await store.addDep('lin-a', 'lin-b', 'blocks');
    await store.addDep('lin-b', 'lin-c', 'blocks');
    const result = await detectMergeAnomalies(store, [], SINCE_EPOCH);
    expect(result.graph_cycle).toHaveLength(0);
  });

  test('residual dual-open operator + team-role intervals surface (advisory)', async () => {
    const jane = await store.registerContributor({ slug: 'jane' });
    const john = await store.registerContributor({ slug: 'john' });
    // One clean open operator interval first, then a SECOND open row appended
    // without closing the first — the residual dual-open a concurrent transfer
    // rebase leaves.
    await store.setOperatorOfRecord({ contributorId: jane.id });
    const raw = store.getStore();
    await raw.run(
      'INSERT INTO scrum_operator_history (id, contributor_id, from_ts, to_ts, created_at, created_by) VALUES (?, ?, ?, NULL, ?, ?)',
      ['op-extra', john.id, '2026-06-14T00:00:00.000Z', '2026-06-14T00:00:00.000Z', 'ct-bob'],
    );
    // A team role slot with two open intervals.
    await store.createTeam({ slug: 'alpha', teamType: 'stream_aligned' });
    await store.rotateTeamMember({ teamSlug: 'alpha', role: 'engineer', contributorId: jane.id });
    await raw.run(
      'INSERT INTO scrum_team_members (id, team_slug, role, contributor_id, from_ts, to_ts, reason, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)',
      [
        'tm-extra',
        'alpha',
        'engineer',
        john.id,
        '2026-06-14T00:00:00.000Z',
        null,
        '2026-06-14T00:00:00.000Z',
      ],
    );

    const result = await detectMergeAnomalies(store, [], SINCE_EPOCH);
    const scopes = result.dual_open_interval.map((a) => a.subject).sort();
    expect(scopes).toEqual(['alpha/engineer', 'operator']);
    expect(result.dual_open_interval.every((a) => a.kind === 'dual_open_interval')).toBe(true);
  });
});

describe('detectMergeAnomalies — zero-writes invariant', () => {
  /** A content fingerprint of every table the anomaly pass reads or could touch. */
  async function snapshot(): Promise<string> {
    const raw = store.getStore();
    const tables = [
      'scrum_tasks',
      'scrum_events',
      'scrum_deps',
      'scrum_milestones',
      'scrum_teams',
      'scrum_team_scopes',
      'scrum_team_members',
      'scrum_operator_history',
      'scrum_contributors',
      'scrum_acceptance_criteria',
    ];
    const parts: string[] = [];
    for (const table of tables) {
      const rows = await raw.all<Record<string, unknown>>(`SELECT * FROM ${table} ORDER BY rowid`);
      parts.push(`${table}=${JSON.stringify(rows)}`);
    }
    return parts.join('\n');
  }

  test('the pass performs ZERO writes — every read table is byte-identical after', async () => {
    // Seed a store that fires EVERY anomaly source so the pass exercises all of
    // its read paths against real rows.
    await store.createTask({ id: 'z-1', title: 'Contended' });
    await store.appendEvent({
      taskId: 'z-1',
      kind: 'status_changed',
      agent: 'ct-alice',
      payload: { from: 'backlog', to: 'done' },
    });
    await store.appendEvent({
      taskId: 'z-1',
      kind: 'status_changed',
      agent: 'ct-bob',
      payload: { from: 'backlog', to: 'blocked' },
    });
    await store.createTask({ id: 'z-a', title: 'A' });
    await store.createTask({ id: 'z-b', title: 'B' });
    await store.addDep('z-a', 'z-b', 'blocks');
    await store.addDep('z-b', 'z-a', 'blocks');

    const collisions: CollisionLike[] = [
      { table: 'scrum_contributors', key: { slug: 'dup' }, skipped: { id: 'ct-z', slug: 'dup' } },
    ];

    const before = await snapshot();
    const result = await detectMergeAnomalies(store, collisions, SINCE_EPOCH);
    const after = await snapshot();

    // The pass surfaced real anomalies AND wrote nothing.
    const grouped = byKind(result.all);
    expect(grouped.collision).toHaveLength(1);
    expect(grouped.intent_loss).toHaveLength(1);
    expect(grouped.graph_cycle?.length ?? 0).toBeGreaterThan(0);
    expect(after).toBe(before);
  });
});
